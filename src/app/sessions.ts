/** Lifecycle, prompt/tool/skill decoration, message delivery, and budget retry tracking for orchestrator and worker DSH sessions. */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { GenerateOptions, MessageId, StreamChunk } from '@deepseek-ai/dsh-llm'
import { scopeParentOf } from '@deepseek-ai/dsh-scope'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { dirname } from 'node:path'
import { z } from 'zod'
import { key, liveTicket, type Ticket } from '../core/index.ts'
import { mandateInstructions, ticketOfSession } from '../executor/dsh.ts'
import type { HealthEntry } from '../infra/health.ts'
import { measureFinalRequest, measureVisible, refusal, refusalMessage, routeDecides, type PageRecord, type RequestBudget, type RequestRecord,
  type RouteFacts } from './budget.ts'
import { AgentDelivery, messageId } from './delivery.ts'
import type { Effects } from './effects.ts'
import type { Variable } from './execution-environment.ts'
import { SessionRecovery, type RecoveryAgent, type RecoveryReport, type TitleReport } from './recovery.ts'
import { RetryHealth } from './retry-health.ts'
import { initializeRoleModel } from './role-models.ts'
import { bundledSkills } from './skill-files.ts'
import { SKILL_PREFIX, type PromptVersion, type Prompts } from './prompts.ts'
import type { Store } from './store.ts'
import { KV } from '../kv.ts'
import type { RegisterTool, Tool } from './tools/tool.ts'

/** Host dependencies used by `Sessions`. */
export interface SessionsHost {
  /** DSH Cordis context: sessions, agents, persistence, and their events. */
  readonly context: Context
  readonly store: Pick<Store, 'tickets' | 'settings' | 'get' | 'set' | 'keys'>
  readonly prompts: Pick<Prompts, 'current' | 'version' | 'compose' | 'skills'>
  readonly effects: Pick<Effects, 'enqueue' | 'handle' | 'idle' | 'pending'>
  /** The model-request budget every request is measured against, and that the messages delivered here are paged to fit. */
  readonly budget: RequestBudget
  /** The `models` health entry, which reports managed sessions waiting on a model-budget retry. */
  readonly health: HealthEntry
  /** The `budget` health entry, which publishes what the request budget measured, refused and paged. */
  readonly budgetHealth: HealthEntry
  readonly masterId: string
  readonly lifetime: AbortSignal
  closing(): boolean
  /** Execution environment variables for `ticket`, rendered into its worker's system prompt. */
  environment(ticket: Ticket): Variable[]
  /** Tools to register on the main Session (`ticket === undefined`) or on `ticket`'s worker Session. */
  tools(agent: Agent, ticket?: Ticket): Tool[]
}

/**
 * What Sessions registered for an agent it decorated: the releases of its prompt section, tools and skill scope, the scope
 * its skills are registered in, and the skills of one prompt revision; for a worker's subagent, only its tool limits.
 */
interface SessionBinding { disposers: (() => void)[]; scope?: Context; skills?: { revision: number; dispose: () => void }; subagent?: true }

/** The agent presets Executor Sessions and the main Session are created with, which the bundle's patch defines. */
export const WORKER_PRESET = 'dsh-superagent-worker', ROUTER_PRESET = 'dsh-superagent-router'
declare module '@deepseek-ai/cordis' {
  interface Events {
    /** DSH's agent preset registry selected `agentPreset` for a Session. */
    'agent-preset/selected'(sessionId: string, agentPreset: string): void
  }
}
/**
 * The DSH tools an Executor Session works with: files, search, the shell and its jobs, the web, skills, its todo list and
 * subagents. It gets no other tool the profile has, whenever it was registered: none that asks or shows a person something,
 * changes the profile, schedules work or starts goals outside the worker slots, the pause and a person's hold, starts or
 * messages other Sessions, or edits documents.
 */
const WORK_TOOLS = ['read', 'write', 'edit', 'read_image', 'glob', 'grep', 'bash', 'pwsh', 'job_output', 'job_list', 'job_kill', 'web_search',
  'web_fetch', 'skill', 'todo_write', 'subagent', 'list_subagent_models', 'send_message', 'list_agents', 'interrupt_agent']
/** What the main Session is told when it would wait: what it waits for comes to it, and a waiting step holds back the next. */
const NO_WAIT = 'Reports, follow_up notices, new candidates and a background job\'s end with its output arrive by themselves as messages; '
  + 'end the turn instead of waiting for them.'
/** What a main Session under `standard` is told when its command would wait the shell's default. */
const DEFAULT_WAIT = 'This shell waits up to 60 seconds by default: pass timeoutMs of at most 30000, or run_in_background, '
  + 'as a waiting step holds back new candidates.'
/** `sleep` at a command position: the start, after ; & | ( { ! ` or a newline, or after a keyword or a command that runs it. */
const SLEEP = /(?:^|[;&|({!`\n]|\b(?:do|then|else|elif|if|while|until|time|exec|nohup|command|env)\s)\s*(?:\S*\/)?sleep\b/
/**
 * The main Session's guard: it refuses a bash command that runs sleep or asks to hold the step longer than 30 seconds, and a
 * job wait longer than 5 seconds. Under `standard`, as a main Session created before the router preset runs, the shell holds
 * a command 60 seconds and a job wait lasts 30 seconds by default, so a command needs a timeout or the background, and a
 * job wait its timeout; the router preset ends both after 5 seconds.
 */
function noWait({ name, arguments: input }: { name: string; arguments: unknown }, routed: () => boolean): string | undefined {
  const args = (input ?? {}) as { command?: unknown; timeoutMs?: unknown; run_in_background?: unknown; wait?: unknown; timeout_ms?: unknown }
  if (name === 'bash') {
    const sleeps = typeof args.command === 'string' && SLEEP.test(args.command)
    if (sleeps || typeof args.timeoutMs === 'number' && args.timeoutMs > 30_000) return NO_WAIT
    if (args.timeoutMs === undefined && args.run_in_background !== true && !routed()) return DEFAULT_WAIT
  }
  if (name === 'job_output' && args.wait === true && (typeof args.timeout_ms === 'number' ? args.timeout_ms > 5_000 : !routed())) return NO_WAIT
  return undefined
}

/**
 * Creates and decorates orchestrator and worker DSH `Agent` sessions with role models, system prompt sections from `Prompts`, runtime skills, and restricted tool sets.
 * `Runtime`, `DshExecutor`, `MasterAssessor`, `Settings`, and management routes/tools use it to ensure sessions, deliver deduplicated messages via `AgentDelivery`, and process ordered `relay` and `notice` effects.
 * Feeds session events into `RetryHealth` to report model budget waits on the `models` `HealthEntry`, and durably records which prompt revisions each session has worked under in `Store` (`KV.sessions.prompts`) to authorize prompt version reads.
 */
export class Sessions {
  private readonly agentDelivery: AgentDelivery
  /** Decorated agents mapped to their registered disposers and skill scope until the agent is disposed or `Sessions.dispose()` runs. */
  private readonly bindings = new Map<Agent, SessionBinding>()
  private readonly retryHealth = new RetryHealth()
  /** Bounded recovery of a Session whose history is over the budget, and the deferral of a Session title that cannot fit. */
  private readonly recoveries: SessionRecovery
  private readonly ctx: Context
  /** Releases the process-wide subscriptions `install` took, so a stopped runtime stops answering model calls. */
  private readonly disposers: (() => void)[] = []
  /** Registers ordered `relay` and `notice` effect handlers that deliver to the main Session. */
  constructor(private readonly host: SessionsHost) {
    this.ctx = host.context
    this.agentDelivery = new AgentDelivery(host.context)
    this.recoveries = new SessionRecovery({ budget: host.budget,
      agentOf: (sessionId: string) => this.ctx.agents.get(sessionId as SessionId) as RecoveryAgent | undefined })
    // Deliver relays and notices to the main Session in the order they were queued.
    host.effects.handle('relay', ({ text }, requestId) => this.prompt(host.masterId, requestId, text, 'steer'), { ordered: true })
    host.effects.handle('notice', ({ value, summary }, name) => this.inject(name, value, summary), { ordered: true })
  }
  /** Subscribes to host agent and session events so newly created sessions are decorated and model-budget retries are reflected in health. Call once at startup. */
  install(): void {
    const ctx = this.ctx
    ctx.on('agent/disposed', ({ agent }) => {
      this.release(agent)
      this.retryHealth.clear(agent.id); this.updateModelHealth()
    })
    ctx.on('session/event', (session, event) => {
      const agent = ctx.agents.get(session.id)
      const binding = agent && agent.session === session ? this.bindings.get(agent) : undefined
      if (!agent || !binding || binding.subagent) return
      this.retryHealth.observe(agent.id, event)
      this.updateModelHealth()
    })
    ctx.on('agent/created', async ({ agent }) => { await this.decorate(agent); return undefined })
    // Opening a Session in DSH's Web UI before its first turn may select the default preset for it: select ours again. After
    // its first turn DSH refuses any selection, which leaves it as it is.
    ctx.inject(['agentPresets'], child => {
      child.on('agent-preset/selected', (sessionId, preset) => {
        const ticketId = ticketOfSession(sessionId), agent = ctx.agents.get(sessionId as SessionId)
        const ours = sessionId === this.host.masterId ? ROUTER_PRESET : ticketId && this.host.store.tickets.get(ticketId) ? WORKER_PRESET : undefined
        if (!ours || preset === ours || !agent) return
        const presets = child.get('agentPresets') as { select(agent: Agent, preset: string): Promise<string> }
        presets.select(agent, ours).catch(() => {})
      })
    })
    ctx.on('agent/status', ({ agent, status }) => {
      if (status === 'idle' && !this.host.closing()) { this.retryHealth.clear(agent.id); this.updateModelHealth() }
    })
    // Every model call the process makes is dispatched through this waterfall — whichever Session asked for it, and whatever
    // its purpose — so the budget measures the complete request here and answers one that does not fit instead of sending it.
    this.disposers.push(ctx.on('llm/stream', (options, next) => this.streamed(options, next)))
  }
  /** Resolves or creates session `id` in workspace `cwd`, initializes its role model, decorates it with prompts/skills/tools, sets `danger-full-access` permissions, and renames it to `title`. */
  async ensure(id: string, cwd: string, title: string, role: 'orchestrator' | 'worker'): Promise<Agent> {
    const ctx = this.ctx
    let result = await ctx.sessionController.resolveAgent(id as SessionId)
    if ('error' in result && result.error.code === 'session/not-found') {
      const workspace = await ctx.workspaceRegistry.create(cwd)
      // A Session keeps the preset it was created with, one of the bundle's own (cordis.patch.yml).
      await ctx.sessionController.create({ sessionId: id as SessionId, workspaceId: workspace.id,
        agentPreset: role === 'worker' ? WORKER_PRESET : ROUTER_PRESET })
      result = await ctx.sessionController.resolveAgent(id as SessionId)
    }
    if ('error' in result) throw result.error
    const settings = this.host.store.settings()
    await initializeRoleModel(ctx, result.agent, role === 'orchestrator' ? settings.eval.model : settings.executor.model)
    await this.decorate(result.agent)
    ctx.permissionPresets.set(result.agent.session, 'danger-full-access')
    await ctx.sessionController.rename({ sessionId: id as SessionId, title })
    return result.agent
  }
  /** Returns whether `sessionId` already holds the message delivered under `requestId`, or `false` if the session does not exist. */
  async holds(sessionId: string, requestId: string): Promise<boolean> {
    const result = await this.ctx.sessionController.resolveAgent(sessionId as SessionId)
    return !('error' in result) && await this.agentDelivery.holds(result.agent, key(requestId))
  }
  /** Deliver a message once per request id: to the next turn, the current one, `recall`ed context without waking the agent, or `inject`ed with its label. */
  async prompt(sessionId: string, requestId: string, text: string, mode: 'queue' | 'steer' | 'recall' | { inject: string }, authorize?: () => void,
    accepted?: () => void): Promise<void> {
    const result = await this.ctx.sessionController.resolveAgent(sessionId as SessionId)
    if ('error' in result) throw result.error
    await this.agentDelivery.send(result.agent, key(requestId), this.paged(result.agent, 'message', text), mode, this.host.lifetime, authorize, accepted)
  }
  /** The id of the message `prompt` delivers under `requestId`, which DSH's inbox events name it by. */
  promptedId(requestId: string): MessageId { return messageId(key(requestId)) }
  /** Every model request the runtime caused, oldest first: `sessionId`'s when named, else every Session and background one. */
  requests(sessionId?: string): RequestRecord[] { return this.host.budget.requestsOf(sessionId) }
  /** Every delivered message and tool result the budget had to make smaller, oldest first. */
  pages(sessionId?: string): PageRecord[] { return this.host.budget.pagesOf(sessionId) }
  /** Characters the Session's last request left for recalled material, which the memory service assembles recall within. */
  allowance(sessionId: string): number { return this.host.budget.allowance(sessionId) }
  /** Enqueues a steering relay to the main Session; relays are durable and retried by `Effects` until delivered, at most once per `requestId`. */
  relay(requestId: string, text: string): void { this.host.effects.enqueue('relay', requestId, { text }) }
  /** Enqueues a durable background notice for injection into the main Session; a new notice with the same `name` replaces a still-waiting notice of that `name`. */
  notify(name: string, value: Record<string, unknown>, summary: string): void { this.host.effects.enqueue('notice', name, { value, summary }) }
  /** Waits for currently runnable `notice` effects to settle and returns `'injected'` if notice `name` has reached the main Session or `'pending'` if it is still queued. */
  async delivery(name: string): Promise<'injected' | 'pending'> {
    await this.host.effects.idle('notice')
    return this.host.effects.pending('notice', name) ? 'pending' : 'injected'
  }
  /** Injects a notice into the main Session without waking it; no-op if the main Session does not exist yet. */
  private async inject(name: string, value: Record<string, unknown>, summary: string): Promise<void> {
    const resolved = await this.ctx.sessionController.resolveAgent(this.host.masterId as SessionId)
    if ('error' in resolved) return
    // Deduplicate by notice name and payload hash so retries are idempotent while updated payloads still deliver.
    const text = JSON.stringify(value)
    await this.agentDelivery.send(resolved.agent, `notice:${name}:${key(text)}`, this.paged(resolved.agent, 'message', text), { inject: summary },
      this.host.lifetime)
  }
  /** Returns the current prompt revision, the active prompt revision of each loaded Session, and whether the main Session still has a pending `'prompts'` notice. */
  status() {
    const { store, prompts, effects } = this.host
    const sessions = store.keys(KV.sessions.prompts).flatMap(name => {
      const sessionId = name.slice(KV.sessions.prompts.prefix.length), revision = store.get(name)?.at(-1)
      return this.ctx.agents.get(sessionId as SessionId) && revision !== undefined ? [{ sessionId, revision }] : []
    })
    return { revision: prompts.current().revision, sessions, notificationPending: effects.pending('notice', 'prompts') }
  }
  /** Returns the prompt version a Session runs under (the one bound on its latest model request, or the current version). */
  promptVersion(sessionId: string): PromptVersion {
    const revision = this.host.store.get(KV.sessions.prompts(sessionId))?.at(-1)
    return revision === undefined ? this.host.prompts.current() : this.host.prompts.version(revision)
  }
  /** Whether a Session is authorized to read `revision` (its active revision or any revision it previously ran under). */
  mayRead(sessionId: string, revision: number): boolean {
    return revision === this.promptVersion(sessionId).revision || (this.host.store.get(KV.sessions.prompts(sessionId)) ?? []).includes(revision)
  }
  /**
   * Returns a tool registrar for `agent` that renders tool output as JSON text, paged to the room the request budget has for
   * it, and attaches `output.image` as an image when present.
   */
  private registerTool(agent: Agent, binding: SessionBinding): RegisterTool {
    return (name, description, schema, execute) => {
      binding.disposers.push(agent.ctx.tools.register({ name, description, parameters: z.toJSONSchema(schema),
        output: { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => {
          const text = { type: 'text' as const, text: this.paged(agent, 'tool-result', JSON.stringify(value)) }
          const image = value && typeof value === 'object' && 'image' in value ? (value as { image: never }).image : undefined
          return image ? [text, { type: 'image' as const, attachment: image }] : [text]
        } },
        execute: (args, execution) => execute(schema.parse(args), execution.signal) }))
    }
  }
  /**
   * Page one message or tool result to the room the Session's budget leaves for it, or return it whole when it fits. The room is
   * measured against what the model will actually see of the Session (`measureVisible`) — its surface, not the append-only log a
   * compaction's replacement has already superseded — so material delivered after a recovery is not squeezed out by history.
   */
  private paged(agent: Agent, kind: PageRecord['kind'], text: string): string {
    const budget = this.host.budget
    const paged = budget.page(agent.id, kind, text, budget.room(measureVisible(agent.session), agent.id))
    this.reportBudget()
    return paged
  }
  /**
   * Measure one model request where DSH hands it to an adapter and let it through or refuse it: the system prompt travels inside
   * the messages, the tool definitions beside them, and the conversation and its tool results follow. What is measured is not the
   * request this listener is handed but the one DSH makes of it before the adapter: the route's own tool history is expanded into
   * the declarations, or left out when the route reads none, and a request image becomes a placeholder on a route without image
   * input (`measureFinalRequest`). Measuring the request as it arrived is what once let a request approved at five characters
   * reach its adapter at nine thousand. It arrives assembled and deep frozen, so nothing here can make it smaller — the parts that
   * can be paged are paged by whoever delivers them — and a request that does not fit is answered with a refusal instead. That
   * includes DSH's own compaction and Session-title calls: they are recorded with their purpose and held to the same limit, so an
   * over-limit send is never recorded as a recovery that succeeded. Liveness comes from bounded work instead — a Session whose
   * history is over is restored by `SessionRecovery`, one compacted step at a time, each step a request this boundary measures and
   * lets through only if it fits. A request whose final size cannot be established is refused too, because a request nobody can
   * size is not one this runtime can report as inside its budget.
   */
  private async *streamed(options: GenerateOptions, next: () => AsyncIterable<StreamChunk>): AsyncIterable<StreamChunk> {
    // A call whose signal is already aborted is never sent, so there is nothing to measure and no budget it could break.
    if (options.signal?.aborted) { yield* next(); return }
    const record = this.host.budget.record(options.sessionId as string | undefined, measureFinalRequest(options, await this.routeFacts(options)),
      options.purpose)
    this.reportBudget()
    if (record.action !== 'suspend') { yield* next(); return }
    this.ctx.logger.warn('dsh-superagent: %s', refusalMessage(record))
    // The refusal is the budget working, and the Session it refuses is the one thing that can be given its work back: a turn whose
    // history is over is recovered here, inside the turn that found it, so DSH's own compaction sees an open turn and the next
    // request of this Session fits. A title is only ever deferred or skipped, and a compaction call the boundary refused leaves the
    // Session paused until this bounded recovery runs.
    let note: string | undefined
    try {
      note = await this.recoverRefused(record, options.signal)
    } finally { this.reportBudget() }
    yield* refusal(record, note)
  }
  /**
   * What a refused request means for its Session, as the note the refusal carries: `undefined` when there is nothing to recover —
   * a request that belongs to no Session, or a refusal this runtime cannot repair. A turn or background call inside a Session whose
   * history is what the request was short of is handed to bounded recovery, which compacts that history in steps that each fit; a
   * refusal with a cause no compaction refunds — a size the runtime could not establish, required parts over on their own, an
   * unusable budget — is recorded as the pause it is, because a recovery that ran anyway claimed a Session recovered while the same
   * request was refused again. A title is deferred or skipped with the reason and waits for nothing; a compaction call that was
   * itself refused leaves the Session paused and names that, because the next turn of the Session is what starts the recovery that
   * will fit.
   */
  private async recoverRefused(record: RequestRecord, signal?: AbortSignal): Promise<string | undefined> {
    const sessionId = record.sessionId
    if (sessionId === undefined) return undefined
    if (record.purpose !== undefined) {
      this.recoveries.refused(record)
      const title = this.recoveries.titleOf(sessionId)
      if (record.purpose === 'session-title' && title !== undefined) return title.reason
      const paused = this.recoveries.report(sessionId)
      return paused?.state === 'paused' ? paused.reason : undefined
    }
    // A reason on the record means compacting the history is not what the request was short of: only a size refusal with material
    // the recovery could compact is worth a step, and `unrepairable` records the rest instead of claiming a recovery.
    const report: RecoveryReport = record.reason === undefined
      ? await this.recoveries.recover(sessionId, signal)
      : this.recoveries.unrepairable(sessionId, record)
    if (report.state === 'recovered')
      return `the Session was over its history budget and was recovered in ${report.steps} bounded step(s); its next request fits`
    return `the Session is paused: ${report.reason ?? 'its history cannot be compacted within the budget'}`
  }
  /** Where a Session's bounded recovery stands right now: recovering, recovered, or paused with the reason — it never waits. */
  recoveryNow(sessionId: string): RecoveryReport | undefined { return this.recoveries.report(sessionId) }
  /** Wait for `sessionId`'s recovery to settle and answer where it stands, so a caller reads a state rather than a race. */
  async awaitRecovery(sessionId: string): Promise<RecoveryReport | undefined> {
    await this.recoveries.settled(sessionId)
    return this.recoveries.report(sessionId)
  }
  /** How a Session's title stands after a budget refusal: deferred until recovery, skipped with its reason, or sent by a retry. */
  title(sessionId: string): TitleReport | undefined { return this.recoveries.titleOf(sessionId) }
  /** Wait for the bounded housekeeping work this class started besides the request it handled — the deferred title retries. */
  async settled(): Promise<void> { await this.recoveries.settled() }
  /**
   * The recovery and title state of one Session, as the `budget` health entry publishes it: `recovering` while the runtime compacts
   * its history in steps, `recovered` once it fits again, and `paused` with the reason when nothing this runtime can do would make
   * it fit — a title that was deferred or skipped says the same. A reader can therefore tell a Session being recovered from one that
   * cannot be, which a bare request count could not say.
   */
  private recoveryNote(sessionId: string): string {
    const report = this.recoveries.report(sessionId), title = this.recoveries.titleOf(sessionId)
    return (report === undefined ? '' : `; the recovery of ${sessionId} is ${report.state}`
      + (report.state === 'recovered' ? ` after ${report.steps} step(s)` : '')
      + (report.state === 'paused' && report.reason !== undefined ? ` (${report.reason})` : ''))
      + (title === undefined ? '' : `; its title is ${title.state}`)
  }
  /**
   * The exact model metadata of the route a request is sent on, when the request's final form depends on it: DSH reads the
   * route's tool update mode and image support to project a tool history, a deferred definition or an image, and a route that
   * cannot describe itself leaves the request unmeasurable rather than measurable by assumption. It is the same exact-model query
   * DSH's own dispatch resolves its projection from (`llm.resolveModelInfo`), so the meter and the dispatch describe one route.
   */
  private async routeFacts(options: GenerateOptions): Promise<RouteFacts | undefined> {
    if (!routeDecides(options)) return undefined
    const llm = this.ctx.llm as { resolveModelInfo?: (provider: string, model: string, signal?: AbortSignal) => Promise<RouteFacts> } | undefined
    if (!llm?.resolveModelInfo) return undefined
    try { return await llm.resolveModelInfo(options.provider, options.model, options.signal) } catch { return undefined }
  }
  /**
   * Publish what the request budget has done: how many requests it measured, how many it refused before the model was called, how
   * much material it had to cut, and how large the largest request was against the budget in force. It names what the last request
   * was made of, too: the tool definitions it declared against what the Session's tool history holds, so an overflow shows which
   * part and which expansion produced it, and why a request it could not measure was refused. It is the operator's view of a
   * mechanism that otherwise only fails loudly, and it is a health entry rather than a new page: `state` is `paused` while the last
   * request it measured was one it refused, because that is a Session waiting on the budget rather than a working one, and `error`
   * when the configured policy cannot be used at all or the last request could not be measured.
   */
  private reportBudget(): void {
    const usage = this.host.budget.usage(), last = usage.last
    const refused = last?.action === 'suspend'
    const unmeasured = last?.unmeasured !== undefined
    const detail = `${usage.requests} requests: ${usage.sent} sent, ${usage.suspended} suspended, ${usage.housekeeping} housekeeping; `
      + `${usage.pages} materials paged, ${usage.kept} of ${usage.offered} characters kept; largest ${usage.largest} of `
      + `${usage.budget} characters`
      + (last === undefined ? '' : `, last ${last.sessionId ?? 'a background request'} at ${last.total}`)
      + (last?.purpose === undefined ? '' : ` (a ${last.purpose} call)`)
      + (last?.expansion === undefined ? '' : `, tool definitions ${last.parts.tools} of ${last.expansion.declared} declared and `
        + `${last.expansion.history} in the Session's tool history`)
      + (last?.reason === undefined ? '' : `, refused because ${
        last.reason === 'unmeasured' ? `its final size could not be measured (${last.unmeasured === 'fileProjection'
          ? 'it carries a file only the adapter dispatch can resolve' : 'its model route could not be resolved'})`
          : last.reason === 'invalidConfig' ? 'the input budget is not configured usefully'
            : 'its required parts alone are over the budget'}`)
      // The two states a person can act on: a Session whose history is being compacted back into its budget, and a title the
      // budget would not carry. Both are reported beside the requests, so a recovery is never mistaken for a session-level failure.
      + (last?.sessionId === undefined ? '' : this.recoveryNote(last.sessionId))
    this.host.budgetHealth.set({ state: usage.budget === 0 || unmeasured ? 'error' : refused ? 'paused' : 'ready',
      detail: usage.budget === 0 ? `the input budget is not configured usefully; ${detail}` : detail, at: new Date().toISOString() })
  }
  /** Returns `sessionId`'s active model-budget retry state (`{ model_retry }`) for status listings, or `{}` when not waiting on one. */
  modelRetry(sessionId: string | undefined) {
    const retry = sessionId ? this.retryHealth.get(sessionId) : undefined
    return retry ? { model_retry: retry } : {}
  }
  private updateModelHealth(): void {
    const retries = this.retryHealth.list()
    this.host.health.set(retries.length
      ? { state: 'error', detail: retries.slice(0, 5).map(item => `${item.sessionId}: ${item.provider} is over its model budget; retried ${item.attempts} times, waiting since ${item.since}; the model and retry policy are unchanged`).join('; ') + (retries.length > 5 ? `; ${retries.length - 5} more Sessions` : ''), at: retries.at(-1)!.lastAt }
      : { state: 'ready', detail: 'No managed Session is waiting on a model budget retry' })
  }
  private ticketOf(agent: Agent): Ticket | undefined {
    const ticketId = ticketOfSession(agent.id)
    return ticketId === undefined ? undefined : this.host.store.tickets.get(ticketId)
  }
  private async decorate(agent: Agent): Promise<void> {
    if (this.bindings.has(agent)) return
    const host = this.host
    const master = agent.id === host.masterId
    const ticket = master ? undefined : this.ticketOf(agent)
    if (!master && !ticket) { this.limitSubagent(agent); return }
    const binding: SessionBinding = { disposers: [] }
    this.bindings.set(agent, binding)
    this.retryHealth.restore(agent.id, agent.session.snapshotEvents())
    if (agent.status === 'idle') this.retryHealth.clear(agent.id)
    this.updateModelHealth()
    // Disable variable interpolation so literal ${{ ... }} expressions in team prompts are preserved.
    binding.disposers.push(agent.ctx.systemPrompt.section({ name: 'dsh-superagent-policy', order: 9999, interpolate: false, text: context => {
      const version = this.promptFor(agent, context.signal !== undefined)
      const current = ticket && host.store.tickets.get(ticket.id)
      const composed = host.prompts.compose(version.config, master ? 'orchestrator' : 'worker', current ? host.environment(current) : undefined)
      return `[dsh-superagent prompt revision ${version.revision}]\n${composed}\n${current ? mandateInstructions(current.mandate) : ''}`
    }, ...(master ? { complete: true } : {}) }))
    // A recreated skill scope (e.g. after the skills service restarts) starts empty, so reset `binding.skills` before rebinding.
    const skillScope = agent.ctx.inject(['skills'], scope => {
      binding.scope = scope
      binding.skills = undefined
      this.bindSkills(binding, host.prompts.current())
    })
    binding.disposers.push(() => { skillScope.dispose().catch((error: unknown) => { this.ctx.logger.warn('dsh-superagent could not release a skill scope: %s', String(error)) }) })
    await skillScope
    // Bail out if the agent was disposed while awaiting the skill scope.
    if (this.bindings.get(agent) !== binding) return
    const register = this.registerTool(agent, binding)
    for (const tool of host.tools(agent, ticket)) register(tool.name, tool.description, tool.schema, tool.execute)
    if (master) {
      binding.disposers.push(agent.ctx.tools.restrict({ allow: ['skill', 'bash', 'read', 'read_image', 'job_output', 'job_list', 'job_kill'] }),
        agent.ctx.tools.guard(execution => noWait(execution, () => this.routed(agent))))
    } else {
      // An Executor Session keeps the profile's work tools it has, which DSH requires to be known; its own tools are not masked.
      binding.disposers.push(...this.workOnly(agent, ticket!.id))
    }
  }
  /**
   * Whether a Session runs the router preset: as DSH's preset registry last selected it, read through the session projection
   * on a DSH whose registry has no `presetForSession`, else as it was created; `standard`, the safer caps, when unreadable.
   */
  private routed(agent: Agent): boolean {
    try {
      const presets = this.ctx.get('agentPresets') as { presetForSession?: (session: Agent['session']) => string | null } | undefined
      const projections = this.ctx.get('sessionProjections') as { stateOf?: (session: Agent['session'], key: string) => unknown } | undefined
      const selected = typeof presets?.presetForSession === 'function' ? presets.presetForSession(agent.session)
        : projections?.stateOf?.(agent.session, 'agentPreset')
      return (selected ?? agent.session.header.agentPreset) === ROUTER_PRESET
    } catch { return false }
  }
  /**
   * An Executor Session's tools: only the profile's work tools, which DSH requires to be known, and none once its ticket
   * ended. A failed or blocked worker keeps its tools, so a person may continue it in its Session; only automated input waits
   * (see the executor). Read inherited tools through the parent scope, which includes the preset's tools. The global view
   * misses preset tools; the agent's own view also includes local tools such as subagent, which restrict refuses to name.
   */
  private workOnly(agent: Agent, ticketId: string): (() => void)[] {
    const store = this.host.store
    const parent = scopeParentOf(agent)
    const allow = WORK_TOOLS.filter(name => agent.ctx.tools.get(name, parent))
    return [agent.ctx.tools.restrict({ allow }), agent.ctx.tools.guard(() => {
      const current = store.tickets.get(ticketId)
      return !current || !liveTicket(current) ? 'Ticket ended; new work needs a new authorized ticket' : undefined
    })]
  }
  /**
   * A subagent of an Executor Session, or of one of its subagents, which runs under DSH's `standard` preset with the worker's
   * permissions, gets the same work tools as the worker, and none once the worker's ticket ended. Any other agent is left as
   * it is.
   */
  private limitSubagent(agent: Agent): void {
    let parent = agent.session.header.parentSession
    // Up the subagents' parents to the worker, which are loaded while their subagents run.
    for (let depth = 0; parent !== undefined && ticketOfSession(parent) === undefined && depth < 8; depth++) {
      parent = this.ctx.agents.get(parent)?.session.header.parentSession
    }
    const ticketId = parent === undefined ? undefined : ticketOfSession(parent)
    if (ticketId === undefined || !this.host.store.tickets.get(ticketId)) return
    this.bindings.set(agent, { disposers: this.workOnly(agent, ticketId), subagent: true })
  }
  /** Register the skills of a prompt version in the agent's skill scope, in place of an earlier version's. */
  private bindSkills(binding: SessionBinding, version: PromptVersion): void {
    const { scope, skills: previous } = binding
    if (!scope || previous?.revision === version.revision) return
    previous?.dispose()
    const disposers: (() => void)[] = []
    for (const [name, content] of this.host.prompts.skills(version.config)) {
      const bundled = name === 'feishu' || name === 'github' ? bundledSkills[name] : undefined
      const body = version.config.skills[name] ?? ''
      const description = bundled?.description ?? (body.replace(/\s+/g, ' ').slice(0, 120) || 'Custom dsh-superagent operational skill.')
      disposers.push(scope.skills.register({ name: `${SKILL_PREFIX}${name}`, description, content, source: 'runtime',
        ...(bundled ? { resourceBase: { kind: 'directory' as const, path: dirname(bundled.path) } } : {}) }))
    }
    binding.skills = { revision: version.revision, dispose: () => { disposers.forEach(dispose => dispose()) } }
  }
  /** Return the current prompt version, updating the agent's skills and recording the revision in Store when bound to a model request. */
  private promptFor(agent: Agent, bind: boolean): PromptVersion {
    const version = this.host.prompts.current()
    if (!bind) return version
    const binding = this.bindings.get(agent)
    if (binding) this.bindSkills(binding, version)
    const { store } = this.host
    const revisions = store.get(KV.sessions.prompts(agent.id)) ?? []
    const bound = [...revisions.filter(revision => revision !== version.revision), version.revision]
    if (revisions.at(-1) !== version.revision) store.set(KV.sessions.prompts(agent.id), bound)
    return version
  }
  /** Releases registrations for `agent` in reverse order (LIFO); disposing its skill scope releases its skills as well. */
  private release(agent: Agent): void {
    const binding = this.bindings.get(agent)
    if (!binding) return
    this.bindings.delete(agent)
    binding.skills?.dispose()
    for (const dispose of binding.disposers.splice(0).reverse()) {
      try { dispose() } catch (error) { this.ctx.logger.warn('dsh-superagent could not release what it registered for a Session: %s', String(error)) }
    }
  }
  /** Releases prompt sections, skills, and tools registered by `Sessions` across all decorated agents, and its model-request boundary. */
  dispose(): void { for (const dispose of this.disposers.splice(0)) dispose(); for (const agent of [...this.bindings.keys()]) this.release(agent) }
}
