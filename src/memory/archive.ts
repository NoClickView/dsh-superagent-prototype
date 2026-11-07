/**
 * The bounded archive: what the memory files take, how much of the budget must stay free for the store's own commit, and which
 * originals a full store may drop. Reclamation is a decision over storage pressure, never over forgetting: the thresholds in
 * `score.ts` decide what routine recall shows and delete nothing, while this file ranks the original material that is worth less
 * than the space it takes. The ranking is one continuous number under a versioned policy, so two runs of the same store, the same
 * clock and the same policy evict the same material in the same order, and nothing here is ever a protected class: a record with
 * no shorter rendering to stand in for it orders last, and a store with nothing else to free still drops it.
 *
 * Nothing in this file reads a file, writes one, or knows a revision: `MemoryService` is the only writer, and the caller hands the
 * weights in through `weightOf` so that this module and recall can never disagree about how much one experience is worth.
 */
import type { MemoryRecord, MemoryUsage } from './model.ts'

/** The bytes one eviction op costs before its blob may be deleted: the journal line that disowns the original, and its envelope. */
const EVICTION_LINE_OVERHEAD = 96

/**
 * The versioned numeric policy reclamation runs under — the second half of the archive's decidable behaviour, beside the weight
 * policy that decides what a record is worth. A change to any number here is a new `version`, so an operator can read back under
 * which policy an original was dropped (`Representation.detail.evictedBy`) and why a store reclaimed when it did.
 */
export interface RetentionPolicy {
  readonly version: string
  /**
   * The two non-negative coefficients of the retention score. `standing` is how much an experience's long-term weight counts
   * toward keeping its original; `detail` is how much an original nothing shorter can stand in for counts. With the shipped
   * ratio, an experience whose gist a compression job committed is evicted before one of the same weight whose text is all that
   * is left of it — and the second is still evicted once nothing cheaper remains.
   */
  readonly weight: { readonly standing: number; readonly detail: number }
  /**
   * The share of the budget at which reclamation starts, and the share it stops at. `high` is where the store would otherwise be
   * one large capture away from refusing writes; `low` is the headroom one pass frees, so a pass that starts is not repeated for
   * every byte the next capture takes.
   */
  readonly water: { readonly high: number; readonly low: number }
  /** Bytes an original must take before dropping it is worth the line that has to be written first. */
  readonly minEvictBytes: number
  /** The most originals one pass may drop, so a full store costs bounded work rather than stalling the capture that found it. */
  readonly maxEvictions: number
}
/** Why a retention policy cannot be used: one of these, or none at all. */
export type RetentionProblem = 'negativeCoefficient' | 'noPositiveCoefficient' | 'waterOutOfRange' | 'crossedWater'
  | 'negativeMinEvict' | 'impossibleEvictions'

/**
 * The policy this build ships: keeping an original is worth three times what deleting it is worth, and an original with no gist
 * to stand in for it is worth one more share than one with, so reclamation takes the material a reader can still recall first.
 * The 90% high water is the point the store reports as pressurised and starts freeing; it stops at 75%, which leaves a capture of
 * ordinary size room without a second pass. These are the initial, validated choice rather than a measured optimum: the multi-year
 * replay reports on them, and a different pair is a new version.
 */
export const RETENTION: RetentionPolicy = { version: 'mem-retention-1',
  weight: { standing: 3, detail: 1 }, water: { high: 0.9, low: 0.75 }, minEvictBytes: 4096, maxEvictions: 8 }

/** Whether a value is a finite number a policy may be built from. */
const finite = (value: number): boolean => typeof value === 'number' && Number.isFinite(value)

/**
 * Every way `policy` cannot rank retention, in one list; empty for a policy this build may reclaim under. It is called once when
 * the service is built, so a configuration that would make reclamation a no-op or unbounded is a refusal to reclaim rather than a
 * store that quietly fills: a crossed water pair would evict nothing, and a policy with no positive coefficient would rank every
 * original equally and drop them in whatever order the filesystem listed them.
 */
export function retentionProblems(policy: RetentionPolicy): readonly RetentionProblem[] {
  const problems: RetentionProblem[] = []
  const { standing, detail } = policy.weight
  if (!finite(standing) || !finite(detail) || standing < 0 || detail < 0) problems.push('negativeCoefficient')
  else if (standing + detail <= 0) problems.push('noPositiveCoefficient')
  const { high, low } = policy.water
  if (!finite(high) || !finite(low) || high <= 0 || high > 1 || low <= 0 || low > 1) problems.push('waterOutOfRange')
  else if (low >= high) problems.push('crossedWater')
  if (!finite(policy.minEvictBytes) || policy.minEvictBytes < 0) problems.push('negativeMinEvict')
  if (!Number.isSafeInteger(policy.maxEvictions) || policy.maxEvictions < 1) problems.push('impossibleEvictions')
  return problems
}

/**
 * How much keeping one original is worth, from 0 to 100: its long-term weight, and whether something shorter stands in for it.
 * A record whose gist a compression job committed keeps its cues and that gist after its text is gone, so it is worth less than
 * one of the same weight whose text is all that is left — and both are numbers on one scale rather than two classes, which is how
 * a store can always be brought back under its budget without a category that is never reclaimed.
 */
export function retentionOf(record: MemoryRecord, weightOf: (record: MemoryRecord) => number, policy: RetentionPolicy): number {
  const { standing, detail } = policy.weight, total = standing + detail
  if (total <= 0) return 0
  const weight = Number.isFinite(weightOf(record)) ? Math.min(100, Math.max(0, weightOf(record))) : 0
  const held = record.representation.summary === undefined ? 100 : 0
  return Math.min(100, Math.max(0, (weight * standing + held * detail) / total))
}

/** One original material a full store may drop: what it frees, what dropping it costs, and how much keeping it is worth. */
export interface EvictionCandidate {
  /** The experience whose retention decided this candidate, which is the one hardest to part with among those sharing it. */
  readonly id: string
  /**
   * Every experience whose readable original is this file. A blob is content addressed, so two experiences that quote the same
   * long text share one file: releasing one of them alone would free nothing, and deleting the file under the other would take an
   * original nobody chose to release. They are therefore one candidate, and reclamation releases them together or not at all.
   */
  readonly ids: readonly string[]
  /** The content-addressed blob holding the original text, which is the only material reclamation can free. */
  readonly blob: string
  /** Bytes the blob takes now, which are the bytes the store frees. */
  readonly bytes: number
  /** Bytes the journal lines that disown it take, which the store pays before the blob may be deleted. */
  readonly lineBytes: number
  /** `bytes - lineBytes`: what one eviction actually frees. A candidate that would free nothing is never one. */
  readonly gain: number
  /** How much keeping this original is worth, 0 to 100: the highest of the experiences sharing it, so none is released unearned. */
  readonly retention: number
  /** Whether a gist survives it for every experience sharing the file, which is what a reader still has after the text is gone. */
  readonly summarised: boolean
}
/** What a decision about originals is made from: the policy, and the one weight a record is worth at this instant. */
export interface EvictionRequest {
  readonly policy: RetentionPolicy
  readonly weightOf: (record: MemoryRecord) => number
}

/**
 * The originals a full store may drop, least worth keeping first, in one exact order: retention ascending, then the bytes freed
 * descending so a pass frees as much as it costs, then the blob so two runs over one version agree. Only material the store holds
 * as a blob is a candidate — inline text lives in the journal, which is append-only and bounded at capture instead — and an
 * original already disowned, or one whose lines cost as much as it frees, is not one: reclamation may never make the store fuller.
 * Records that share a file are one candidate, ordered by the hardest of them to part with, so a release never takes an original
 * away from an experience the policy did not rank.
 */
export function evictionCandidates(records: Iterable<MemoryRecord>, request: EvictionRequest): EvictionCandidate[] {
  const groups = new Map<string, MemoryRecord[]>()
  for (const record of records) {
    const material = record.experience.material
    if (material.form !== 'blob' || !record.representation.detail.available) continue
    const held = groups.get(material.blob)
    if (held === undefined) groups.set(material.blob, [record])
    else held.push(record)
  }
  const candidates: EvictionCandidate[] = []
  for (const [blob, group] of groups) {
    const material = group[0]!.experience.material
    if (material.form !== 'blob') continue
    const bytes = material.bytes
    const lineBytes = group.reduce((sum, record) => sum + Buffer.byteLength(JSON.stringify(record), 'utf8')
      + EVICTION_LINE_OVERHEAD, 0)
    const gain = bytes - lineBytes
    if (bytes < request.policy.minEvictBytes || gain <= 0) continue
    const retentions = group.map(record => retentionOf(record, request.weightOf, request.policy))
    const retention = Math.max(...retentions)
    const decided = group[retentions.indexOf(retention)]!
    candidates.push({ id: decided.experience.id, ids: group.map(record => record.experience.id).sort(), blob, bytes, lineBytes, gain,
      retention, summarised: group.every(record => record.representation.summary !== undefined) })
  }
  return candidates.sort((left, right) => left.retention - right.retention || right.gain - left.gain
    || left.blob.localeCompare(right.blob))
}

/** What storage pressure the store is under, which is the state health reports and reclamation starts from. */
export type CapacityState = 'ready' | 'overHighWater' | 'full'

/**
 * The journal line one capture may add at its largest, padded to whole blocks. An inline material is bounded by its own limit, and
 * a longer one goes to a blob whose op is small, so this is the room one more capture needs; reclamation has to leave it free or
 * the store reports `ready` while refusing every write.
 */
const CAPTURE_GROWTH = 4 * 4096

/**
 * The bytes content may use and still leave room for one more capture: the budget, less the reserve the store keeps for its own
 * commit, less one capture's largest line. It is the number the watermarks are shares of, so a store that crosses the high
 * watermark starts freeing while it can still write, and one that reaches the whole of it is full rather than merely large.
 */
export function usableBytes(budget: { readonly limit: number; readonly reserve: number }): number {
  return Math.max(1, budget.limit - budget.reserve - CAPTURE_GROWTH)
}

/**
 * Which of the three states the accounted usage puts the store in. The comparison is against the usable bytes rather than the
 * budget, because a watermark measured from the whole budget would sit above the point where a write is refused, and the report
 * would say `ready` about a store that has started to back-pressure: `full` here is where one more capture may no longer fit.
 */
export function capacityOf(usage: MemoryUsage, budget: { readonly limit: number; readonly reserve: number },
  policy: RetentionPolicy): CapacityState {
  const usable = usableBytes(budget)
  if (usage.total >= usable) return 'full'
  return usage.total >= usable * policy.water.high ? 'overHighWater' : 'ready'
}
