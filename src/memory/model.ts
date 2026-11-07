/**
 * The long-term memory's domain, and nothing else: what one experience is, what may be recalled of it, the stable identity a
 * redelivery is recognised by, and the types of the versioned numeric policy a score is computed with. No I/O, no imports
 * from `src/app`, so every consumer of memory agrees on the vocabulary before any file is written.
 */
import { z } from 'zod'
import { key } from '../core/ids.ts'

/** Who and what an experience is about. It is filtered before matching, never after, so a record out of scope can never be scored. */
export interface Scope { project?: string; task?: string; person?: string }
/** What kind of fact an experience records: what was seen, what the model concluded, and what was later asserted. */
export type ExperienceKind = 'observation' | 'inference' | 'statement'

/**
 * The original material of one experience: the text itself while it is small, a content-addressed blob once it is large, and the
 * head of it when it was too large to keep. A caller must never invent the rest of a truncated material: `omittedChars` says how
 * much of it was never stored.
 */
export type Material =
  | { readonly form: 'inline'; readonly text: string; readonly chars: number }
  | { readonly form: 'blob'; readonly blob: string; readonly chars: number; readonly bytes: number; readonly head: string }
  | { readonly form: 'truncated'; readonly text: string; readonly chars: number; readonly omittedChars: number }

/** Where an experience came from: the domain event, when it was announced, what it was about, and the source's own references. */
export interface Origin {
  readonly event: string
  /** When the Engine announced the event, which is also the experience's `recordedAt`. */
  readonly at: string
  /** The id of the thing the event is about, which the experience's id derives from: a trigger, a ticket, or a policy change. */
  readonly primary: string
  /** The source references kept with the fact: message, ticket and thread ids, or the policy change's two versions. */
  readonly ids: Record<string, string>
  readonly url?: string
}

/** One experience: the immutable fact, addressed by an id that is the same on every redelivery. */
export interface Experience {
  readonly id: string
  /** When it happened, by the source's clock. */
  readonly occurredAt: string
  /** When the memory service accepted it, which is the Engine's time for the event and identical on every redelivery. */
  readonly recordedAt: string
  /** `feishu:<chat>`, `github:<repo>`, `runtime`, … — the Source it came from, never interpreted by the store. */
  readonly source: string
  readonly subject?: string
  readonly scope: Scope
  readonly kind: ExperienceKind
  readonly material: Material
  readonly origin: Origin
}

/**
 * The short representation one background compression job committed: the gist, the experiences it was drawn from, and everything
 * needed to explain it later. It is a lossy rendering, checked against what the original states rather than claimed to mean the same
 * thing, and it is never presented to a reader as the original: `expand` serves that, and says so when it is gone.
 */
export interface Summary {
  readonly text: string
  /** The ids of the experiences the gist was drawn from; every one of them was in the request's own evidence. */
  readonly sourceMap: readonly string[]
  readonly jobId: string
  /** The compression principles version that produced this text, which an operator reads back to explain or roll back a gist. */
  readonly version: string
  /** The provider and model that answered, as `provider/model`. */
  readonly model: string
  /** The memory version the job read, which is the version its candidate had to name to be accepted. */
  readonly baseVersion: number
  /** sha256 of the exact request the job sent: its principles, this job and the bounded evidence it was given. */
  readonly digest: string
  readonly at: string
}
/** What one representation replaced: exactly one step back, which is what an operator's rollback restores. */
export interface PreviousRepresentation { readonly revision: number; readonly summary?: Summary }
/** The rollback an operator last took to a representation, so a repeated read says a step back was taken and from where. */
export interface Rollback { readonly from: number; readonly at: string }
/**
 * One claim an experience makes about the world, the sources behind it, and the window it holds in. `status` is what was true when
 * the record was written; a later record may close the window without rewriting the record that made the claim, so a reader takes
 * the status from the revision state instead of trusting this field alone.
 */
export interface Assertion {
  readonly text: string
  /** The experience itself and the source references behind it, which is what a conflict is returned with. */
  readonly sourceIds: readonly string[]
  readonly status: 'current' | 'superseded' | 'disputed'
  /** The cues that say what the claim is about, which is how a later record is recognised as being about the same thing. */
  readonly topic: readonly string[]
  /** The instant the claim started holding, which is the experience's own fact-valid time. */
  readonly validFrom: string
  /** The instant the claim stopped holding, when it was already past the moment it was written. */
  readonly validTo?: string
}
/** How one record's knowledge stands to the record a revision link names. */
export type RevisionKind =
  /** This record replaced the named one: it holds from its own `validFrom`, and the named one stops holding there. */
  | 'replaces'
  /** The named one was already the newer understanding: this record arrived late and its window ends where that one starts. */
  | 'earlier'
  /** The evidence contradicts the named one and nothing settles which holds: both stay disputed. */
  | 'disputes'
/** One revision link: the other knowledge, the revision it was at, how this record stands to it, and the instant the two meet. */
export interface Supersession {
  readonly experienceId: string
  readonly revision: number
  readonly kind: RevisionKind
  /** `replaces`: the instant the older claim stopped holding. `earlier`: the instant this claim stopped. `disputes`: when it was found. */
  readonly at: string
}
/**
 * Where one record's knowledge stands at an instant, derived from every revision link in the published version. `current` means no
 * evidence contradicts it, `superseded` that a later claim ended its window, `disputed` that evidence disagrees and nothing settles
 * which holds. It is derived rather than stored because a successor closes an older window without rewriting the older record.
 */
export interface RevisionState {
  readonly status: 'current' | 'superseded' | 'disputed'
  readonly validFrom: string
  readonly validTo?: string
  /** The experience that ended this window, when a revision link names one. */
  readonly by?: string
  /** The experiences this one is in unresolved disagreement with. */
  readonly disputedWith: readonly string[]
}

/**
 * The versioned, recallable representation of one experience. A compression or a revision replaces a representation and leaves the
 * experience (and its blob) untouched, which is why the two are separate records rather than one.
 */
export interface Representation {
  readonly experienceId: string
  /** Which representation this is: 1 for the one capture writes, higher when a write replaces it. */
  readonly revision: number
  /** Deterministic retrieval cues, the same derivation on the query side. */
  readonly cues: readonly string[]
  /** The gist a compression job committed; recall returns it until an operator rolls it back. */
  readonly summary?: Summary
  /** What this revision replaced, kept for exactly one rollback step; a revision history builds on it, not on the experience. */
  readonly previous?: PreviousRepresentation
  /** The rollback an operator took to reach this revision, when one did. */
  readonly rollback?: Rollback
  /** Whether the original text is still readable, how many bytes it took, and the instant it was released; reclamation flips it. */
  readonly detail: { readonly available: boolean; readonly bytes: number; readonly evictedAt?: string
    /** The retention policy version the original was released under, so an operator can read back why it went. */
    readonly evictedBy?: string }
  /** The first instant the fact held, which is the experience's own fact-valid time: when it happened, not when it was written. */
  readonly validFrom: string
  /** When this record stopped being the current understanding: a later record replaced it, or it arrived already past one. */
  readonly validTo?: string
  /** The older knowledge this record replaced or disputes, and the newer knowledge it arrived behind: nearest first, few. */
  readonly supersedes?: readonly Supersession[]
  /** The claims this record makes. One capture makes one; a reader renders them with the state it derives from the links. */
  readonly assertions?: readonly Assertion[]
}

/**
 * What the evidence behind one record supports: the kind of experience it is, raised only by the same claim arriving from another
 * Source. It is computed by the service from the published version when the record is written and then stored with it, so a read
 * changes nothing and two runs over the same evidence agree. It is deliberately one of four separate quantities: not `Importance`
 * (how much the experience matters), not the correlation a single query scored, and not `RevisionState` (where the claim stands now).
 * Nothing a read does — recalling it again, a model restating it, a second report from the same Source — can raise it.
 */
export interface Confidence {
  /** 0–1: the base the kind of evidence supports, plus one step per further independent Source, short of certainty. */
  readonly score: number
  /** The kind of experience the base was computed from. */
  readonly kind: ExperienceKind
  /** The Sources the same claim reached from, sorted: one entry when nothing corroborated it. */
  readonly origins: readonly string[]
}

/** One experience with its representation, the weight a background scoring job gave it, and the version of the store that produced it. */
export interface MemoryRecord {
  readonly experience: Experience
  readonly representation: Representation
  /** How much this experience matters, which a scoring job commits and nothing about a query ever changes. Absent until one did. */
  readonly importance?: Importance
  /** What the evidence itself supports, committed with the record and never moved by a read; absent in a record written before it. */
  readonly confidence?: Confidence
  /** The journal op that produced this record; re-applying an op at or below the state's own `seq` changes nothing. */
  readonly seq: number
  readonly version: number
}

/**
 * The weight one scoring job committed, with everything needed to explain it later: the two scores it was combined from, the
 * rule terms behind the first, the policy and principles it was computed under, the model that answered, the id of the job, the
 * digest of the exact request it read, and the ids it cited. Nothing else records a background model call — it has no Session —
 * so this record is the audit trail, and it is written with the commit rather than beside it.
 */
export interface Importance {
  /** The continuous importance on the policy's scale: `ruleWeight × rule + semanticWeight × semantic`, clamped. */
  readonly score: number
  /** The deterministic rule half, which the service recomputes and never takes from the model. */
  readonly rule: number
  /** The named rule terms behind `rule`, so the number can be read back into why. */
  readonly ruleParts: readonly string[]
  /** The background model's continuous judgement, on the same scale, which never replaces the rule half. */
  readonly semantic: number
  readonly policy: string
  readonly principles: string
  /** The provider and model that answered, as `provider/model`. */
  readonly model: string
  readonly jobId: string
  /** The version the job computed from, which is the version its candidate had to name to be accepted. */
  readonly baseVersion: number
  /** sha256 of the exact request the job sent: its principles, this job and the bounded evidence it was given. */
  readonly digest: string
  readonly rationale: string
  /** Input ids the reply cited, every one of which the request carried. */
  readonly cited: readonly string[]
  /** What the reply said it is unsure about, which no threshold hides. */
  readonly uncertain: readonly string[]
  readonly at: string
}

/** The candidate one background scoring job hands the memory service: the only way a score becomes durable. */
export interface ScoreCandidate {
  readonly jobId: string
  readonly experienceId: string
  /** The version the job read; a candidate naming any other version is stale and commits nothing. */
  readonly baseVersion: number
  readonly semantic: number
  /** The rule score the job computed, which the service recomputes and refuses if it disagrees. */
  readonly rule: number
  readonly ruleParts: readonly string[]
  readonly policy: string
  readonly principles: string
  readonly model: string
  readonly digest: string
  readonly rationale: string
  readonly cited: readonly string[]
  readonly uncertain: readonly string[]
  readonly at: string
}

/**
 * The candidate one background compression job hands the memory service: the only way a gist becomes durable. It names the version
 * it read, the job that wrote it, the experiences it draws on and every input id its request carried, so the service can re-check the
 * scope, the citations and the features of the original it claims to keep before anything replaces what recall returns.
 */
export interface CompressionCandidate {
  readonly jobId: string
  readonly experienceId: string
  /** The version the job read; a candidate naming any other version was computed from replaced material and commits nothing. */
  readonly baseVersion: number
  readonly text: string
  /** The experiences the gist draws on, each of which the request carried. */
  readonly sourceMap: readonly string[]
  /** The compression principles version the job ran under. */
  readonly version: string
  readonly model: string
  readonly digest: string
  readonly at: string
  /** Every input id the request carried, which is the only set `sourceMap` may name and the service can verify as held. */
  readonly cited: readonly string[]
}

/** What a capture reports: the fact, identified and timed, before the service decides where its text lives. */
export interface ExperienceInput {
  /** `experienceId(...)` of this input's own event, which the service re-derives and verifies. */
  readonly id: string
  /** The op id a redelivery is recognised by; `opIdOf(id)`. */
  readonly opId: string
  readonly occurredAt: string
  readonly recordedAt: string
  readonly source: string
  readonly subject?: string
  readonly scope: Scope
  readonly kind: ExperienceKind
  /** The text as captured, already bounded by the capture side, and its length when it was captured. */
  readonly material: { readonly text: string; readonly chars: number }
  readonly origin: Origin
}

/** How large the memory files may grow, and how the store behaves inside that; read per use so a changed setting applies. */
export interface MemoryLimits {
  /** Total bytes every file under the memory root may use. */
  readonly budgetBytes: number
  /** Characters recalled material may take in one model request, before the request budget caps it further. */
  readonly recallMaxChars: number
  /** Ops a journal tail may hold before the store writes a checkpoint. */
  readonly checkpointOps: number
  /** Bytes one journal segment may hold before the next op starts a new one. */
  readonly segmentBytes: number
  /** Characters of original text kept in the journal; longer text goes to a content-addressed blob. */
  readonly materialInlineMaxChars: number
  /** Most retrieval cues kept per experience. */
  readonly maxCues: number
}

/** What the memory's files take, by the class of file reclamation frees separately. */
export interface MemoryUsage {
  readonly raw: number
  readonly summaries: number
  readonly index: number
  readonly journal: number
  readonly history: number
  readonly temporary: number
  readonly total: number
}

/**
 * How much of one experience routine recall may show of it: the rung its effective weight has walked to. Full detail while the
 * experience is fresh or important enough to be read as it was recorded, the gist a compression job wrote once it no longer is,
 * its cues alone once even that is too much for the current attention, and nothing at all once it has left routine recall — where
 * only a strong correlation may wake it, and where the original is still stored rather than deleted.
 */
export type Granularity = 'detail' | 'summary' | 'cues' | 'forgotten'

/**
 * The versioned numeric policy a score is computed with, recorded on every commit so a recalled weight can name the rules it used.
 * This interface is the shape and `POLICY_VERSION` the version this build records; the numbers and their validation are `MEMORY_POLICY`
 * in `score.ts`, and the 0–100 scale is declared by a policy rather than baked in here.
 */
export interface MemoryPolicy {
  readonly version: string
  readonly scale: { readonly min: number; readonly max: number }
  readonly ruleWeight: number
  readonly semanticWeight: number
  readonly time: { readonly unit: 'day'; readonly base: string; readonly decay: number }
  readonly thresholds: { readonly detail: number; readonly summary: number; readonly forgotten: number }
  /**
   * Whether a weight exactly at a threshold takes the higher rung or the lower one. It is part of the versioned policy because a
   * boundary has to be stated once and then read the same way by every decision, never inferred from which comparison is written.
   */
  readonly inclusive: boolean
  /**
   * The correlation this query's match needs before it may wake an experience that left routine recall. It is a ratio between 0
   * and 1 of the query's own cue weight, and it is deliberately a different quantity from importance: how relevant this situation
   * is, never how much the experience matters.
   */
  readonly recallThreshold: number
  /** Optional enter/exit pair for a stateful decision; absent in this build, whose rungs are read from a pure function of the clock. */
  readonly hysteresis?: { readonly enter: number; readonly exit: number }
}
/**
 * The policy version every op of this build records. The numbers are `MEMORY_POLICY` in `score.ts`; this is the one string a
 * journal, a record and a reader can compare, so a weight can always name the rules it was computed with. Version 3 is the one
 * that puts the ordered thresholds and the correlation threshold in force as decisions rather than declarations; version 4 keeps
 * that ladder and moves only the time term, from one half per year to one half per decade, because a year-long horizon made every
 * fact history within months and the specification asks for the gist of an important experience to survive a span of years.
 */
export const POLICY_VERSION = 'mem-policy-4'

/** The id of one experience: the same on every delivery of the same event, and the queue key a repeated capture coalesces on. */
export const experienceId = (event: string, primary: string, recordedAt: string): string => key('experience', event, primary, recordedAt)
/** The op id of an experience's first publication, which a replay recognises and applies at most once. */
export const opIdOf = (id: string): string => key('op', 'experience', id)
/** The request id recalled material for one experience is delivered under, so a retry after a crash delivers no second copy. */
export const recallIdOf = (id: string): string => key('recall', id)
/** The op id of one operator rollback at one version, so the same rollback offered twice applies at most once. */
export const rollbackIdOf = (id: string, version: number): string => key('rollback', 'representation', id, String(version))
/** The op id of one reclamation of one record at one version, so a pass that runs twice writes once. */
export const evictIdOf = (id: string, version: number): string => key('evict', 'detail', id, String(version))

const timestamp = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/, 'a UTC timestamp, as Date#toISOString gives it')
const scope: z.ZodType<Scope> = z.strictObject({ project: z.string().min(1).optional(), task: z.string().min(1).optional(), person: z.string().min(1).optional() })
/**
 * One capture, validated when it is read back from the durable effect queue. It crosses a process and a storage boundary, so every
 * field is checked here rather than trusted; the id is additionally re-derived from the fields by the service.
 */
export const ExperienceInputSchema: z.ZodType<ExperienceInput> = z.strictObject({
  id: z.string().regex(/^[0-9a-f]{32}$/),
  opId: z.string().regex(/^[0-9a-f]{32}$/),
  occurredAt: timestamp,
  recordedAt: timestamp,
  source: z.string().min(1),
  subject: z.string().min(1).optional(),
  scope,
  kind: z.enum(['observation', 'inference', 'statement']),
  material: z.strictObject({ text: z.string(), chars: z.number().int().nonnegative() }),
  origin: z.strictObject({ event: z.string().min(1), at: timestamp, primary: z.string().min(1), ids: z.record(z.string(), z.string()),
    url: z.string().optional() }),
})
/** Characters of original text a capture may hand the service; a longer text is captured by its head and marked truncated. */
export const CAPTURE_MAX_CHARS = 32_768
/** Characters of a large material's head kept with the record, so recall works without reading the blob. */
export const BLOB_HEAD_CHARS = 512
