/**
 * The long-term memory's composition: which domain facts become experiences, how they travel durably from the Engine's transaction
 * to the memory service, the one door recalled material reaches a model through, and the dispatch of the independent scoring job a
 * new experience starts. Capture runs inside the caller's transaction and only enqueues the existing durable effect queue, so the
 * intent to remember commits or rolls back with the fact itself; the `memory` effect then publishes it, starts the background
 * evaluator on it, and, when a strong cue ties it to an older experience, delivers that recall to the main Session as labelled
 * background context. The evaluator is handed in by the runtime, because only it has the model request the job is made of.
 * Recall never enters the system-prompt section: it is re-sent on every request, and a delivered message is what the
 * model-surface tests can assert and the request budget can page.
 */
import { join } from 'node:path'
import { latestReport, threadKey, type DomainEvent } from '../core/index.ts'
import type { Machine } from '../deployment.ts'
import type { HealthEntry } from '../infra/health.ts'
import type { IsolationReport } from '../infra/isolation.ts'
import type { JobRecord, RetryResult, SweepResult } from '../memory/background.ts'
import { BACKGROUND_DEFAULTS, type BackgroundBacklog, type BackgroundLimits } from '../memory/background.ts'
import { CAPTURE_MAX_CHARS, experienceId, opIdOf, recallIdOf, type Confidence, type ExperienceInput, type ExperienceKind, type Importance,
  type MemoryLimits, type Scope } from '../memory/model.ts'
import { cuesOf, REACTIVATION_MIN_CUES, type ListResult, type RecallResult } from '../memory/retrieval.ts'
import { MemoryService, type ExpandResult, type MemoryStatus, type RollbackResult, type WriteGate } from '../memory/service.ts'
import { MEMORY_POLICY } from '../memory/score.ts'
import { pendingBytesOf } from '../memory/store.ts'
import { WakeAllowance, type WakeLimits, type WakeState } from '../memory/wake.ts'
import { Later, type Effects, type QueueOccupancy } from './effects.ts'
import { Redelivery, type RedeliveryLimits, type RedeliveryState, type RedeliveryStore } from './redelivery.ts'
import type { Store } from './store.ts'

/** The fixed numbers of the store a person does not set: a checkpoint after this many ops, a segment of this size, and the point at
 * which text moves to a blob. Reclamation's own policy and watermarks are `RETENTION` in `src/memory/archive.ts`, not here: these
 * are the store's implementation choices. */
export const STORE_DEFAULTS = { checkpointOps: 256, segmentBytes: 4 << 20, materialInlineMaxChars: 4096, maxCues: 32 } as const

/**
 * What a capture reads of the business: the Trigger a fact arrived as, where that Trigger went, and the Ticket its work became. It is
 * the whole of what this composition needs of the Store, so nothing here can reach the rest of it.
 */
export interface MemoryRecords {
  readonly tickets: Pick<Store['tickets'], 'get'>
  readonly triggers: Pick<Store['triggers'], 'get' | 'disposition'>
}

/** What the memory needs from the runtime it is wired into. */
export interface MemoryHost {
  readonly machine: Machine
  readonly effects: Pick<Effects, 'enqueue' | 'occupancy' | 'released'>
  /** The business records a capture is assembled from, which the memory reads and never writes. */
  readonly records: MemoryRecords
  /** The record a refused capture waits at, written inside the transaction of the fact whose capture was not accepted. */
  readonly position: RedeliveryStore
  /** The characters one Session's next request leaves for recalled material: the budget's allowance, less what the content the
   * model will actually see already takes — its compacted surface, never the append-only log compaction has superseded. */
  readonly room: (sessionId: string) => number
  /** Deliver recalled material to the main Session once per request id, without waking it. */
  readonly deliver: (requestId: string, text: string) => Promise<void>
  readonly masterId: string
  readonly health: HealthEntry
  /** The entry the backlog is reported on; the store's own entry when a caller reports both in one place, as a test does. */
  readonly backgroundHealth?: HealthEntry
  /** The project an experience belongs to: the deployment's repository, when setup resolved one. */
  readonly project: () => string | undefined
  /**
   * Build the stateless evaluator around the service it commits through; absent when the runtime makes no background calls. It is
   * handed the callback that republishes the backlog, because only the composition knows which health entry that is.
   */
  readonly evaluate?: (service: MemoryService, report: () => void) => MemoryBackground
  readonly now?: () => string
}

/** The independent background work the runtime hands the memory: it scores a new experience, condenses one, and can be asked to again. */
export interface MemoryBackground {
  /** Queue the scoring job a new experience starts. Never awaited by the capture that caused it. */
  score(experienceId: string): void
  /** Queue the consolidation of one experience into a short representation, when recall cannot show it whole. Never awaited. */
  compress(experienceId: string): void
  /** Evaluate one experience once more, explicitly; a job that already ran is returned rather than called again. */
  reevaluate(experienceId: string): Promise<JobRecord | undefined>
  /** Condense one experience again, explicitly, as a change of principles or an operator would. */
  condense(experienceId: string): Promise<JobRecord | undefined>
  /** Run one recorded job again, while the version it read is still current. */
  retry(jobId: string): Promise<RetryResult>
  /** Re-evaluate the records a principle or model change left computed under older versions, in bounded pages. */
  sweep(): Promise<SweepResult>
  /** Hold the background work, and let it run again: a paused job waits, and its queued work stays queued. */
  pause(): void
  resume(): void
  /**
   * Look at the queue again because something a pass stopped on has changed — room an operator's reclamation freed, a condition that
   * can now be retried — without waiting for a new event. A held, stopped or already-busy runner does nothing with it.
   */
  wake(): void
  /**
   * Stop the background for the rest of the runtime's life: nothing further is scheduled and a call in flight is waited for, so no
   * job commits after the store has closed.
   */
  stop(): Promise<void>
  /** Settle once every queued job has run, which is how a test observes what the evaluator did. */
  whenIdle(): Promise<void>
  /** Every job the evaluator ran, oldest first: the runtime's own account of calls no Session log records. */
  jobs(): readonly JobRecord[]
  /** What the background is doing and what it has cost, for the health entry an operator reads. */
  backlog(): BackgroundBacklog
}

/**
 * What the memory reports: the published version, the usage and the state of the store, and what became of the newest automatic
 * reactivation — which is how a cue that woke nothing is told apart from a cue that was never a candidate.
 */
export interface MemoryReport extends MemoryStatus {
  readonly wake: WakeState
}
/**
 * What the memory has not accepted yet: the captures waiting in the durable queue, the captures the receiving boundary refused and
 * still holds at its redelivery position, the bound each of them waits under, and how much that bound has cost in permanently lost
 * material. Every figure is measured from what is stored — the queue's own rows and the position's own record — so a restart reports
 * the material it really holds rather than a count this process kept. `refused` is the one operational number, the refusals this
 * runtime made; `redelivery.items` is the durable figure, which is why a position full of outstanding material never reads as zero
 * after a restart. It is the pending half of the capacity contract — the store's files are the other half — and an operator reads all
 * of it on the same health entry instead of querying the database to see whether anything is still growing.
 */
export interface PendingState {
  readonly items: number
  readonly bytes: number
  /** Captures that may wait at once, and the payload bytes they may take: the setting, and the memory budget's pending share. */
  readonly maxItems: number
  readonly maxBytes: number
  /** The redelivery position: what the receiving boundary refused and still holds, its own two bounds, and what they cost. */
  readonly redelivery: RedeliveryState
  /** Everything received and not published — the queue's rows plus the position's — read from the two durable records. */
  readonly notYetAccepted: number
  /**
   * Captures refused at the receiving boundary since this runtime opened, whether they are held at the position above, were offered
   * again and published, or were evicted by its bound. Operational, and it starts again with the runtime, like reclamation's own
   * count; what is outstanding is `redelivery.items`, never this.
   */
  readonly refused: number
  /** Why the last capture was refused, in the terms an operator acts on; absent while none has been. */
  readonly reason?: string
  /**
   * `full` while the receiving boundary would refuse a capture of the size it last refused — the queue holds all it may wait with —
   * and `ready` again once the store has taken what waited. It is computed from the queue's own numbers rather than latched, so a
   * queue freed by the store reads `ready` without a new capture having to happen first.
   */
  readonly state: 'ready' | 'full'
}
/** The bound one capture admission is decided against: how many captures may wait, and how many payload bytes. */
interface PendingLimits { readonly maxItems: number; readonly maxBytes: number }
/** The memory as the runtime, the read resources and the health board use it. */
export interface Memory {
  readonly service: MemoryService
  /**
   * Record the deployment's own boundary check. What it proved decides whether writes run, and the `memory-store` health entry reports
   * which of the two it was; the runtime calls this once setup resolved the world the agent runs in.
   */
  admit(isolation: IsolationReport): void
  /** Record one domain event durably, inside the caller's transaction. Never throws: a capture must not fail a business command. */
  capture(event: DomainEvent): void
  /**
   * The `memory` effect handler: publish the capture, start its scoring job, then reactivate related memory within the budget.
   * `key` is the effect row's own key, which is the experience id the queue coalesces on; a row whose key is some other fact is
   * refused as the corruption it is. What waits for room is counted from the queue itself, not from a set this handler keeps.
   */
  store(input: ExperienceInput, key?: string): Promise<void>
  /** Characters recalled material may take on `sessionId`'s next request: the request budget's room, capped by the setting. */
  allowance(sessionId: string): number
  /** What a read of this Session is filtered by: the project always, and the ticket's task for a worker Session. */
  scope(ticketId?: string): Scope
  /** The retrieve paths behind the read resource, filtered to what `ticketId`'s scope allows. */
  list(ticketId: string | undefined, offset: number, limit: number): ListResult
  expand(ticketId: string | undefined, id: string, allowanceChars: number): ExpandResult
  /** Take back the representation a compression job last committed, through the service's one commit entry. */
  rollback(id: string): RollbackResult
  /** The weight one experience carries and the reason behind it, which is what a surprising recall order is explained with. */
  importance(id: string): Importance | undefined
  /**
   * What the evidence behind one experience supports — the kind of experience it is and the Sources the same claim reached from —
   * which is a separate quantity from its importance, from the correlation one query scored and from where its claim stands.
   */
  confidence(id: string): Confidence | undefined
  /** Settle once the background evaluator has run what it queued. */
  settle(): Promise<void>
  /** Evaluate one experience once more, explicitly, and return the job that did it. */
  reevaluate(id: string): Promise<JobRecord | undefined>
  /** Condense one experience again, explicitly, as a change of principles or an operator would. */
  compress(id: string): Promise<JobRecord | undefined>
  /** Run one recorded background job again, while the version it read is still current. */
  retryJob(jobId: string): Promise<RetryResult>
  /**
   * Re-evaluate the memories a principle or model change left computed under older versions: one incremental sweep of the affected
   * records, in bounded pages, which the runtime also runs once as it starts so a code upgrade catches up without an operator.
   */
  sweep(): Promise<SweepResult>
  /** Hold back the background work, and let it run again; what was queued waits while it is held. */
  pauseBackground(): void
  resumeBackground(): void
  /** Every background job this runtime ran, oldest first. */
  jobs(): readonly JobRecord[]
  /**
   * The material this memory has not accepted yet: what the durable queue holds, against the bound that capture admission is
   * decided by, and how much the receiving boundary refused once that bound was reached. Read from the queue, so a restart answers
   * with what really waits; the same reading is on the `memory-store` health entry.
   */
  pending(): PendingState
  /** What the background is doing and what it has cost: the queue, its deferred plans, the passes and the bounds in force. */
  backlog(): BackgroundBacklog
  /**
   * Free space now, if the store is under storage pressure: the archive's one door, which an operator and any pass of the
   * runtime's own both use. A capture already runs it before it writes, so this is for a caller that wants reclamation to happen
   * on a clock of its own rather than on the next write.
   */
  reclaim(): ReturnType<MemoryService['reclaim']>
  /** The published version, the usage and the state of the store, and what became of the newest reactivation cue. */
  status(): MemoryReport
  /** Stop the background work and close the memory files; a call in flight finishes first, so nothing writes after the close. */
  close(): Promise<void>
}
/** The characters of an event's text that a capture hands the service, and how long the text was. */
const clip = (text: string): { text: string; chars: number } => ({ text: text.length > CAPTURE_MAX_CHARS ? text.slice(0, CAPTURE_MAX_CHARS) : text,
  chars: text.length })
/** The payload bytes one capture takes as the queue stores it, which is the unit the queue's bound and the position's are stated in. */
const payloadBytes = (input: ExperienceInput): number => Buffer.byteLength(JSON.stringify(input), 'utf8')
/**
 * How many reactivation notices one Session may receive in one recall window, and how long that window is, both read from the machine
 * settings on each use. The window is the whole of what "it does not linger" means for a memory that was woken: the notice is an
 * ordinary message in DSH's own log, which nothing here can unsend, so what is bounded is the memory system's own proposing — no
 * experience is pushed twice while its record is unchanged, and a Session is not woken more than `wakes` times in any `windowMs`. What
 * stays in the log is then paged away by the request budget like any other old history, and the allowance itself comes back as the
 * window passes, so automatic recall keeps working for as long as the experiment runs.
 */
export const wakeLimits = (machine: Machine): WakeLimits => ({ wakes: machine.memoryRecallWakes.get(),
  windowMs: machine.memoryRecallWindowMs.get() })
/**
 * The allowance's own sentence for the health entry: what the newest cue became and how much of the window is spent, which is how an
 * operator tells a cue that woke nothing because the allowance was spent from one that matched nothing worth waking.
 */
const wakeLine = (state: WakeState): string => {
  const window = `${state.notices} of ${state.capacity} notices in the last ${state.windowMs} ms`
  const next = state.nextAt === undefined ? '' : `, the next may land at ${state.nextAt}`
  const newest = state.last === undefined ? 'no cue has been evaluated yet' : `newest cue at ${state.last.at}: ${state.last.detail}`
  return `recall: ${newest}; ${window}${next}`
}
/** The limits the machine's settings and the store's fixed numbers make. */
export const memoryLimits = (machine: Machine): MemoryLimits => ({ budgetBytes: machine.memoryBudgetBytes.get(),
  recallMaxChars: machine.memoryRecallMaxChars.get(), ...STORE_DEFAULTS })
/**
 * The bounds the background work runs under, read from the machine settings on each use: a lowered bound applies to the next pass
 * rather than to the next restart, which is what lets an operator hold a backlog less expensive without taking the runtime down.
 */
export const backgroundLimits = (machine: Machine): BackgroundLimits => ({ maxCalls: machine.memoryBackgroundMaxCalls.get(),
  batch: machine.memoryBackgroundBatch.get(), concurrency: machine.memoryBackgroundConcurrency.get(),
  pending: machine.memoryBackgroundPending.get(), timeoutMs: machine.memoryBackgroundTimeoutMs.get(),
  attempts: machine.memoryBackgroundAttempts.get() })
/**
 * Whether long-term memory may be written: a boundary the deployment proved, or the degraded mode its operator chose in the machine
 * configuration. Never a silent default, because writing where an agent's own shell can edit the same files is exactly what the
 * specification refuses to call a single writer — the writer and the shell would be the same account and the same process.
 */
export function writeGate(machine: Machine, isolation: IsolationReport): WriteGate {
  if (isolation.proven) return { open: true, detail: isolation.detail }
  if (machine.memoryWriteMode.get() === 'waive') return { open: true, detail: `writing as memoryWriteMode waives the boundary: ${isolation.detail}` }
  return { open: false, detail: `long-term memory writes are refused while memoryWriteMode requires a boundary: ${isolation.detail}` }
}
/** What the gate says until the deployment has been checked: a write is refused rather than assumed to be safe. */
const UNCHECKED: IsolationReport = { proven: false, gates: [], observed: [],
  detail: 'the deployment has not checked yet whether an agent shell can write the memory files' }

/** What the background of a deployment that makes no background call reports: nothing waiting, and the bounds it would run under. */
const idleBacklog = (limits: BackgroundLimits, policy: string): BackgroundBacklog => ({ paused: false, queued: 0, deferred: 0,
  committed: 0, rejected: 0, failed: 0, skipped: 0, recent: [], continuing: false, passes: [],
  sweep: { planned: 0, remaining: 0, done: true }, versions: { policy, principles: {} }, limits })

/** The sentence an operator acts on when a capture could not wait: the queue holds all it may for a capture of this size. */
const QUEUE_FULL = 'the queue has no room left within its bound for a capture of this size'
/**
 * Whether one more capture may wait in the durable queue, decided before the row is written rather than after the queue is full: it
 * fits both the item and the byte bound, or it replaces the row its own fact already has — a key that waits is not a second capture
 * and the payload replacing it is the same fact, so it is admitted while the queue is inside its bound instead of being counted
 * twice. A capture that does not fit is refused while the fact is still the business's own, never queued for ever behind a store
 * that cannot take it, which is how the waiting material stays finite instead of moving unlimited growth into the business database.
 */
const admitsPending = (usage: QueueOccupancy, cost: number, limits: PendingLimits): boolean => usage.held
  ? usage.items <= limits.maxItems && usage.bytes <= limits.maxBytes
  : usage.items < limits.maxItems && usage.bytes + cost <= limits.maxBytes

/**
 * Build the memory of one runtime: open the store at `<stateDir>/memory`, claim its health entry, and hand the runtime the capture
 * that enqueues a `memory` effect and the reads the resource serves. A broken store degrades to reads only and says so on its health
 * entry rather than stopping the runtime.
 */
export function createMemory(host: MemoryHost): Memory {
  const now = host.now ?? ((): string => new Date().toISOString())
  /** What the deployment's boundary check found. Until it answers, the gate stays shut instead of assuming the files are safe. */
  let isolation = UNCHECKED
  const service = MemoryService.open({ dir: join(host.machine.stateDir, 'memory'), limits: memoryLimits(host.machine), now,
    gate: () => writeGate(host.machine, isolation) })
  const project = (): string | undefined => host.project()
  // The allowance the automatic door runs under, its dedupe and its record of what the newest cue became: a window of notices rather
  // than a count a process spends once, so a restart is a new window and not the only way back.
  const wake = new WakeAllowance(() => wakeLimits(host.machine))
  // What the receiving boundary refused since this runtime opened, and the two facts an operator reads about the last refusal: the
  // sentence naming why, and the payload size it would take to admit one like it again. The material itself is not in either of them:
  // what was refused is kept by the redelivery position below, which is durable, so this count starting again with the runtime takes
  // nothing away from what really waits.
  let refusedCaptures = 0, refusal: string | undefined, refusalCost = 0
  // Captures the store refused outright — a payload that is not a capture, or an id that disagrees with it — which no retry can change.
  // Counted rather than returned in silence, because a fact that will never be remembered is one an operator has to be able to read.
  let failedCaptures = 0
  // Where a capture the receiving boundary refused waits, so it can be offered again once the queue has room: a bounded, persisted
  // list that survives a restart, bounded like the queue itself. Its two bounds are read per use, so a lowered setting applies to the
  // next refusal rather than the next restart.
  const redelivery = new Redelivery(host.position, (): RedeliveryLimits => ({ maxItems: host.machine.memoryRedeliveryMaxItems.get(),
    maxBytes: pendingBytesOf(host.machine.memoryBudgetBytes.get()) }))
  // The runtime builds the evaluator around the service it commits through, so the memory owns the dispatch and the runtime owns
  // the model request. Without one, capture still publishes and recalls; only the scoring job is absent.
  const background = host.evaluate?.(service, () => reportBackground())
  const backlogHealth = host.backgroundHealth ?? host.health

  /**
   * The bound material waiting to be accepted runs under, read on each use: how many captures the machine lets wait, and how many
   * payload bytes the memory budget pays for them. A lowered budget or count therefore applies to the next capture, not the next
   * restart, which is what lets an operator take pressure off the business database without stopping the runtime.
   */
  const pendingLimits = (): PendingLimits => ({ maxItems: host.machine.memoryPendingMaxItems.get(),
    maxBytes: pendingBytesOf(host.machine.memoryBudgetBytes.get()) })
  /** What the durable queue holds now against that bound, which is the answer both health entries and an operator read. */
  const pendingOf = (): PendingState => {
    const limits = pendingLimits(), usage = host.effects.occupancy('memory'), held = redelivery.state()
    // Full means the boundary would refuse a capture of the size it last refused, so the state clears by itself once the store has
    // taken what waited instead of staying set until the next capture happens to be admitted.
    const full = usage.items >= limits.maxItems || usage.bytes + refusalCost > limits.maxBytes
    return { items: usage.items, bytes: usage.bytes, ...limits, redelivery: held, notYetAccepted: usage.items + held.items,
      refused: refusedCaptures, ...(refusal === undefined ? {} : { reason: refusal }), state: full ? 'full' : 'ready' }
  }

  /**
   * Offer the oldest capture the receiving boundary refused back to the durable queue, when the queue would hold it. One capture per
   * call, so capacity a store recovered is used gradually rather than in one burst; and nothing at all while the queue is full, so a
   * refused capture can never turn into a spin. It enters through the same durable row, the same handler and the same commit as a
   * capture that arrived with room, which is the one path any material is published by, and it keeps the experience id it was refused
   * with, so the store answers a redelivery of what it already holds with `duplicate` rather than applying it twice.
   *
   * What it decides on is the queue's own occupancy, with nothing subtracted from it. A delivery asks for this only through the
   * queue's release notification, which is sent after `attempt` deleted the delivered row — the first moment the place and the payload
   * bytes that delivery held are free — and a delivery whose row is still there, because it failed, threw `Later` or was cut short by a
   * shutdown, never asks at all. No figure is therefore discounted for work still in flight: the two areas are each measured against
   * their own bound, and the invariant holds at every moment a reader can observe.
   */
  const reoffer = (): boolean => {
    const next = redelivery.oldest()
    if (next === undefined) return false
    if (!admitsPending(host.effects.occupancy('memory', next.input.id), next.bytes, pendingLimits())) return false
    // The queue row and the record that no longer holds the capture commit together: a crash cannot lose it between the two, and
    // cannot leave it waiting in both places.
    const handed = redelivery.handOver(input => host.effects.enqueue('memory', input.id, input))
    if (handed) report()
    return handed
  }
  // The queue's release of a delivered row is what asks for the next capture, and `close` takes the subscription back so a memory that
  // has stopped serving its queue is never offered anything into it.
  const releaseOffer = host.effects.released('memory', () => { reoffer() })

  /**
   * The one line of health this subsystem reports: the published version, what it takes, whether it still writes, and what became of
   * the newest cue — so a cue that woke nothing reads as the allowance, a duplicate, too little correlation or no room rather than as
   * silence.
   */
  const report = (detail?: string): void => {
    const status = service.status(), { capacity } = status
    // A deployment that writes without a proven boundary says so on every report, so a degraded mode is never a silent one;
    // the mode that admits it is named too, because that is the setting an operator changes to stop or to keep it.
    const degraded = !status.writable || isolation.proven ? '' : '; writing without a proven isolation boundary (memoryWriteMode waives it)'
    // A gate that is still shut because nothing has been checked yet is waiting, not failing: setup has not finished, or has not run.
    const refused = status.state === 'readOnly' ? isolation === UNCHECKED ? 'starting' as const : 'error' as const : undefined
    // What reclamation can still free is part of the capacity state an operator reads: a store that reports pressure and names no
    // candidate is one where a new large original will be kept as its head instead, which is the back-pressure the spec asks for.
    const room = `capacity ${capacity.state}, ${capacity.candidates} originals and ${capacity.reclaimable} bytes reclaimable, `
      + `${capacity.reserve} bytes reserved`
    // The pending half of the same contract, in the four states an operator has to tell apart: what waits for the store against what
    // may wait (received but not yet accepted), what the receiving boundary refused and the position still holds, what that position's
    // bound has cost as a permanent loss, and what failed. It is on every report rather than only on a refusal, so "is it still
    // growing" is answered without querying the database, and what waits and what was refused are worded apart because reading a
    // refusal as material a freed queue will deliver is exactly the mistake the two sentences exist to prevent.
    const pending = memory.pending(), held = pending.redelivery
    const queue = `${pending.items} of ${pending.maxItems} captures and ${pending.bytes} of ${pending.maxBytes} bytes waiting to be `
      + 'accepted, and offered again as the store takes them'
      + `${pending.refused ? `; ${pending.refused} refused at the receiving boundary since this runtime opened${pending.reason === undefined
        ? '' : ` (${pending.reason})`}` : ''}`
      + `${held.items ? `; ${held.items} of ${held.maxItems} held at a redelivery position (${held.bytes} of ${held.maxBytes} bytes) `
        + 'for a later delivery, offered again one at a time as the queue has room' : ''}`
      + `${held.lost ? `; ${held.lost} permanently lost: the oldest were evicted when that position reached its `
        + `${held.maxItems} captures or ${held.maxBytes} bytes` : ''}`
      // A position at its bound is about to cost what it holds, and that is what an operator can still act on before it does: the
      // loss count above only reports an eviction that has already happened.
      + `${held.state === 'full' ? '; that position is at its bound, so the next refusal it can hold evicts the oldest' : ''}`
      + `${failedCaptures ? `; ${failedCaptures} failed` : ''}`
    host.health.set({ state: refused ?? (status.state === 'ready' ? 'ready' : 'paused'),
      detail: `${detail === undefined ? '' : `${detail}; `}version ${status.version}, ${status.experiences} experiences, `
        + `${status.usage.total} of ${status.limits.budgetBytes} bytes, ${room}, ${queue}`
        + `${status.problems.length ? `; ${status.problems.join('; ')}` : ''}${degraded}; ${wakeLine(wake.state(now()))}`,
      at: now() })
  }

  /**
   * The line the backlog is reported on: what was received, what waits for a call, what became of what ran and what the store has not
   * accepted yet — the four states an operator has to be able to tell apart — with the versions the work runs under and what the last
   * pass spent. It is the runtime's own state, so a held background, a stalled call and a store that refuses every commit each read as
   * themselves rather than as silence.
   */
  function reportBackground(): void {
    // A caller that makes no background call and claimed no entry for one reports nothing here, rather than overwriting the store's.
    if (host.backgroundHealth === undefined && background === undefined) return
    const status = service.status()
    const work = background?.backlog() ?? idleBacklog(backgroundLimits(host.machine), service.policyVersion)
    const last = work.passes.at(-1), newest = work.recent.at(-1)
    // What the last pass did and what happens next: a runner that stopped with work left and has the next round scheduled says so,
    // because such a queue is moving on its own initiative rather than stuck, and an operator must not read one as the other.
    const spend = (last === undefined ? 'no pass yet'
      : `last pass ran ${last.ran} jobs and made ${last.calls} calls${last.stopped === undefined ? '' : ` then stopped for ${last.stopped}`}`)
      + `${work.continuing ? ', next pass scheduled' : ''}`
    const principles = Object.entries(work.versions.principles).map(([kind, version]) => `${kind} ${version}`).join(', ')
    const failure = newest === undefined || newest.status === 'committed' ? '' : `; newest job ${newest.status}: ${newest.detail}`
    // A backlog nobody can move is a problem, not a queue: the newest call that got nothing back, or a pass the store stopped for want
    // of room, is what an operator has to act on. Either is cleared by the next pass that commits, so this is a state and not a latch.
    const state = newest?.status === 'failed' ? 'error' as const
      : last?.stopped === 'capacity' ? 'error' as const
        : work.paused ? 'paused' as const : 'ready' as const
    backlogHealth.set({ state, detail: `${work.paused ? 'held' : 'running'}, ${status.experiences} received, ${work.queued} of `
      + `${work.limits.pending} queued, ${work.deferred} deferred, ${pendingOf().notYetAccepted} not yet accepted, ${work.committed} committed, `
      + `${work.rejected} rejected, ${work.failed} failed; ${spend}; versions ${principles}, policy ${work.versions.policy}, `
      + `model ${work.versions.model ?? 'none yet'}; sweep ${work.sweep.planned} planned, ${work.sweep.remaining} to look at${failure}`, at: now() })
  }

  /** The scope of a read or a capture: the project always, and a ticket's task when the caller is that ticket's worker. */
  const scope = (ticketId?: string): Scope => {
    const repository = project()
    return { ...(repository === undefined ? {} : { project: repository }), ...(ticketId === undefined ? {} : { task: ticketId }) }
  }

  /** Assemble one capture: the fact, its identity, its scope and the source references, all fixed at the instant it happened. */
  const input = (event: DomainEvent, parts: { primary: string; occurredAt: string; source: string; subject?: string; scope: Scope;
    kind: ExperienceKind; text: string; url?: string; ids: Record<string, string> }): ExperienceInput => {
    const id = experienceId(event.type, parts.primary, event.at)
    return { id, opId: opIdOf(id), occurredAt: parts.occurredAt, recordedAt: event.at, source: parts.source,
      ...(parts.subject === undefined ? {} : { subject: parts.subject }), scope: parts.scope, kind: parts.kind,
      material: clip(parts.text), origin: { event: event.type, at: event.at, primary: parts.primary, ids: parts.ids,
        ...(parts.url === undefined ? {} : { url: parts.url }) } }
  }

  /** The source kind of a ticket's origin, which the ticket's facts are attributed to. */
  const sourceOfTicket = (ticketId: string): string => {
    const ticket = host.records.tickets.get(ticketId)
    return (ticket && host.records.triggers.get(ticket.origin.triggerId)?.source) ?? 'runtime'
  }

  /** The facts worth keeping: what a person said or what reached the agent, and the lifecycle of the work they led to. */
  const inputOf = (event: DomainEvent): ExperienceInput | undefined => {
    switch (event.type) {
      case 'trigger.received': {
        const trigger = host.records.triggers.get(event.data.triggerId)
        // Only what a person wrote, or what addressed the agent, is a fact about the world; bookkeeping and bot noise are not.
        if (!trigger || (!trigger.human && trigger.addressed === undefined)) return undefined
        const task = (host.records.triggers.disposition(trigger.id)?.fanout ?? [])
        return input(event, { primary: trigger.id, occurredAt: trigger.at, source: trigger.source, subject: trigger.actor.id,
          scope: { ...scope(task.length === 1 ? task[0] : undefined), person: trigger.actor.id }, kind: 'observation', text: trigger.text,
          ...(trigger.url === undefined ? {} : { url: trigger.url }),
          ids: { triggerId: trigger.id, threads: trigger.threads.map(threadKey).join(' '), actor: trigger.actor.id,
            ...(task.length === 1 ? { ticket: task[0]! } : {}) } })
      }
      case 'ticket.created': {
        const ticket = host.records.tickets.get(event.data.ticketId)
        if (!ticket) return undefined
        const basis = ticket.mandate.basis
        return input(event, { primary: ticket.id, occurredAt: ticket.createdAt, source: sourceOfTicket(ticket.id), subject: ticket.title,
          scope: { ...scope(ticket.id), ...(ticket.mandate.actor?.id === undefined ? {} : { person: ticket.mandate.actor.id }) },
          kind: 'statement', text: `${ticket.title} — accepted as work (${ticket.mandate.strength} mandate, via ${basis.via})`,
          ids: { ticketId: ticket.id, decisionId: event.data.decisionId, strength: event.data.strength } })
      }
      case 'ticket.resumed': {
        const ticket = host.records.tickets.get(event.data.ticketId), trigger = host.records.triggers.get(event.data.triggerId)
        if (!ticket) return undefined
        return input(event, { primary: ticket.id, occurredAt: trigger?.at ?? event.at, source: sourceOfTicket(ticket.id), subject: ticket.title,
          scope: scope(ticket.id), kind: 'statement', text: `${ticket.title} — resumed: ${trigger?.text ?? ''}`,
          ids: { ticketId: ticket.id, triggerId: event.data.triggerId } })
      }
      case 'ticket.ended': {
        const ticket = host.records.tickets.get(event.data.ticketId)
        if (!ticket) return undefined
        const report = latestReport(ticket)?.summary
        return input(event, { primary: ticket.id, occurredAt: ticket.ended?.at ?? event.at, source: sourceOfTicket(ticket.id),
          subject: ticket.title, scope: scope(ticket.id), kind: 'observation',
          text: `${ticket.title} — ended ${event.data.outcome}${event.data.reason === undefined ? '' : ` (${event.data.reason})`}: ${report ?? ''}`,
          ids: { ticketId: ticket.id, outcome: event.data.outcome, by: event.data.by } })
      }
      case 'policy.changed':
        return input(event, { primary: `${event.data.from}->${event.data.to}`, occurredAt: event.at, source: 'runtime',
          scope: scope(), kind: 'statement', text: `the policy changed from ${event.data.from} to ${event.data.to}`,
          ids: { from: event.data.from, to: event.data.to } })
      default:
        // A Decision is reconstructible from its Thread and Ticket, an Eval is bookkeeping, and Assignments are inside the ticket's
        // own report. Recording them would put the same bytes into the next request twice without saying anything new.
        return undefined
    }
  }

  const memory: Memory = {
    service,
    // The deployment's boundary check also says the world the store writes into is settled, which is the second of the two moments a
    // startup offers what was refused back: the composition itself is the first, and a deployment that never calls this still recovers.
    admit(next) { isolation = next; report(); reoffer() },
    capture(event) {
      try {
        const captured = inputOf(event)
        if (!captured) return
        // What this capture would cost the queue, measured as the payload it is, and whether the queue may hold it at all. The
        // decision is taken here, before the row is written, so material the memory cannot accept is refused while the fact is still
        // the business's own: one synchronous read of the queue and one write make the check and the enqueue atomic with each other.
        const bounds = pendingLimits(), cost = payloadBytes(captured)
        if (!admitsPending(host.effects.occupancy('memory', captured.id), cost, bounds)) {
          refusedCaptures += 1; refusal = QUEUE_FULL; refusalCost = cost
          // Not dropped: the exact payload is kept in the durable redelivery position, inside this transaction, so it is offered
          // again when the queue has room and survives a restart like the fact it came from. The position has its own bound, and what
          // that bound costs is counted as lost instead of disappearing in silence.
          redelivery.refuse(captured, cost, event.at)
          report(`a capture of ${event.type} was refused at the receiving boundary`)
          // What is not yet accepted changed with this refusal, so the entry that reports that figure is refreshed with it.
          reportBackground()
          return
        }
        // The queue row commits inside the Engine's transaction: the intent to remember is durable exactly when the fact is, and the
        // queue re-dispatches it after a restart. `kick()` defers dispatch to a microtask, which cannot run before the commit.
        host.effects.enqueue('memory', captured.id, captured)
      } catch (error) {
        host.health.set({ state: 'error', detail: `a capture of ${event.type} could not be queued: ${String(error)}`, at: now() })
      }
    },
    async store(input: ExperienceInput, key?: string) {
      // The queue coalesces by key, which is the experience's own id: a row whose key names another fact would merge two experiences on
      // the next redelivery, so it is refused as the corruption it is rather than published under a key that is not its own.
      if (key !== undefined && key !== input.id) {
        failedCaptures += 1
        report(`a capture row was refused: its key ${key} is not the experience it carries`)
        return
      }
      const result = service.submit(input)
      if (result.status === 'backpressured') {
        // Received but not accepted: the fact is the durable queue row that will run this handler again, which is what the queue's
        // own occupancy reports — it is not a silent loss and not an error either.
        report('the store is full, so the capture waits')
        reportBackground()
        // Back-pressure, not failure: `Later` reschedules without counting attempts, so the fact stays queued in SQLite.
        throw new Later()
      }
      if (result.status === 'rejected') {
        // A refusal no retry can change settles the row here, and a fact that will never be remembered must not read as silence; the
        // two an operator can clear keep the row queued for the next attempt and are reported as the failure they are.
        const final = result.reason !== 'readOnly' && result.reason !== 'noIsolation'
        if (final) failedCaptures += 1
        // The refusal is reported where an operator reads it — the `memory-store` entry — whichever of the two conditions failed,
        // so a gate that a live setting change closed shows up on the next capture rather than at the next successful one.
        report(`a capture was refused (${result.reason})`)
        if (result.reason === 'readOnly') throw new Error('The memory store is read-only; the capture stays queued')
        // No boundary keeps a shell out of these files, so nothing is published until an operator establishes one or waives the
        // requirement: the failure counts toward the effect's health and the capture stays queued rather than being written anyway.
        if (result.reason === 'noIsolation') throw new Error(isolation.detail)
        // A corrupted row is not retried forever: the fact is already published or cannot be trusted, and health says which.
        reportBackground()
        return
      }
      report()
      reportBackground()
      // The capture the receiving boundary refused is offered back when the queue really deletes this row, which `attempt` does only
      // after this handler returns: asking here would spend a place the row itself still holds, so no delivery offers anything.
      // The independent evaluation of what was just recorded: queued, never awaited, so a slow model delays no capture and no
      // ticket. Only a capture that published something new starts one — a redelivery of what is already held changes no fact and
      // must not spend a second model call on the same evidence. Its commit goes through the service like any other, and a failure
      // leaves the record's rule-only weight in place. The consolidation of the same experience is queued behind it, and a job that
      // is refused as stale changes nothing: the record keeps the representation it had.
      if (result.status === 'created') {
        background?.score(input.id)
        background?.compress(input.id)
        // A fact that changed what is believed re-consolidates exactly the records whose standing moved — the ones the service named
        // back — and nothing else: history is not rescanned, and a record the new evidence did not touch keeps the gist it had.
        for (const affected of result.revised ?? []) background?.compress(affected)
      }
      await reactivate(input)
      // What the cue became is part of what this entry reports, so the next read of it says why nothing woke rather than saying nothing.
      report()
    },
    allowance(sessionId) {
      // The request budget's own answer, capped by the setting that keeps one notice small: recall is a candidate for the context,
      // never a claim on it, so it takes what is left and nothing more.
      return Math.max(0, Math.min(memoryLimits(host.machine).recallMaxChars, host.room(sessionId)))
    },
    scope,
    list(ticketId, offset, limit) { return service.list({ scope: scope(ticketId), offset, limit }) },
    expand(ticketId, id, allowanceChars) {
      // A worker may only expand what its own scope holds, so an id from another project or ticket is unknown to it.
      if (!service.holds(id, scope(ticketId))) return { status: 'unknown', id }
      return service.expand({ id, allowanceChars })
    },
    rollback(id) { return service.rollback(id) },
    status() { return { ...service.status(), wake: wake.state(now()) } },
    reclaim() {
      // The archive's one door, and the report after it: a pass that freed something changed the capacity state health names.
      const result = service.reclaim()
      if (result.freed > 0 || result.evicted > 0) {
        report()
        // Room an operator's reclamation made is what a pass stopped for capacity was waiting for, so this is the explicit entrance
        // that resumes the queue: the runner does not poll a full store, and nothing else about this call would wake it.
        background?.wake()
        // The same room is what a capture the receiving boundary refused needs, so the released-capacity wake offers one back.
        reoffer()
      }
      return result
    },
    importance(id) { return service.importance(id) },
    confidence(id) { return service.confidence(id) },
    settle() { return background?.whenIdle() ?? Promise.resolve() },
    reevaluate(id) { return background?.reevaluate(id) ?? Promise.resolve(undefined) },
    compress(id) { return background?.condense(id) ?? Promise.resolve(undefined) },
    retryJob(jobId) { return background?.retry(jobId) ?? Promise.resolve({ status: 'unknown' as const, id: jobId }) },
    sweep() { return background?.sweep() ?? Promise.resolve({ planned: 0, remaining: 0, done: true }) },
    pauseBackground() { background?.pause() },
    resumeBackground() { background?.resume() },
    jobs() { return background?.jobs() ?? [] },
    pending() { return pendingOf() },
    backlog() { return background?.backlog() ?? idleBacklog(backgroundLimits(host.machine), service.policyVersion) },
    // The scheduled rounds are taken back before the store closes, and a call in flight is waited for: what a job already earned
    // commits while the files are open, and nothing reaches a closed store. What still waited is durable as the experiences
    // themselves, so the next start's sweep plans it again rather than the queue being lost with the process.
    async close() { releaseOffer(); await background?.stop(); service.close() },
  }
  // Both entries are reported once at construction and on every change after it. They read the queue through `memory.pending()`,
  // which is the same reading an operator and a test get, so the published state has one implementation rather than a second one.
  report()
  reportBackground()
  // Startup, the first of the moments a refused capture is offered again: what the last runtime refused is still in the durable
  // position, and a queue with room at this one takes it. `admit` is the second startup moment, for a deployment that gates writes on
  // a boundary check the composition cannot make; a row the queue really releases is the third, and it runs all the while the runtime
  // does, one capture per release.
  reoffer()

  /**
   * Automatic reactivation: when a new experience shares strong enough cues with older ones in the same project, deliver them as
   * labelled background context, cut to what the request budget has room for. Nothing is delivered when no cue is strong enough, so
   * a routine capture does not interrupt a model; the threshold and the rung a woken experience is read at are the numeric policy's
   * own, and a capture is the only thing that schedules one.
   *
   * A wake does not linger, as far as a memory that hands the model a message can promise it. The message itself is DSH's to keep:
   * it is an ordinary log entry, delivered once and never unsent, so it stays in every later request until the request budget's
   * pager moves that history out — which is the only removal there is. What this composition bounds is its own proposing: an
   * experience whose record has not changed since it was pushed is not pushed again, and the notices one Session receives are held to
   * the window's allowance rather than to a count that never comes back. Every cue that woke nothing leaves a sentence on the status,
   * naming which of the four reasons held it: the allowance, a duplicate, too little correlation, or no room in the request.
   */
  async function reactivate(captured: ExperienceInput): Promise<void> {
    const at = now()
    const cues = cuesOf(service.cuesOf(captured.id))
    if (!cues.length) return wake.note(at, 'no-cue', 'it shares no cue with anything stored, so no experience was a candidate')
    // The allowance is asked before anything is matched: a spent window costs no retrieval and no model call, and it comes back on the
    // clock rather than on a restart.
    const held = wake.held(at)
    if (held !== undefined) return wake.note(at, 'quota', held)
    const allowance = memory.allowance(host.masterId)
    if (allowance <= 0) {
      return wake.note(at, 'no-room', 'it was not pushed: the next request of the main Session leaves no room for recalled material')
    }
    const recalled: RecallResult = service.reactivate({ scope: projectScope(), cues, exclude: [captured.id], allowanceChars: allowance })
    if (!recalled.items.length) {
      return wake.note(at, 'weak', `it woke nothing: a wake needs at least ${REACTIVATION_MIN_CUES} shared cues and a `
        + `${MEMORY_POLICY.recallThreshold} correlation in the cue's own words, and this one reached neither`)
    }
    // What this Session was already woken with, at the version its record still holds: the same experience is shown once, and a
    // record a later write changed — a new gist, a newer weight — may be shown again rather than kept frozen at its first reading.
    const fresh = recalled.items.filter(item => !wake.shown(item.id, service.record(item.id)?.version ?? 0, at))
    if (!fresh.length) {
      // The record has not changed since this Session was shown it, so this wake would be a second copy of context the model already has.
      return wake.note(at, 'duplicate', `it matched ${recalled.items.length} `
        + `${recalled.items.length === 1 ? 'experience' : 'experiences'} this Session was already shown, and nothing about them changed`)
    }
    const text = noticeOf({ ...recalled, items: fresh }, allowance)
    if (text === undefined) {
      return wake.note(at, 'no-room', `it was not pushed: the notice it earned does not fit the ${allowance} characters the request leaves`)
    }
    try {
      await host.deliver(recallIdOf(captured.id), text)
    } catch (error) {
      // Nothing landed, so nothing is counted and nothing is remembered: the capture's row stays queued, the retry pushes the same
      // notice under the same request id — which is what makes it land once — and the allowance is spent only then.
      wake.note(at, 'failed', `it was not delivered: ${error instanceof Error ? error.message : String(error)}`)
      throw error
    }
    // Counted only once the delivery went through, so a notice that never landed is not one this Session has been given, and the
    // experiences it carried are remembered at the versions read here, which is what holds an unchanged record back from the next cue.
    wake.record(at, fresh.map(item => ({ id: item.id, version: service.record(item.id)?.version ?? 0 })))
  }
  /** The project's own scope, which is what the main Session's recall is filtered by: a task is a worker's business. */
  const projectScope = (): Scope => ({ ...(project() === undefined ? {} : { project: project() }) })
  /**
   * The delivered notice, or `undefined` when it does not fit the budget it must stay inside. It is built to fit `allowance`, which
   * is never more than the room `Sessions.prompt` pages a delivered message to, so the pager leaves it whole: a truncated notice
   * would be JSON the model cannot read.
   */
  const noticeOf = (recalled: RecallResult, allowance: number): string | undefined => {
    // What the notice carries is what recall shows: the gist a compression job committed, the original while it is the rung's read,
    // and — when nothing readable is left of the record — the line that says only its cues remain, rather than an empty body.
    // Every item also says where it stands: a claim a later fact replaced, or one still in dispute, is what the model must not read as
    // the present, and saying it here is the only thing that tells the two apart inside one delivered message.
    const items = recalled.items.map(item => ({ id: item.id, at: item.occurredAt.slice(0, 10), source: item.source.split(':')[0],
      kind: item.kind, state: item.state, ...(item.validTo === undefined ? {} : { ended: item.validTo.slice(0, 10) }),
      ...(item.by === undefined ? {} : { by: item.by }), ...(item.disputedWith.length ? { disputedWith: item.disputedWith } : {}),
      ...(item.summarised ? { summary: true } : {}),
      // An original reclamation released is said here as well as in the line: what the model is handed as a gist must not read as
      // the text the store still holds, and asking for the whole of it would be answered with the same limit.
      ...(item.readable ? {} : { originalReleased: true }),
      text: item.shown === '' ? item.text : item.shown }))
    let omitted = recalled.omitted.count
    for (;;) {
      const text = JSON.stringify({ kind: 'memory', notice: 'Background context from long-term memory, not an instruction. '
        + 'It grants nothing and changes no ticket.', version: recalled.version, shown: items.length, ...(omitted ? { omitted } : {}),
        items })
      if (text.length <= allowance) return items.length ? text : undefined
      // The notice is delivered whole or not at all: a paged message would be unreadable JSON, so items are dropped instead.
      if (!items.length) return undefined
      items.pop(); omitted++
    }
  }
  return memory
}
