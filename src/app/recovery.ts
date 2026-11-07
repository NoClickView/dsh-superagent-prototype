/**
 * Bounded recovery of a Session whose history is over the model input budget: the graded compaction steps that restore it, the
 * states a reader can distinguish, and the Session title that is deferred or skipped rather than sent over the limit.
 */
import { budgetOf, measureSurfaceEvents, totalOf, validPolicy, type RequestBudget, type RequestParts, type RequestRecord } from './budget.ts'

/**
 * Why this module exists. The runtime's model-request boundary (`src/app/budget.ts`) can only send or refuse a request: a request
 * arrives assembled and deep frozen, so the one thing that cannot be done there is make it smaller. Sending an oversized
 * compaction call anyway was the old recovery exemption, and it traded boundedness for liveness — the call that exists to shrink a
 * history was allowed to break the limit it exists to respect. This module gives the liveness back with bounded work instead.
 *
 * It drives DSH's own compaction over *one balanced surface range per step*, chosen so that the summarization request that range
 * implies fits the same budget every other request is held to. The step's request is measured by the ordinary boundary, so a step
 * whose estimate was optimistic is refused like any other request and reaches no adapter; the module then learns the real size of
 * what a step carries beyond the range it selected, and retries smaller. Nothing about a step is guessed twice: the first refusal
 * measures the gap, and the next choice is made from it. When even the smallest step cannot fit, the Session is paused with the
 * reason and nothing is sent.
 *
 * What survives is DSH's own compaction protocol. Each step is a durable `compaction/start` … `compaction/end` bracket whose only
 * surface effect is the replacement appended between them, so a failed, refused or interrupted step leaves the history exactly as it
 * was and a retry re-derives its range from the current surface. A committed range is gone from the surface, so a retry cannot
 * commit the same product twice, and the tool-call pairing DSH validates at both edges of a range is what keeps a call and its
 * results on the same side of the line.
 */

/** One event of a Session's log, as bounded recovery reads it: what it is, what it contributes, and the sequence that names it. */
export interface RecoveryEvent { readonly type: string; readonly data: unknown; readonly seq?: number }

/** The Session a recovery compacts: its append-only log, and the model-visible surface DSH derives from that log. */
export interface RecoverySession {
  snapshotEvents(): readonly RecoveryEvent[]
  /** The surface nodes, in model-visible order; absent only for a Session that reports no surface at all. */
  readonly surface?: { readonly nodes: readonly number[] }
}

/** The parts of a DSH agent bounded recovery reads: its identity, its Session, and the services the Session's preset mounts. */
export interface RecoveryAgent {
  readonly id: string
  readonly session: RecoverySession
  readonly ctx: { get(name: string): unknown }
}

/** DSH's compaction backend, as the runtime drives it: one balanced surface range replaced by a summary of itself. */
export interface CompactionBackend {
  compactRegion(start: number, end: number, agent: unknown, signal?: AbortSignal): Promise<unknown>
}

/** DSH's title service, as the runtime retries a deferred title through it once its Session fits again. */
export interface TitleBackend { refresh(session: unknown, signal?: AbortSignal): Promise<unknown> }

/** How far a Session's recovery has got: the runtime is compacting it, it fits again, or it cannot be repaired at this budget. */
export type RecoveryState = 'recovering' | 'recovered' | 'paused'

/** What the runtime did, or is doing, about one Session whose history is over its input budget. */
export interface RecoveryReport {
  readonly sessionId: string
  readonly state: RecoveryState
  /** Compaction steps that committed a replacement; each was a model request this runtime measured and let through only because it fitted. */
  readonly steps: number
  /** Characters of model-visible history when this recovery started, and when it settled. */
  readonly before: number
  readonly after: number
  /** Why the Session is paused: an unusable budget, a step nothing can shrink enough, or an interrupted recovery. */
  readonly reason?: string
  readonly at: string
}

/** How one Session's title stands: the budget deferred it, it was skipped with its reason, or a later retry produced one. */
export interface TitleReport {
  readonly state: 'deferred' | 'skipped' | 'sent'
  readonly reason: string
  readonly attempts: number
  readonly at: string
}

/**
 * The members of the request budget bounded recovery reads, and no others: the policy in force, the plan it makes for a set of parts,
 * the last request it recorded, the requests it recorded for a Session, and the tool definitions a Session's route declares. Narrow
 * on purpose — recovery fits compaction steps to the same budget every request is held to, and it must not reach past measuring and
 * reading records: the typecheck is what keeps an accidental dependency on the rest of the budget out of this module.
 */
export type RecoveryBudget = Pick<RequestBudget, 'policy' | 'plan' | 'last' | 'requestsOf' | 'definitionsOf'>

/** What bounded recovery needs: the budget it fits every step to, the Sessions it may reach, and the clock its reports carry. */
export interface RecoveryHost {
  readonly budget: RecoveryBudget
  readonly agentOf: (sessionId: string) => RecoveryAgent | undefined
  /** The clock the reports are stamped with; the test suite replaces it only where a report carries time. */
  readonly now?: () => string
}

/** Compaction steps one recovery may commit: bounded work rather than a loop until the history ends, and it pauses only if it is still over. */
const MAX_STEPS = 8
/** Ranges one step may try before the material it has to carry is judged unable to fit the budget. */
const MAX_ATTEMPTS = 4

/** One model-visible node of a Session's surface: its sequence, the event it is, the characters it takes and the calls it makes. */
interface SurfaceNode { readonly seq: number; readonly type: string; readonly chars: number; readonly calls: number }

/** One range a step could compact: the inclusive surface sequences it names, and the characters they take. */
interface ChosenRange { readonly start: number; readonly end: number; readonly chars: number }

/** What one Session's surface measures now: its parts, what the budget plans for them, and the nodes a step may compact. */
interface MeasuredSurface { readonly parts: RequestParts; readonly plan: ReturnType<RecoveryBudget['plan']>; readonly nodes: readonly SurfaceNode[] }

/** The characters of a Session's history: what compaction can reduce, as opposed to the prompt and the tool declarations. */
const historyOf = (parts: RequestParts): number => parts.history + parts.toolResults
/** The characters a request needs whatever its history is: the system prompt, the tool definitions, the state and the recall. */
const overheadOf = (parts: RequestParts): number => parts.system + parts.tools + parts.state + parts.recall
/** The text of an error, as a paused report quotes it. */
const textOf = (error: unknown): string => error instanceof Error ? error.message : String(error)
/**
 * Why a refusal is one compacting a Session's history cannot repair, in the terms an operator acts on: the final size of the
 * request could not be established, the parts every request carries are over on their own, or the budget cannot be used at all.
 * Callers only ask this of a record that is paused for one of those reasons, so no recovery is ever claimed for a Session that the
 * next request would refuse again.
 */
const causeOf = (record: RequestRecord): string => record.reason === 'unmeasured'
  ? `its final size could not be established (${record.unmeasured === 'fileProjection'
    ? 'it carries a file whose model-visible text only the adapter dispatch can resolve'
    : 'the model route it would be sent on could not be resolved'}), and compacting the history cannot make a request nobody can`
    + ' measure fit'
  : record.reason === 'requiredOverBudget'
    ? 'its required parts alone are over the budget: compacting the history cannot shrink the prompt or the tool declarations this'
      + ' Session must send'
    : 'the input budget is not configured usefully, so neither a request nor a compaction step can be measured'
/** The tool-call blocks one event's assistant message carries, which the range edges must keep paired with their results. */
function callsOf(event: RecoveryEvent): number {
  if (event.type !== 'assistant/message') return 0
  const content = (event.data as { message?: { content?: unknown } } | undefined)?.message?.content
  return Array.isArray(content) ? content.filter(block => (block as { type?: unknown }).type === 'tool-call').length : 0
}

/**
 * Restores a Session whose history is over its input budget by compacting that history in bounded steps, and reports where each
 * Session stands so a reader can tell a Session being recovered, one that has fitted again, and one that cannot be repaired at the
 * budget in force. It owns no model call of its own: every step is DSH's compaction backend asking for a summary, and that request
 * passes the ordinary boundary (`Sessions.streamed`) which measures it and refuses it when it does not fit.
 */
export class SessionRecovery {
  private readonly reports = new Map<string, RecoveryReport>()
  private readonly running = new Map<string, Promise<RecoveryReport>>()
  private readonly titles = new Map<string, TitleReport>()
  /** The deferred title retries this class has started, so a caller publishing state can wait for them. */
  private readonly titlesRunning = new Set<Promise<void>>()
  constructor(private readonly host: RecoveryHost) {}

  /** Where `sessionId`'s recovery stands, or `undefined` when it was never over its budget. */
  report(sessionId: string): RecoveryReport | undefined { return this.reports.get(sessionId) }
  /** How `sessionId`'s title stands, or `undefined` when the budget never refused one. */
  titleOf(sessionId: string): TitleReport | undefined { return this.titles.get(sessionId) }

  /**
   * Recover `sessionId` now, or join the recovery already running: the operation is idempotent per Session, because two overlapping
   * recoveries would select ranges from the same surface and one of them would commit over the other's work. `signal` is the
   * cancellation of the request that discovered the overflow, so a cancelled turn stops its recovery rather than compacting a
   * Session nobody is waiting for.
   */
  recover(sessionId: string, signal?: AbortSignal): Promise<RecoveryReport> {
    const running = this.running.get(sessionId)
    if (running !== undefined) return running
    const work = this.run(sessionId, signal)
    this.running.set(sessionId, work)
    return work.finally(() => { if (this.running.get(sessionId) === work) this.running.delete(sessionId) })
  }

  /** Wait for the recovery of `sessionId`, or for every recovery and deferred title retry this class started. */
  async settled(sessionId?: string): Promise<void> {
    const running = sessionId === undefined ? [...this.running.values()] : [this.running.get(sessionId)]
    await Promise.all(running.filter((work): work is Promise<RecoveryReport> => work !== undefined))
    await Promise.all([...this.titlesRunning])
  }

  /**
   * Record what a refused request means for the Session it belongs to. A refused compaction call leaves the Session paused — the
   * backend's own transaction does not commit, so there is nothing to reset — unless this runtime's bounded recovery is the one
   * making it, in which case the recovery loop reads the refusal itself. A refused title call is deferred or skipped with its reason,
   * and never holds up the work of the Session: nothing waits on a title, so a recovery in flight does not silence it either.
   */
  refused(record: RequestRecord): void {
    const sessionId = record.sessionId
    if (sessionId === undefined) return
    // A title is recorded whatever else the Session is doing: a recovery holds the history, never the title's own state, and a title
    // the budget could not carry while the history was being compacted is exactly the deferral a reader has to be able to see.
    if (record.purpose === 'session-title') { this.titleRefused(sessionId, record); return }
    // A recovery in flight is the authority on its own Session's report, and a compaction refusal is the step it is reading.
    if (this.running.has(sessionId)) return
    if (record.purpose !== 'compaction') return
    const current = this.reports.get(sessionId)
    const before = current?.before ?? historyOf(record.parts)
    this.reports.set(sessionId, { sessionId, state: 'paused', steps: current?.steps ?? 0, before, after: historyOf(record.parts),
      reason: `the compaction call itself was over the budget (${record.total} of ${record.budget} characters), so the Session waits for a`
        + ' bounded recovery rather than sending it', at: this.at() })
  }

  /** The one place the reports take their time from. */
  private at(): string { return (this.host.now ?? (() => new Date().toISOString()))() }

  /**
   * Record what a refusal that compacting the Session's history cannot repair means for it: the Session is paused with the cause the
   * record holds, and nothing is claimed recovered. Recovery is only worth running when the room the request was short of is
   * history — a request whose final size could not be established, whose required parts are over on their own, or one under an
   * unusable budget is refused again however much history is compacted, and reporting such a Session recovered with no step taken
   * was a success that never happened.
   */
  unrepairable(sessionId: string, record: RequestRecord): RecoveryReport {
    const current = this.reports.get(sessionId)
    // A step an earlier recovery committed is not undone by this refusal, so the report keeps counting it; what it adds is the pause.
    const report: RecoveryReport = { sessionId, state: 'paused', steps: current?.steps ?? 0, before: current?.before ?? historyOf(record.parts),
      after: historyOf(record.parts), reason: causeOf(record), at: this.at() }
    // A recovery in flight is the authority on its own Session: its report stands, and this one explains the refusal beside it.
    if (!this.running.has(sessionId)) this.reports.set(sessionId, report)
    return report
  }

  /**
   * One bounded recovery: measure, compact one range, measure again, until the Session fits, the material runs out, or the step
   * counter ends. Every path writes a report, so a caller never mistakes a Session that was never touched for one that recovered.
   */
  private async run(sessionId: string, signal?: AbortSignal): Promise<RecoveryReport> {
    const agent = this.host.agentOf(sessionId)
    const policy = this.host.budget.policy()
    const initial = agent === undefined ? undefined : this.measure(sessionId, agent)
    const before = initial === undefined ? 0 : historyOf(initial.parts)
    const settle = (state: RecoveryState, steps: number, reason?: string): RecoveryReport => {
      const after = state === 'recovering' || agent === undefined ? before : historyOf(this.measure(sessionId, agent).parts)
      const report: RecoveryReport = { sessionId, state, steps, before, after, ...(reason === undefined ? {} : { reason }), at: this.at() }
      this.reports.set(sessionId, report)
      return report
    }
    this.reports.set(sessionId, { sessionId, state: 'recovering', steps: 0, before, after: before, at: this.at() })
    if (!validPolicy(policy))
      return settle('paused', 0, 'the input budget is not configured usefully, so neither a request nor a compaction step can be measured')
    if (agent === undefined) return settle('paused', 0, 'the Session is not loaded, so its history cannot be compacted')
    if (signal?.aborted) return settle('paused', 0, 'interrupted before the first step: the request that found the overflow was cancelled')
    // Nothing was compacted, so no recovery is claimed: this runtime measures the surface it can see, and a request refused while
    // that surface fits was short of something a committed replacement would not have refunded.
    if (initial!.plan.action === 'send')
      return settle('paused', 0, 'nothing was compacted: what this runtime can measure of the Session already fits the budget, so the'
        + ' refused request was not short of history it could shrink')
    if (initial!.plan.reason === 'requiredOverBudget')
      return settle('paused', 0, 'its required parts alone are over the budget: compacting the history cannot shrink the prompt or the'
        + ' tool declarations this Session must send')
    const backend = compactionOf(agent)
    if (backend === undefined)
      return settle('paused', 0, "DSH's compaction service is not reachable from this Session, so its history cannot be compacted in steps")

    let extra = 0, steps = 0
    // The loop decides on a fresh measurement each time, including the one after the last step the budget allows: a step that made the
    // Session fit recovered it, and reporting it paused because the counter ended said the opposite of what the surface says — which
    // also left the Session title it deferred unretried, waiting for a recovery that had already happened.
    while (true) {
      if (signal?.aborted)
        return settle('paused', steps, `interrupted after ${steps} step(s): the request that found the overflow was cancelled`)
      const now = this.measure(sessionId, agent)
      if (now.plan.action === 'send') return this.recovered(agent, settle, steps)
      if (now.plan.reason === 'requiredOverBudget')
        return settle('paused', steps, 'its required parts alone are over the budget: what is left of the history cannot make it fit')
      if (now.plan.reason === 'invalidConfig')
        return settle('paused', steps, 'the input budget is not configured usefully, so no step can be measured')
      if (steps >= MAX_STEPS) return settle('paused', steps, `after ${steps} compaction steps the Session is still over its budget`)
      // Room a step's range may take: the budget less what every request carries anyway, less what the first refused step measured
      // beyond the range it selected (the summarization instruction, and anything else only DSH's own request assembles).
      const budget = budgetOf(this.host.budget.policy())
      const room = budget - overheadOf(now.parts) - extra
      if (room <= 0)
        return settle('paused', steps, `even the smallest compaction step does not fit the ${budget}-character budget: the prompt, the`
          + ` tool declarations and the summarization instruction alone take ${budget - room} characters`)
      let allowed = room, attempts = 0, committed = false, failure = ''
      while (attempts < MAX_ATTEMPTS) {
        const range = this.choose(now.nodes, allowed)
        if (range === undefined)
          return settle('paused', steps, 'there is no model-visible material left to compact: the prompt and the tool declarations'
            + ' alone are over the budget')
        this.reports.set(sessionId, { sessionId, state: 'recovering', steps, before, after: historyOf(now.parts), at: this.at() })
        try {
          if (signal?.aborted) throw new Error('interrupted before the compaction step began')
          await backend.compactRegion(range.start, range.end, agent, signal)
          steps++
          committed = true
          break
        } catch (error) {
          failure = textOf(error)
          const refused = this.host.budget.last(sessionId)
          if (refused === undefined || refused.action !== 'suspend' || refused.purpose !== 'compaction'
            || refused.sessionId !== sessionId || refused.budget !== budget)
            return settle('paused', steps, `the compaction step was interrupted: ${failure} — the history it selected is unchanged`)
          // The step's own request was refused at the boundary: what it carried beyond the range is now measured, not guessed.
          extra = Math.max(extra, refused.total - overheadOf(now.parts) - range.chars)
          const shrinkTo = budget - overheadOf(now.parts) - extra
          const smaller = shrinkTo <= 0 ? undefined : this.choose(now.nodes, shrinkTo)
          if (smaller === undefined || smaller.chars >= range.chars)
            return settle('paused', steps, `even the smallest compaction step does not fit the ${budget}-character budget: ${failure}`)
          allowed = shrinkTo
          attempts++
        }
      }
      if (!committed) return settle('paused', steps, `no compaction range fitted the budget after ${attempts} attempts: ${failure}`)
    }
  }

  /** The settled state of a Session that fits again: the deferred title is retried, and the report says how many steps it took. */
  private recovered(agent: RecoveryAgent, settle: (state: RecoveryState, steps: number, reason?: string) => RecoveryReport,
    steps: number): RecoveryReport {
    const report = settle('recovered', steps)
    this.retryTitle(agent.id, agent)
    return report
  }

  /**
   * Retry the title the budget deferred, once, through DSH's own title service: the Session fits again, so the request that names it
   * may fit too. It is detached from the recovery report on purpose — a title nobody is waiting for must not hold up the work that
   * clears a Session — and its outcome is another state on the report (`sent`, or `skipped` with the reason the retry was refused).
   */
  private retryTitle(sessionId: string, agent: RecoveryAgent): void {
    const title = this.titles.get(sessionId)
    if (title?.state !== 'deferred') return
    const service = titleBackendOf(agent)
    if (service === undefined) {
      this.titles.set(sessionId, { state: 'skipped', attempts: title.attempts, at: this.at(),
        reason: `${title.reason}; DSH's title service is not reachable from this Session, so the title waits for its next prompt` })
      return
    }
    const work = (async () => {
      try {
        await service.refresh(agent.session)
        this.titles.set(sessionId, { state: 'sent', attempts: title.attempts + 1, at: this.at(),
          reason: 'the title request fitted the budget once the Session had recovered' })
      } catch (error) {
        this.titles.set(sessionId, { state: 'skipped', attempts: title.attempts + 1, at: this.at(),
          reason: `the title request was refused again after the Session recovered: ${textOf(error)}` })
      }
    })()
    this.titlesRunning.add(work)
    void work.finally(() => { this.titlesRunning.delete(work) })
  }

  /**
   * What a refused title request means: deferred when compacting the Session's history is what would make it fit, skipped when
   * nothing this runtime can do would. Either way the Session keeps working and its current title stands — a title is never worth a
   * request over the limit, and it never blocks the recovery that a turn's refusal starts.
   */
  private titleRefused(sessionId: string, record: RequestRecord): void {
    const attempts = (this.titles.get(sessionId)?.attempts ?? 0) + 1
    const repairable = record.reason === undefined && (record.cut.history > 0 || record.cut.toolResults > 0)
    this.titles.set(sessionId, repairable && attempts <= 1
      ? { state: 'deferred', attempts, at: this.at(), reason: `the title request needs ${record.total} characters against a`
        + ` ${record.budget}-character budget; it is deferred until the Session's history is compacted` }
      : { state: 'skipped', attempts, at: this.at(), reason: `the title request needs ${record.total} characters against a`
        + ` ${record.budget}-character budget and no recovery can make it fit; the Session keeps its current title and ordinary work`
        + ' is unaffected' })
  }

  /**
   * What one Session's surface measures now: the model-visible events behind the surface nodes, the tool definitions its route
   * declares, and the state and recall its last ordinary request carried. The surface — not the log — is measured, because a
   * committed replacement shadows what it replaced and a log-based measurement would keep recovering a history already gone.
   */
  private measure(sessionId: string, agent: RecoveryAgent): MeasuredSurface {
    const events = agent.session.snapshotEvents()
    const seqOf = (event: RecoveryEvent, index: number): number => typeof event.seq === 'number' ? event.seq : index
    const logged = events.map((event, index) => ({ seq: seqOf(event, index), event }))
    // The surface names its nodes in model-visible order, which is not log order once a replacement has taken the place of the range
    // it shadows: the replacement is appended at the end of the log but stands where the range began. A Session that reports no
    // surface at all is measured by its log, which is the only order there is.
    const bySeq = new Map(logged.map(node => [node.seq, node]))
    const order = agent.session.surface?.nodes
    const nodes = order === undefined ? logged : order.flatMap(seq => { const node = bySeq.get(seq); return node === undefined ? [] : [node] })
    const last = this.host.budget.requestsOf(sessionId).filter(record => record.purpose === undefined).at(-1)
    const parts: RequestParts = { ...measureSurfaceEvents(nodes.map(node => node.event)), tools: this.host.budget.definitionsOf(sessionId),
      state: last?.parts.state ?? 0, recall: last?.parts.recall ?? 0 }
    return { parts, plan: this.host.budget.plan(parts), nodes: nodes.map(node => ({ seq: node.seq, type: node.event.type,
      chars: totalOf(measureSurfaceEvents([node.event])), calls: callsOf(node.event) })) }
  }

  /**
   * The largest range one step may compact: a prefix of the compactable surface, never the system head DSH keeps at the front, never
   * split between an assistant tool call and its results. A range whose characters exceed what the step may carry is not offered
   * unless no smaller one exists — that case is the probe which measures what a step carries beyond its range, and it is refused at
   * the boundary rather than sent.
   */
  private choose(nodes: readonly SurfaceNode[], allowed: number): ChosenRange | undefined {
    const first = nodes.findIndex(node => node.type !== 'system/message')
    if (first < 0) return undefined
    let smallest: ChosenRange | undefined, chosen: ChosenRange | undefined, chars = 0, pending = 0, calls = 0
    for (let index = first; index < nodes.length; index++) {
      const node = nodes[index]!
      chars += node.chars
      calls += node.calls
      pending += node.calls - (node.type === 'tool/result' ? 1 : 0)
      const next = nodes[index + 1]
      // Both edges must leave every tool call the range holds paired with its results: a range may not end while a call it contains
      // is still unanswered, and it may not end before the results of a call it contains. That is what DSH validates before it
      // replaces a range, and a range it rejects commits nothing.
      if (pending > 0 || (next?.type === 'tool/result' && calls > 0)) continue
      const candidate = { start: nodes[first]!.seq, end: node.seq, chars }
      smallest ??= candidate
      if (chars > allowed) break
      chosen = candidate
    }
    return chosen ?? smallest
  }
}

/** DSH's compaction backend on the Session's own preset, when the Session has one mounted. */
function compactionOf(agent: RecoveryAgent): CompactionBackend | undefined {
  const service = agent.ctx.get('compaction') as Partial<CompactionBackend> | undefined
  return typeof service?.compactRegion === 'function' ? service as CompactionBackend : undefined
}
/** DSH's title service on the Session's own preset, when the deployment mounts one. */
function titleBackendOf(agent: RecoveryAgent): TitleBackend | undefined {
  const service = agent.ctx.get('sessionTitle') as Partial<TitleBackend> | undefined
  return typeof service?.refresh === 'function' ? service as TitleBackend : undefined
}
