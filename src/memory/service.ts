/**
 * `MemoryService`, the one submit and read entry point of the long-term memory: it validates a capture, derives the record retrieval
 * will see, publishes it through the store's journal, and answers every query from the version it has published. Nothing else may
 * write — the file store is private to this class — which is what the spec's single-writer requirement means in code. Tickets 03,
 * 05, 06, 07, 08 and 09 extend it without changing this seam: 03 enforces the boundary at the OS level, 05/06 submit candidates, 07
 * puts the thresholds in force as candidacy and granularity, 08 replaces representations, 09 evicts detail.
 */
import { ExperienceInputSchema, experienceId, evictIdOf, opIdOf, rollbackIdOf, CAPTURE_MAX_CHARS, BLOB_HEAD_CHARS,
  type CompressionCandidate, type Confidence, type Experience, type ExperienceInput, type ExperienceKind, type Granularity, type Importance, type Material,
  type MemoryLimits, type MemoryPolicy, type MemoryRecord, type MemoryUsage, type PreviousRepresentation, type Representation,
  type RevisionState, type Scope, type ScoreCandidate, type Summary, type Supersession } from './model.ts'
import { capacityOf, evictionCandidates, retentionProblems, RETENTION, usableBytes, type CapacityState, type EvictionCandidate,
  type RetentionPolicy } from './archive.ts'
import { cuesOfMaterial, currentState, inScope, listScope, materialText, rank, recallBlock, strongEnough, topicOfMaterial,
  type ListRequest, type ListResult, type RecallRequest, type RecallResult } from './retrieval.ts'
import { claimOf, revisionsOf, revisionStates, stateOf } from './revision.ts'
import { granularityOf, importanceOf, MEMORY_POLICY, policyProblems, RATIONALE_MAX_CHARS, ruleScoreOf, UNCERTAIN_MAX,
  UNCERTAIN_MAX_CHARS, weightOf } from './score.ts'
import { summaryProblems } from './summary.ts'
import { MemoryStore, type MemoryStep } from './store.ts'

/** What the service needs to exist: where the files are, how large they may grow, the clock a checkpoint is stamped with, the numeric
 * policy it scores with, the retention policy reclamation runs under, and the decision whether this deployment may write at all. */
export interface MemoryHost {
  /** The memory root, `<stateDir>/memory` in the runtime. */
  readonly dir: string
  readonly limits: MemoryLimits
  readonly now: () => string
  /**
   * The deployment's answer to whether a write may run, read on every write so that closing the gate stops the next capture rather
   * than the next restart. A host that names none owns its files itself, as a test store under a temporary directory does: the
   * runtime always names one, because there the writer and an agent's shell share an account until a boundary is proven.
   */
  readonly gate?: () => WriteGate
  /** Open as a reader of the same files, serving the last complete version and writing nothing. Undefined opens the writer. */
  readonly readOnly?: boolean
  /** Die at a named point of the publication protocol; see `MemoryStep`. It is how the crash matrix is driven. */
  readonly interrupt?: (step: MemoryStep) => void
  /** The versioned policy importance, thresholds and the time term come from; the build's own when absent. */
  readonly policy?: MemoryPolicy
  /** The versioned policy reclamation ranks originals by; the build's own when absent. */
  readonly retention?: RetentionPolicy
}
/**
 * Whether long-term memory may be written, and why. A closed gate refuses every capture and says which condition failed, which is what
 * the spec's single-writer rule means on a deployment whose shells run as the same OS user as the memory service.
 */
export interface WriteGate {
  readonly open: boolean
  /** One sentence naming what the deployment proved, or what a shell could still reach. */
  readonly detail: string
}
/** What one submission did. Only `created` changed a file; a back-pressured one waits in the durable effect queue and is retried. */
export type SubmitResult =
  /**
   * Published in a new version. `revised` names the older experiences whose knowledge this fact replaced or disputed — the whole of
   * what a revision touches, so a caller re-consolidates those records rather than scanning the history.
   */
  | { readonly status: 'created'; readonly id: string; readonly version: number; readonly revised?: readonly string[] }
  /** The same experience was already published: nothing was written and the version did not move. */
  | { readonly status: 'duplicate'; readonly id: string; readonly version: number }
  /**
   * A refusal that names one reason and the version it was refused at. `stale` is the bare spelling of the same refusal `conflict`
   * below spells out, kept for the paths that refuse a candidate without naming the versions involved.
   */
  | { readonly status: 'rejected'; readonly reason: 'invalidInput' | 'idMismatch' | 'readOnly' | 'noIsolation' | 'unsupported' | 'stale'
    | 'unknown'; readonly version: number }
  /**
   * The submission was computed from a version a newer commit replaced. It is refused by name, naming both versions, and nothing
   * of it is applied; the caller recomputes from the material the current version holds.
   */
  | { readonly status: 'conflict'; readonly id: string; readonly baseVersion: number; readonly version: number }
  /** The store is full: the fact was not written and must be retried, never dropped or written anyway. */
  | { readonly status: 'backpressured'; readonly reason: 'capacity'; readonly usage: MemoryUsage }
/** What a caller may ask for beyond what recall showed: the whole original text, or the honest state of it. */
export interface ExpandRequest { readonly id: string; readonly allowanceChars: number }
export type ExpandResult =
  | { readonly status: 'available'; readonly id: string; readonly text: string; readonly chars: number; readonly truncated: boolean;
    /** Characters that were never stored, when the capture itself was truncated. */ readonly omittedChars: number
    /** The gist recall would show instead of this text, when a compression job committed one. */ readonly summary?: Summary }
  | { readonly status: 'evicted'; readonly id: string
    /** What is still known about it, which is all a reader may be told once the original is gone; nothing here is invented. */
    readonly summary?: Summary
    /** When reclamation released the text, and which retention policy it ran under: the limit of what is available, stated. */
    readonly evictedAt?: string
    readonly evictedBy?: string }
  | { readonly status: 'unknown'; readonly id: string }
/** What one operator rollback did: the version it produced, whether there was a step to take back, or why it could not. */
export type RollbackResult =
  | { readonly status: 'rolledBack'; readonly id: string; readonly version: number; readonly from: number }
  /** The representation kept no step back: nothing was rolled back, and the version did not move. */
  | { readonly status: 'none'; readonly id: string; readonly version: number }
  | { readonly status: 'unknown'; readonly id: string }
  /** The store serves reads only, so the rollback would not be durable and is refused rather than half applied. */
  | { readonly status: 'readOnly'; readonly id: string; readonly version: number }
  /**
   * The deployment proves no boundary that makes this the single writer, which refuses a rollback exactly as it refuses a capture:
   * one gate, one answer, whichever path a write takes.
   */
  | { readonly status: 'noIsolation'; readonly id: string; readonly version: number }
/** What one reclamation pass did: the state it found, what it freed, and how many originals it released. */
export interface ReclaimResult {
  /** The pressure the pass was decided under: `ready` means it wrote nothing at all. */
  readonly state: CapacityState
  /** Bytes freed, cache and versions and originals together. */
  readonly freed: number
  /** Originals this pass released, which is what its `maxEvictions` bounds. */
  readonly evicted: number
  /** The version the pass left behind, which is the version the next recall is answered from. */
  readonly version: number
}
/**
 * What the memory files take, what the store keeps back for its own commit, and what reclamation may still free. It is the
 * accounting the health entry and an operator read, reported beside the usage rather than folded into it: the six classes are
 * files, and the reserve is the part of the budget no file may take.
 */
export interface MemoryCapacity {
  readonly limit: number
  /** Bytes held back from content so the store can always write its own commit and recovery. */
  readonly reserve: number
  readonly state: CapacityState
  /** Bytes reclamation may free without dropping one original: rebuildable cache, versions nothing reads, interrupted scratch. */
  readonly reclaimable: number
  /** Originals the retention policy would drop now, and the bytes they would free after their own commits; none under no pressure. */
  readonly candidates: number
  readonly candidateBytes: number
  /** The share of the usable bytes reclamation starts at, and the share it stops at. */
  readonly highWater: number
  readonly lowWater: number
  /** The retention policy version reclamation ranks under and a released original records. */
  readonly retention: string
  /** What this store has freed since it opened, by class, which is what an operator reads a full store's history by. */
  readonly reclaimed: { readonly caches: number; readonly versions: number; readonly originals: number; readonly bytes: number }
}
/** The published version and the state of the store, which health and the management surface report. */
export interface MemoryStatus {
  readonly version: number
  readonly seq: number
  readonly experiences: number
  readonly writable: boolean
  readonly usage: MemoryUsage
  readonly limits: MemoryLimits
  readonly state: 'ready' | 'overHighWater' | 'full' | 'readOnly'
  readonly capacity: MemoryCapacity
  /** The policy version every weight is computed with, and every problem found in it when it cannot be used. */
  readonly policy: string
  readonly problems: readonly string[]
}

/** The gate of a memory whose host named none: that caller owns the files itself, as a test store under a temporary directory does. */
const OWNED: WriteGate = { open: true, detail: 'the caller owns this memory store' }
/**
 * The confidence each kind of experience supports on its own: what was observed ranks above what was asserted, and both above what
 * was inferred, because an inference is the one kind whose author is the memory's own reasoning rather than the world.
 */
const KIND_CONFIDENCE: Readonly<Record<ExperienceKind, number>> = { observation: 0.6, statement: 0.5, inference: 0.3 }
/** What one further independent Source adds, and where corroboration stops: evidence approaches certainty and never claims it. */
const CORROBORATION_STEP = 0.15, CONFIDENCE_MAX = 0.95
/**
 * The claim a record makes, as the words it states: two records corroborate each other only when they say the same thing, so a
 * related experience, a gist written from it and a question about it are all different claims.
 */
const claimKey = (record: MemoryRecord): string =>
  materialText(record.experience.material).normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase()
/** Whether two records state the same claim about the same project, which is the condition corroboration is counted under. */
const sameClaim = (left: MemoryRecord, right: MemoryRecord): boolean =>
  left.experience.scope.project === right.experience.scope.project && claimKey(left) === claimKey(right)

/**
 * One record as a re-evaluation sweep reads it: what its committed results were computed under, and nothing else. That is the whole of
 * what a version change needs to select the records it affects, so a sweep decides from the published version instead of reading the
 * texts again, and a runtime that changed no version owes no work at all.
 */
export interface ComputedUnder {
  readonly id: string
  /** The weight a scoring job committed, or absent when none ever did. */
  readonly importance?: { readonly principles: string; readonly policy: string; readonly model?: string }
  /** The gist a compression job committed, or absent when none ever did. */
  readonly summary?: { readonly version: string; readonly model?: string }
}
/** One bounded page of the records a sweep may have to re-evaluate, and the cursor the next page reads from. */
export interface ScanPage {
  readonly items: readonly ComputedUnder[]
  /** The cursor for the next page; absent when this page reached the end of the published version. */
  readonly next?: number
}

/**
 * The memory subsystem's single writer and reader of published versions. Every method is synchronous, like the repository layer it
 * sits beside: a commit is one journal write and its fsync, and a query is a pure read of the version in memory, so a caller cannot
 * observe a version that is not durable. Scoring is the second kind of commit: a candidate computed from a named version either
 * replaces the weight of one record in a new version, or changes nothing. Every commit path — a capture, a candidate a background job
 * computed, an operator's rollback and a reclamation pass — is gated by the deployment's own decision first, so a process whose shells
 * could edit the same files is not a single writer and says so instead of publishing, whichever door the write came through.
 */
export class MemoryService {
  private readonly policy: MemoryPolicy
  private readonly policyProblems: readonly string[]
  private readonly retention: RetentionPolicy
  private readonly retentionProblems: readonly string[]
  private readonly now: () => string
  private readonly gate: () => WriteGate
  private constructor(private readonly store: MemoryStore, private readonly limits: MemoryLimits, host: MemoryHost) {
    this.policy = host.policy ?? MEMORY_POLICY
    // A policy that cannot explain a score is refused here, once, rather than producing weights nobody can account for later.
    this.policyProblems = policyProblems(this.policy).map(problem => `policy ${this.policy.version}: ${problem}`)
    this.retention = host.retention ?? RETENTION
    // A retention policy that cannot rank is a store that fills without ever freeing, so it is refused where a score is.
    this.retentionProblems = retentionProblems(this.retention).map(problem => `retention ${this.retention.version}: ${problem}`)
    this.now = host.now
    this.gate = host.gate ?? (() => OWNED)
  }
  /** Open (or create) the memory of one root and recover its last complete version. Never throws: a broken store serves reads only. */
  static open(host: MemoryHost): MemoryService { return new MemoryService(MemoryStore.open(host), host.limits, host) }
  /** The version every read is answered from: a complete journal prefix, which a reader can identify and a later ticket can name. */
  get version(): number { return this.store.version }
  /**
   * Publish one captured experience. The id is re-derived from the capture's own fields, which makes a corrupted queue row unable to
   * poison the index; an input whose id is already held changes nothing, so a redelivery after a crash is a no-op rather than a
   * second experience.
   */
  submit(input: ExperienceInput): SubmitResult {
    const parsed = ExperienceInputSchema.safeParse(input)
    if (!parsed.success) return { status: 'rejected', reason: 'invalidInput', version: this.store.version }
    const valid = parsed.data
    if (valid.id !== experienceId(valid.origin.event, valid.origin.primary, valid.recordedAt) || valid.opId !== opIdOf(valid.id)) {
      return { status: 'rejected', reason: 'idMismatch', version: this.store.version }
    }
    // A redelivery of the same capture, or a payload that would rewrite what is already published. v1 never overwrites history: a
    // different representation of the same experience is a later revision's business (tickets 06/08), not a capture's. It is
    // answered before anything is written, so a redelivered large capture costs neither a blob nor a reclamation pass.
    if (this.store.record(valid.id)) return { status: 'duplicate', id: valid.id, version: this.store.version }
    if (!this.store.writable) return { status: 'rejected', reason: 'readOnly', version: this.store.version }
    // The deployment's own decision comes before the write, never after: without a boundary that keeps a shell out of these files,
    // there is no single writer to speak of, and the capture waits for an operator who can establish one or waive the requirement.
    if (!this.gate().open) return { status: 'rejected', reason: 'noIsolation', version: this.store.version }
    // A capture that arrives at a pressurised store frees room before it takes any, so the pass runs through this one writer and
    // the material below is judged against what the store holds after it rather than before.
    this.reclaim()
    const record = this.recordOf(valid)
    // What this fact does to what was already believed is decided from the records the version holds, before it is published: the
    // links travel with the record, so a reader derives the older claim's window from the same journal op that closed it.
    const links = revisionsOf(record, this.store.entries())
    const answered = this.commit(valid.opId, valid.recordedAt, links.length ? this.revised(record, links) : record, valid.id)
    if (answered.status !== 'created') return answered
    // The knowledge whose standing changed is named back to the caller, which is what re-consolidates exactly those records and no other.
    const revised = links.filter(edge => edge.kind !== 'earlier').map(edge => edge.experienceId)
    return revised.length ? { ...answered, revised } : answered
  }
  /**
   * Free space while the store is over its high watermark, and stop at the low one: first what is provably rebuildable — the
   * derived cache and the versions nothing reads — and only then the original material the retention policy ranks least worth
   * keeping. Every eviction is a commit through this class, so the version that disowns an original is fsynced before the blob is
   * deleted and a reader never sees a record pointing at text that is gone; a pass that finds nothing to free frees nothing and
   * says so, which is what back-pressures the next large capture rather than writing past the budget.
   */
  reclaim(): ReclaimResult {
    const budget = { limit: this.limits.budgetBytes, reserve: this.store.reserveBytes }, water = this.retention.water
    const usable = usableBytes(budget)
    // A pass writes versions like any other writer, so it runs only while this really is the single writer: a store whose gate is
    // shut frees nothing rather than committing an eviction nobody could defend.
    if (!this.store.writable || !this.gate().open || this.retentionProblems.length) {
      return { state: this.capacityState(), freed: 0, evicted: 0, version: this.store.version }
    }
    if (this.capacityState() === 'ready') return { state: 'ready', freed: 0, evicted: 0, version: this.store.version }
    // The cheap space first, and re-measured after it: a pass that a cache alone brings under the low water drops no original.
    let freed = this.store.reclaim()
    let evicted = 0
    // The candidates are ranked once, from the version this pass starts at; each commit below is a new version, so a record is
    // re-read before it is dropped rather than evicted from a state the pass no longer holds.
    for (const candidate of this.candidates()) {
      if (evicted >= this.retention.maxEvictions) break
      if (this.store.currentUsage.total <= usable * water.low) break
      if (!this.evict(candidate)) continue
      evicted += 1
      freed += candidate.gain
    }
    return { state: this.capacityState(), freed, evicted, version: this.store.version }
  }
  /**
   * Release one original: the commits that say its detail is unavailable, and then the blob itself. That order is the whole of
   * what makes the release safe — a crash between the two leaves an orphan the next open sweeps, and never a record claiming text
   * that is gone. Two experiences that quote the same long text share one file, so they are one candidate and are released
   * together: releasing one alone would free nothing and deleting the file under the other would take an original nobody chose.
   * What recall keeps is what the record keeps: its cues always, and the gist a compression job committed, which is never
   * presented as the text that was released.
   */
  private evict(candidate: EvictionCandidate): boolean {
    const at = this.now()
    for (const id of candidate.ids) {
      const record = this.store.record(id)
      if (!record || !record.representation.detail.available) continue
      const { detail } = record.representation
      const representation: Representation = { ...record.representation, revision: record.representation.revision + 1,
        detail: { available: false, bytes: detail.bytes, evictedAt: at, evictedBy: this.retention.version } }
      const { result } = this.store.commit(evictIdOf(id, this.store.version), at, this.carried({ ...record, representation }), true)
      // One commit the store could not take leaves the rest of the group readable: nothing is dropped, and the next pass retries.
      if (result.status === 'backpressured') return false
    }
    return this.store.dropBlob(candidate.blob)
  }
  /** The originals this store may drop now, least worth keeping first; empty when nothing is evictable. */
  private candidates(): readonly EvictionCandidate[] {
    return evictionCandidates(this.store.entries(), { policy: this.retention, weightOf: record => this.weightOf(record) })
  }
  /** The pressure the accounted usage puts the store in, which is what health reports and a pass starts from. */
  private capacityState(): CapacityState {
    return capacityOf(this.store.currentUsage, { limit: this.limits.budgetBytes, reserve: this.store.reserveBytes }, this.retention)
  }
  /**
   * Accept one compression job's summary, or write nothing at all. The job must have read the version it names, the gist must name
   * sources the request actually carried and the service actually holds in the same scope, and it must still keep the subject, dates,
   * negations and constraints of the original — a lossy rendering is allowed, losing a "not" is not. What it replaces is the
   * representation, never the experience: the original stays reachable by the same id, and the revision it replaced is kept as the one
   * step an operator can take back.
   */
  submitCandidate(candidate: CompressionCandidate): SubmitResult {
    const version = this.store.version
    if (candidate.baseVersion !== version) return { status: 'conflict', id: candidate.experienceId, baseVersion: candidate.baseVersion, version }
    const record = this.store.record(candidate.experienceId)
    if (!record) return { status: 'rejected', reason: 'unknown', version }
    if (!this.summarisable(candidate, record)) return { status: 'rejected', reason: 'invalidInput', version }
    if (!this.store.writable) return { status: 'rejected', reason: 'readOnly', version }
    // A summary is a write like any other: a queued job commits only while the deployment still proves this is the single writer.
    if (!this.gate().open) return { status: 'rejected', reason: 'noIsolation', version }
    // One job is one answer: a candidate whose job already wrote this record's summary changes nothing, however often it is offered.
    if (record.representation.summary?.jobId === candidate.jobId) return { status: 'rejected', reason: 'stale', version }
    const summary: Summary = { text: candidate.text, sourceMap: [...candidate.sourceMap], jobId: candidate.jobId, version: candidate.version,
      model: candidate.model, baseVersion: candidate.baseVersion, digest: candidate.digest, at: candidate.at }
    const { rollback: _previousRollback, ...held } = record.representation
    // A record a revision already closed or disputed says so once it is rewritten: this is the write in which an affected gist is
    // re-consolidated, so it is also the write in which the claim's window and standing are recorded rather than only derived.
    const representation: Representation = { ...this.settled(held, this.revision(record.experience.id)),
      revision: record.representation.revision + 1, summary, previous: previousOf(record.representation) }
    return this.commit(candidate.jobId, candidate.at, this.carried({ ...record, representation }), record.experience.id)
  }
  /**
   * Take back the representation a compression job last committed, as one more version rather than an edit of a published file: the
   * next read returns what it returned before that job, and the rolled-back revision stays in the journal for an operator to explain.
   * It goes through the same gate and the same commit as every other write, and exactly one step is kept, so a rollback cannot walk a
   * record back through history it never showed anyone.
   */
  rollback(id: string): RollbackResult {
    const version = this.store.version
    const record = this.store.record(id)
    if (!record) return { status: 'unknown', id }
    const previous = record.representation.previous
    if (!previous) return { status: 'none', id, version: this.store.version }
    if (!this.store.writable) return { status: 'readOnly', id, version: this.store.version }
    // A rollback is a write like any other, and a deployment without a boundary answers it the same way it answers a capture.
    if (!this.gate().open) return { status: 'noIsolation', id, version: this.store.version }
    const at = this.now()
    const { summary: _summary, previous: _taken, rollback: _rolledBack, ...held } = record.representation
    const representation: Representation = { ...held, revision: record.representation.revision + 1,
      ...(previous.summary === undefined ? {} : { summary: previous.summary }), rollback: { from: record.representation.revision, at } }
    const { result } = this.store.commit(rollbackIdOf(id, version), at, this.carried({ ...record, representation }))
    if (result.status === 'backpressured') return { status: 'none', id, version: this.store.version }
    return { status: 'rolledBack', id, version: result.version, from: record.representation.revision }
  }
  /**
   * Publish one record as a new version and answer what became of it: the version a commit that landed produced, whether the version
   * already held exactly this record, or the usage of a store that could not take it. Every write path answers through it, so a
   * capture, a background candidate and an operator's rollback cannot disagree about what a commit means.
   */
  private commit(opId: string, at: string, record: MemoryRecord, id: string): SubmitResult {
    const { result, duplicate } = this.store.commit(opId, at, record)
    if (result.status === 'backpressured') return { status: 'backpressured', reason: 'capacity', usage: result.usage }
    return duplicate ? { status: 'duplicate', id, version: result.version } : { status: 'created', id, version: result.version }
  }
  /**
   * Commit one background job's score for one experience, or write nothing at all. The job must have read the version it names, the
   * policy must be this service's own, the semantic score must be on the scale, the citations must be input ids the request carried,
   * and the rule half is recomputed here rather than accepted: a candidate the service cannot re-derive is not a score. The commit
   * is one journal op in a new version, so a reader that finds it sees the weight and the record together, and a rejected candidate
   * leaves the weight the record already had.
   */
  submitScore(candidate: ScoreCandidate): SubmitResult {
    const version = this.store.version
    if (this.policyProblems.length) return { status: 'rejected', reason: 'unsupported', version }
    if (candidate.policy !== this.policy.version || candidate.principles === '' || candidate.jobId === '' || candidate.digest === '')
      return { status: 'rejected', reason: 'unsupported', version }
    if (candidate.baseVersion !== version) return { status: 'rejected', reason: 'stale', version }
    const record = this.store.record(candidate.experienceId)
    if (!record) return { status: 'rejected', reason: 'unknown', version }
    const rule = ruleScoreOf(record.experience, this.policy)
    if (!this.scoreable(candidate, record, rule)) return { status: 'rejected', reason: 'invalidInput', version }
    if (!this.store.writable) return { status: 'rejected', reason: 'readOnly', version }
    // A score is a write like any other: without a boundary that keeps a shell out of these files there is no single writer.
    if (!this.gate().open) return { status: 'rejected', reason: 'noIsolation', version }
    // A job id that already applied to this record is the same answer twice; the version it named has moved on, so this is the
    // check that makes a repeated delivery of one job a no-op rather than a second weight.
    if (record.importance?.jobId === candidate.jobId) return { status: 'rejected', reason: 'stale', version }
    const importance: Importance = { score: importanceOf(rule.score, candidate.semantic, this.policy), rule: rule.score, ruleParts: rule.parts,
      semantic: candidate.semantic, policy: this.policy.version, principles: candidate.principles, model: candidate.model, jobId: candidate.jobId,
      baseVersion: candidate.baseVersion, digest: candidate.digest, rationale: candidate.rationale, cited: [...candidate.cited],
      uncertain: [...candidate.uncertain], at: candidate.at }
    return this.commit(candidate.jobId, candidate.at, this.carried({ ...record, importance }), record.experience.id)
  }
  /** The weight one experience carries, which is the record a reader explains a recall order with. */
  importance(id: string): Importance | undefined { return this.store.record(id)?.importance }
  /**
   * The effective weight one experience carries at this instant: its committed importance lowered by the policy's one time term.
   * It is recomputed from the record and the clock rather than stored, so moving the clock re-scores nothing and a read changes
   * no byte; `undefined` means the service holds no such experience.
   */
  weight(id: string): number | undefined {
    const record = this.store.record(id)
    return record === undefined ? undefined : this.weightOf(record)
  }
  /** The rung that weight has reached: what routine recall may show of it, and whether it is a candidate of routine recall at all. */
  granularity(id: string): Granularity | undefined {
    const record = this.store.record(id)
    return record === undefined ? undefined : granularityOf(this.weightOf(record), this.policy)
  }
  /** The whole record of one experience, so a background job can read the fact it evaluates without a second door into the files. */
  record(id: string): MemoryRecord | undefined { return this.store.record(id) }
  /**
   * Where one experience's knowledge stands in the published version: still current, replaced at a named instant, or disputed with
   * the experiences that disagree. Derived from the revision links of every record, because a successor closes an older window
   * without rewriting the record that made the older claim.
   */
  revision(id: string): RevisionState | undefined {
    const record = this.store.record(id)
    return record === undefined ? undefined : stateOf(record, this.store.entries())
  }
  /** Every record's standing at once, so a read derives the graph once instead of once per candidate. */
  private revisions(): Map<string, RevisionState> { return revisionStates(this.store.entries()) }
  /** The same answer as a function a reader takes: one derivation per read, and a record the graph does not know is current. */
  private standing(): (record: MemoryRecord) => RevisionState {
    const states = this.revisions()
    return record => states.get(record.experience.id) ?? currentState(record)
  }
  /** The policy version weights are computed with, which a committed score names. */
  get policyVersion(): string { return this.policy.version }
  /**
   * Recalled material for one request, deterministic, in scope, and cut to the characters the caller may spend. It is routine
   * recall: an experience under the last threshold is matched and then left out, reported by count rather than shown as a body it
   * no longer earns — it is not deleted, and `reactivate` is the door a strong cue opens. `at` names the instant the question is
   * about, so a question about March is answered by the claims whose window held then rather than by the newest one.
   */
  recall(request: RecallRequest): RecallResult {
    return recallBlock(rank(this.store.entries(), request, record => this.weightOf(record), this.standing()), request.allowanceChars,
      this.store.version, this.policy, 'forgotten', request.at)
  }
  /**
   * Matches a new capture may reactivate on its own: the same ranking and the same scope filter, but only matches strong enough to
   * interrupt a request, which is what separates "this is related" from "this is the same thing". Routine thresholds decide
   * candidacy, so a strong cue may raise a forgotten experience back into it — at the gist, never above the rung its own weight
   * reached — and the raise lasts for this one answer: nothing about the experience, its weight, its age or its retention changes.
   * Standing is not raised either: a claim a later fact replaced is delivered after what replaced it and said to be replaced, so a
   * wake can never put the past back in the present.
   */
  reactivate(request: RecallRequest): RecallResult {
    const strong = rank(this.store.entries(), request, record => this.weightOf(record), this.standing())
      .filter(match => strongEnough(match, this.policy))
    return recallBlock(strong, request.allowanceChars, this.store.version, this.policy, 'summary', request.at)
  }
  /** What is in scope, newest first, for a caller that has no cue to match: the read resource pages this. */
  list(request: ListRequest): ListResult { return listScope(this.store.entries(), request, this.store.version, this.standing()) }
  /**
   * The whole original text of one experience, or the honest state of it: an evicted detail is never dressed up as a summary, and
   * a summary is never used to fill in a body the store released. What a reader is handed instead is the gist the record kept and
   * the instant its text stopped being stored, so the limit of what is available is stated rather than inferred.
   */
  expand(request: ExpandRequest): ExpandResult {
    const record = this.store.record(request.id)
    if (!record) return { status: 'unknown', id: request.id }
    const summary = record.representation.summary
    const gist = summary === undefined ? {} : { summary }
    const { detail } = record.representation
    const released = detail.evictedAt === undefined ? {}
      : { evictedAt: detail.evictedAt, ...(detail.evictedBy === undefined ? {} : { evictedBy: detail.evictedBy }) }
    if (!detail.available) return { status: 'evicted', id: request.id, ...released, ...gist }
    const material = record.experience.material
    // A record still marked readable whose blob a crash swept is the same answer: the store does not hold the text, and saying so
    // is the whole point of the status rather than a fallback to anything shorter.
    const whole = material.form === 'blob' ? this.store.readBlob(material.blob) : materialText(material)
    if (whole === undefined) return { status: 'evicted', id: request.id, ...released, ...gist }
    const kept = whole.length > request.allowanceChars ? whole.slice(0, Math.max(0, request.allowanceChars)) : whole
    return { status: 'available', id: request.id, text: kept, chars: kept.length, truncated: kept.length < whole.length,
      omittedChars: material.form === 'truncated' ? material.omittedChars : 0, ...gist }
  }
  /** The published version, what it takes on disk, what is held back and reclaimable, and whether the store is still writing. */
  status(): MemoryStatus {
    const usage = this.store.currentUsage, limit = this.limits.budgetBytes, gate = this.gate()
    const writable = this.store.writable && gate.open
    // The pressure is a statement about the bytes, not about whether this process may write: a read-only store reports the same
    // capacity a writable one would, and the top-level state is the two answers put together.
    const reserve = this.store.reserveBytes
    const pressure = capacityOf(usage, { limit, reserve }, this.retention)
    const state = writable ? pressure : 'readOnly' as const
    // Only a store under pressure has anything a pass would drop now, and ranking every original costs a serialisation each: the
    // answer below the high watermark is none, because that is what reclamation would do — and it is asked on every health report.
    const candidates = pressure === 'ready' ? [] : this.candidates()
    const problems = gate.open ? [...this.store.problemList, ...this.policyProblems, ...this.retentionProblems]
      : [...this.store.problemList, ...this.policyProblems, ...this.retentionProblems, gate.detail]
    const capacity: MemoryCapacity = { limit, reserve, state: pressure, reclaimable: this.store.reclaimableBytes(),
      candidates: candidates.length, candidateBytes: candidates.reduce((sum, candidate) => sum + candidate.gain, 0),
      highWater: this.retention.water.high, lowWater: this.retention.water.low, retention: this.retention.version,
      reclaimed: this.store.reclaimed }
    return { version: this.store.version, seq: this.store.seq, experiences: this.store.size(), writable, usage, limits: this.limits,
      state, capacity, policy: this.policy.version, problems }
  }
  /** The retrieval cues of a stored experience, which the automatic door matches a new capture against. */
  cuesOf(id: string): readonly string[] { return this.store.record(id)?.representation.cues ?? [] }
  /**
   * One bounded page of the records a re-evaluation sweep may have to redo, in the order they were first written, with what their
   * committed results name. Records are only ever appended or replaced in place, so a cursor over that order never skips one and never
   * reads one twice; the page is bounded by `limit` so a sweep of a long history is finite work per pass rather than one long scan.
   */
  scan(after: number, limit: number): ScanPage {
    const items: ComputedUnder[] = []
    let index = 0, more = false
    for (const record of this.store.entries()) {
      if (index++ < after) continue
      if (items.length >= Math.max(1, limit)) { more = true; break }
      const importance = record.importance, summary = record.representation.summary
      items.push({ id: record.experience.id,
        ...(importance === undefined ? {} : { importance: { principles: importance.principles, policy: importance.policy,
          model: importance.model } }),
        ...(summary === undefined ? {} : { summary: { version: summary.version, model: summary.model } }) })
    }
    return { items, ...(more ? { next: after + items.length } : {}) }
  }
  /** Whether one experience is inside `scope`, which is what decides whether a read may return it at all. */
  holds(id: string, scope: Scope): boolean { const record = this.store.record(id); return record !== undefined && inScope(record, scope) }
  /** Byte of headroom left before the store refuses large material, which decides whether it is kept whole or truncated. */
  remainingBytes(): number { return this.store.remainingBytes() }
  /** Every op is already fsynced, so this flushes nothing and releases the journal handle. */
  close(): void { this.store.close() }
  /**
   * The effective weight of one record: the importance a job committed, or the rule half alone until one has, lowered by the policy's
   * one time term and never raised by anything a query does. An experience that was never scored is therefore not weightless — it
   * carries the deterministic provisional score its own facts justify — and a scoring job that fails leaves exactly that in place.
   */
  private weightOf(record: MemoryRecord): number {
    const score = record.importance?.score ?? ruleScoreOf(record.experience, this.policy).score
    return weightOf(score, record.experience.occurredAt, this.now(), this.policy)
  }
  /**
   * Whether one candidate is a score this service can re-derive and accept: the semantic half on the policy's scale, the rule half
   * the one the record produces, a rationale that says why, citations that name inputs the job actually read, and stated
   * uncertainties small enough to keep. Anything else is not a score and never becomes one.
   */
  private scoreable(candidate: ScoreCandidate, record: MemoryRecord, rule: ReturnType<typeof ruleScoreOf>): boolean {
    const { min, max } = this.policy.scale
    if (!Number.isFinite(candidate.semantic) || candidate.semantic < min || candidate.semantic > max) return false
    if (!Number.isFinite(candidate.rule) || Math.abs(candidate.rule - rule.score) > 1e-9) return false
    if (!Number.isFinite(Date.parse(candidate.at))) return false
    if (typeof candidate.rationale !== 'string' || candidate.rationale.trim() === '' || candidate.rationale.length > RATIONALE_MAX_CHARS)
      return false
    const known = new Set([record.experience.id, ...Object.values(record.experience.origin.ids)])
    if (!Array.isArray(candidate.cited) || candidate.cited.length === 0 || !candidate.cited.every(id => known.has(id))) return false
    return Array.isArray(candidate.uncertain) && candidate.uncertain.length <= UNCERTAIN_MAX
      && candidate.uncertain.every(text => typeof text === 'string' && text.length <= UNCERTAIN_MAX_CHARS)
  }
  /**
   * Whether one candidate is a summary this service can re-derive and accept: a job that named itself, a text within the gist bound,
   * sources that are inputs the request carried and experiences this store still holds in the same scope, and every feature the
   * original states — its subject, dates, negations and constraints — still in the text. Anything else is not a shorter record of the
   * fact, and never becomes one.
   */
  private summarisable(candidate: CompressionCandidate, record: MemoryRecord): boolean {
    if (typeof candidate.jobId !== 'string' || candidate.jobId === '' || candidate.digest === '' || candidate.version === '') return false
    if (typeof candidate.model !== 'string' || candidate.model === '') return false
    if (!Number.isFinite(Date.parse(candidate.at))) return false
    if (!Array.isArray(candidate.cited) || typeof candidate.text !== 'string' || !Array.isArray(candidate.sourceMap)) return false
    // The cited ids are what the request carried, so the service can check them rather than trust them: each must be an experience it
    // holds, and one whose scope the summary could legitimately be about. A gist may never silently widen what it read.
    for (const id of candidate.cited) {
      const other = id === record.experience.id ? record : this.store.record(id)
      if (!other || !sameScope(record, other)) return false
    }
    return summaryProblems({ experience: record.experience, text: candidate.text, sourceMap: candidate.sourceMap,
      cited: candidate.cited }).length === 0
  }

  /** The immutable record of one capture: where its text lives, and the cues retrieval will find it by. */
  private recordOf(input: ExperienceInput): MemoryRecord {
    const chars = input.material.chars, text = input.material.text
    const material = this.materialOf(text, chars)
    const experience: Experience = { id: input.id, occurredAt: input.occurredAt, recordedAt: input.recordedAt, source: input.source,
      ...(input.subject === undefined ? {} : { subject: input.subject }), scope: input.scope, kind: input.kind, material, origin: input.origin }
    const blob = material.form === 'blob' ? material.bytes : Buffer.byteLength(text, 'utf8')
    const cues = cuesOfMaterial(material, input.subject, this.limits.maxCues)
    const representation: Representation = { experienceId: input.id, revision: 1, cues, detail: { available: true, bytes: blob },
      // What the claim is about comes from its own text, never from the author two records share: an author is not a subject.
      validFrom: input.occurredAt, assertions: [claimOf(experience, topicOfMaterial(material))] }
    return this.carried({ experience, representation, seq: 0, version: 0 })
  }
  /**
   * One record as it is written, with the confidence its own evidence supports computed from the published version: the newest
   * record of the same claim sees the Sources it reached from, and a record a write rewrites is recounted rather than trusted to the
   * number it was first written with. A read never runs this, which is why nothing a reader does can raise the value.
   */
  private carried(record: MemoryRecord): MemoryRecord {
    const origins = [record, ...this.store.entries()].filter(other => sameClaim(record, other))
      .map(other => other.experience.source).filter((source, index, all) => all.indexOf(source) === index).sort()
    const score = Math.min(CONFIDENCE_MAX, KIND_CONFIDENCE[record.experience.kind] + CORROBORATION_STEP * (origins.length - 1))
    return { ...record, confidence: { score: Math.round(score * 1000) / 1000, kind: record.experience.kind, origins } }
  }
  /** What the evidence behind one record supports, which is what a reader that wants the number and its sources asks for. */
  confidence(id: string): Confidence | undefined { return this.store.record(id)?.confidence }
  /**
   * One record with the revision it commits with: the links to what it replaced, disputed or arrived behind, and the window they
   * close on its own claim. The record is the only thing written; the older claims are closed by derivation, and their own text,
   * revision and journal op are left exactly as they were.
   */
  private revised(record: MemoryRecord, links: readonly Supersession[]): MemoryRecord {
    const representation = record.representation
    const closes = links.find(edge => edge.kind === 'earlier')?.at
    const disputed = links.some(edge => edge.kind === 'disputes')
    return { ...record, representation: { ...representation, supersedes: [...links],
      ...(closes === undefined ? {} : { validTo: closes }),
      assertions: (representation.assertions ?? []).map(assertion => ({
        ...assertion,
        status: closes !== undefined ? 'superseded' as const : disputed ? 'disputed' as const : assertion.status,
        ...(closes === undefined ? {} : { validTo: closes }) })) } }
  }
  /**
   * The representation a commit writes for a record a revision already settled: a claim that was replaced says when, and one still
   * in dispute says so, so the record carries the state a reader would otherwise have to derive from another record's link.
   */
  private settled(representation: Representation, state: RevisionState | undefined): Representation {
    if (state === undefined || state.status === 'current') return representation
    const final = state.status === 'superseded'
      ? { status: 'superseded' as const, ...(state.validTo === undefined ? {} : { validTo: state.validTo }) }
      : { status: 'disputed' as const }
    return { ...representation, ...(state.validTo === undefined ? {} : { validTo: state.validTo }),
      assertions: (representation.assertions ?? []).map(assertion => ({ ...assertion, ...final })) }
  }
  /**
   * Where the original text lives. Small text stays in the journal; larger text goes to a content-addressed blob, which reclamation
   * may drop while the record and its cues stay; text larger than the capture keeps, than the store has room for, or than a
   * pressurised store may take, is kept as its head with the exact count of what was never stored — because a fact must not be
   * lost over the size of its body, and a full store must not walk past its hard cap to admit one more. Stopping new large
   * originals is the back-pressure the spec asks for: the store states the capacity it is under instead of writing anyway.
   */
  private materialOf(text: string, chars: number): Material {
    if (chars > CAPTURE_MAX_CHARS || text.length > CAPTURE_MAX_CHARS) {
      const kept = text.slice(0, CAPTURE_MAX_CHARS)
      return { form: 'truncated', text: kept, chars: kept.length, omittedChars: Math.max(chars, text.length) - kept.length }
    }
    if (text.length <= this.limits.materialInlineMaxChars) return { form: 'inline', text, chars }
    const bytes = Buffer.byteLength(text, 'utf8')
    if (this.capacityState() !== 'ready' || this.remainingBytes() < bytes) {
      return { form: 'truncated', text, chars: text.length, omittedChars: chars - text.length }
    }
    const blob = this.store.writeBlob(text)
    return { form: 'blob', blob: blob.blob, chars, bytes: blob.bytes, head: text.slice(0, BLOB_HEAD_CHARS) }
  }
}
/**
 * Whether two records can be about the same thing: every scope key the first names must equal the other's, which is the same rule
 * retrieval filters by. A summary may draw on evidence inside one scope, and never on another project's or another ticket's record.
 */
const sameScope = (left: MemoryRecord, right: MemoryRecord): boolean => (['project', 'task', 'person'] as const)
  .every(key => left.experience.scope[key] === undefined || left.experience.scope[key] === right.experience.scope[key])
/**
 * What one representation replaced: its revision and its gist alone, never the gist of the one before it, so a rollback has exactly one
 * step to take and cannot walk a record back through versions no reader was ever shown.
 */
const previousOf = (representation: Representation): PreviousRepresentation => ({ revision: representation.revision,
  ...(representation.summary === undefined ? {} : { summary: representation.summary }) })
