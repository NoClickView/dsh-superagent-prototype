/**
 * In-memory DSH host fixture (as in tests/runtime.spec.ts) running a configured Runtime with GitHub and Feishu sources,
 * allowed member Alice (`ou_alice`), listened chat `oc_team`, and `auto` eval mode. Stop it with `stop()`.
 */
import { Context } from '@deepseek-ai/cordis'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { vi, type Mock } from 'vitest'
import { contentHasFile, projectFilesToText, projectToolUpdates } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, RequestMessage, StreamChunk, ToolUpdate, UserMessage } from '@deepseek-ai/dsh-llm'
import { Runtime } from '../../src/app/runtime.ts'
import { Store } from '../../src/app/store.ts'
import { SettingsSchema } from '../../src/policy.ts'
import { feishuKind, feishuTrigger } from '../../src/sources/feishu.ts'
import { githubKind } from '../../src/sources/github.ts'
import { Commands } from '../../src/infra/commands.ts'
import { credentialHelper, workerGitConfig } from '../../src/infra/environment.ts'
import type { Trigger } from '../../src/core/index.ts'
import type { Machine } from '../../src/deployment.ts'
import { testMachine } from './deployment.ts'

export const MEMBER = 'ou_alice'
export const CHAT = 'oc_team'

/** Build a Feishu mention trigger from Alice in `oc_team`, using the digits in `id` as the timestamp offset in seconds. */
export function feishu(id: string, text: string, overrides: Record<string, unknown> = {}): Trigger {
  const at = String(Date.parse('2026-09-09T00:00:00Z') + Number(id.replace(/\D/g, '') || 0) * 1000)
  return feishuTrigger({ message_id: `om_${id}`, chat_id: CHAT, chat_type: 'group', sender_id: MEMBER, sender_type: 'user', content: text, create_time: at,
    mentions: [{ id: 'ou_bot' }], ...overrides }, 'ou_bot', 'cli_bot')!
}

type RegisteredTool = { name: string; description: string; parameters: unknown; execute: (args: unknown, execution: { signal: AbortSignal }) => Promise<unknown>;
  output?: { render: (args: unknown, value: unknown) => unknown } }
/** One system-prompt section a Session registered, whose text DSH evaluates on every model request. */
type Section = { name: string; text: (context: { signal?: AbortSignal }) => string; interpolate?: boolean }
/** One event of a Session's model-visible log. */
type Logged = { type: string; data: unknown }
type FakeAgent = {
  id: string; status: string; inbox: { nextTurn: UserMessage[]; nextStep: UserMessage[] }
  cancel: Mock; inject: Mock<(message: UserMessage) => void>; steer: Mock<(message: UserMessage) => void>; followup: Mock<(message: UserMessage) => void>
}
/** A text message, as DSH's job tools and subagents send their notices. */
const notice = (id: string, text: string) => ({ id, role: 'user', content: [{ type: 'text', text }], source: { kind: 'tool-jobs', form: 'notice' } }) as unknown as UserMessage
type HttpHandler = (req: unknown, res: unknown) => Promise<void>
type Delivery = { sessionId: string; mode: 'queue' | 'steer'; id: string; text: string }

/** The event types that produce a model-visible message, which is what DSH's surface holds. */
const SURFACE_EVENTS = new Set(['system/message', 'user/message', 'assistant/message', 'tool/result', 'developer/message'])
/** One event of a Session's append-only log with the sequence DSH stamps on it, which the surface is derived by. */
type SeqEvent = { readonly seq: number; readonly type: string; readonly data: unknown }
/**
 * The model-visible surface of one Session, as DSH derives it: the append-only log replayed with every committed positional
 * replacement applied. A replacement event names the range it shadows and takes that range's place in the surface; the log-only
 * `compaction/*` events never enter the model's view.
 */
function surfaceOf(log: readonly Logged[]): SeqEvent[] {
  const shadowed = new Set<number>(), anchors = new Map<number, SeqEvent>(), replacements = new Set<number>()
  log.forEach((event, seq) => {
    const op = (event.data as { surfaceOp?: { op?: string; startSeq?: number; endSeq?: number; shadowedSeqs?: number[] } }
      | undefined)?.surfaceOp
    if (op?.op !== 'replace' || op.startSeq === undefined || op.endSeq === undefined) return
    // A replacement's range is a surface POSITION span, so a later one can name a higher start than end. What it shadows is the set of
    // seqs it recorded, which is the same set DSH publishes in its `compaction/summary` event.
    const inside = op.shadowedSeqs ?? Array.from({ length: Math.max(0, op.endSeq - op.startSeq + 1) }, (_, offset) => op.startSeq! + offset)
    if (inside.length === 0) return
    anchors.set(inside[0]!, { seq, type: event.type, data: event.data })
    replacements.add(seq)
    for (const inner of inside) shadowed.add(inner)
  })
  const surface: SeqEvent[] = []
  log.forEach((event, seq) => {
    const anchor = anchors.get(seq)
    if (anchor !== undefined) surface.push(anchor)
    if (shadowed.has(seq) || replacements.has(seq)) return
    if (SURFACE_EVENTS.has(event.type)) surface.push({ seq, type: event.type, data: event.data })
  })
  return surface
}
/** The request message one surface event projects, as DSH's own surface does. */
function messageOf(event: SeqEvent): RequestMessage {
  const data = (event.data ?? {}) as { content?: unknown; message?: { content?: unknown } }
  const role = event.type === 'system/message' ? 'system' : event.type === 'tool/result' ? 'tool'
    : event.type === 'assistant/message' ? 'assistant' : 'user'
  return { role, content: (event.type === 'user/message' ? data.content : data.message?.content) ?? [] } as RequestMessage
}
/** The instruction the fixture's compaction backend appends to the replayed prefix, as DSH's own summarizer does. */
const COMPACTION_INSTRUCTION = 'Condense the conversation above into a structured checkpoint another model can resume from.'
/**
 * The message history DSH derives for the model from `log`: the surface in model-visible order, with every committed replacement
 * applied, as the messages a request carries. It is what the request budget measures a Session by, so a fake Session answers
 * `deriveMessages` with it rather than with its append-only log.
 */
export function visibleMessages(log: readonly { readonly type: string; readonly data: unknown }[]): RequestMessage[] {
  return surfaceOf(log).map(messageOf)
}
/**
 * A fake Session as the Runtime measures one: the events its log holds and the messages DSH derives from them for the next request.
 * A spec that hands the Runtime an agent needs this surface of a Session and nothing more of a real one, so it is built here rather
 * than by hand in every spec that keeps its own log.
 * @param id - the Session's id.
 * @param log - the events its log holds, read on every request.
 * @param overrides - the header the Session declares, and what appending one of its own events does.
 */
export function fakeSession(id: string, log: () => readonly { readonly type: string; readonly data: unknown }[],
  overrides: { header?: Record<string, unknown>; append?: (type: string, data: unknown) => void } = {}) {
  return { id, header: overrides.header ?? {}, snapshotEvents: log, requestHeader: () => undefined,
    append: overrides.append ?? (() => {}), deriveMessages: () => visibleMessages(log()) }
}
/** One compaction transaction the fixture's backend ran: the range it selected, and whether it committed a replacement. */
type CompactionRun = { readonly start: number; readonly end: number; readonly committed: boolean; readonly error?: string }

/**
 * DSH's job registry as the Executor uses it, with DSH's job tools: the jobs a Session can see, their events, a wait and a
 * kill. `run` starts a job a Session owns, `output` has one print, and `end` ends one, as its process does; an end no wait
 * collected reaches its owner, which it wakes when idle, as the job tools deliver it. `released` counts the waits ends
 * released.
 * @param owner - the agent of a Session, which an end reaches.
 */
export function jobRegistry(owner: (sessionId: string) => FakeAgent | undefined = () => undefined) {
  type Job = { id: string; owner: string; status: string; label?: string }
  const jobs = new Map<string, Job>()
  const listeners = new Set<{ owner: string; listener: (event: { type: string }) => void }>()
  const waits = new Map<string, ((job: Job) => void)[]>()
  let released = 0
  const emit = (job: Job, type: string) => { for (const listener of [...listeners]) if (listener.owner === job.owner) listener.listener({ type }) }
  const end = (id: string, status = 'completed') => {
    const job = jobs.get(id)!
    job.status = status
    const waiting = waits.get(id) ?? []
    waits.delete(id); released += waiting.length
    for (const wake of waiting) wake({ ...job })
    emit(job, 'settled')
    const agent = waiting.length ? undefined : owner(job.owner)
    const ended = notice(`notice-${id}`, `Job ${id} ended: ${status}`)
    if (agent?.status === 'idle') agent.followup(ended)
    else agent?.inject(ended)
  }
  const service = {
    list: vi.fn((caller: string) => [...jobs.values()].filter(job => job.owner === caller)),
    // A wait ends with the job, or fails once its signal aborts, which leaves the job's end uncollected.
    wait: vi.fn((id: string, _timeoutMs: number, _caller: string, signal?: AbortSignal) => new Promise<Job>((resolve, reject) => {
      const wake = (job: Job) => { signal?.removeEventListener('abort', abort); resolve(job) }
      const abort = () => { waits.set(id, (waits.get(id) ?? []).filter(item => item !== wake)); reject(new Error('wait aborted')) }
      waits.set(id, [...waits.get(id) ?? [], wake])
      signal?.addEventListener('abort', abort, { once: true })
    })),
    // A killed job ends a moment later, as its process does, also under a test's fake timers.
    kill: vi.fn((id: string) => { queueMicrotask(() => { end(id, 'killed') }); return 'requested' }) as Mock<(id: string) => string>,
    events: { subscribe: (filter: { owner: string }, listener: (event: { type: string }) => void) => {
      const entry = { owner: filter.owner, listener }
      listeners.add(entry)
      return () => { listeners.delete(entry) }
    } },
  }
  return { service, end, output: (id: string) => { emit(jobs.get(id)!, 'output') }, get released() { return released },
    run: (owner: string, label?: string) => { const id = `bash-${jobs.size + 1}`; jobs.set(id, { id, owner, status: 'running', label }); return id } }
}

/**
 * DSH's subagents as the Executor uses them. `spawn` starts a child of a Session, an agent while it lives, which a drain of
 * the Session's descendants refuses from then on; `settle` ends one, whose end wakes its idle parent or steers a running one
 * before a wait for the parent's children returns. Releasing or interrupting a child settles it; a drain of descendants
 * injects their ends. The catalog lists every child a Session had.
 */
export function subagentRuntime(agents: Map<string, FakeAgent>) {
  const children = new Map<string, { parent: string; live: boolean; settled: PromiseWithResolvers<void> }>()
  const closed = new Set<string>()
  const settle = (id: string, wake = true) => {
    const child = children.get(id)
    if (!child?.live) return
    child.live = false
    agents.delete(id)
    const parent = agents.get(child.parent), ended = notice(`settled-${id}`, `Subagent ${id} settled`)
    if (!wake) parent?.inject(ended)
    else if (parent?.status === 'idle') parent.followup(ended)
    else parent?.steer(ended)
    child.settled.resolve()
  }
  const service = {
    waitForChildren: vi.fn(async (parent: { id: string }) => {
      const live = [...children.values()].filter(child => child.parent === parent.id && child.live)
      await Promise.all(live.map(child => child.settled.promise))
      return live.length > 0
    }),
    listChildren: vi.fn(async (id: string) => [...children].filter(([, child]) => child.parent === id).map(([childId]) => ({ id: childId }))),
    drainChildren: vi.fn(async (_parent: { id: string }, ids: readonly string[]) => { for (const id of ids) settle(id) }),
    drainDescendants: vi.fn(async (parents: readonly { id: string }[]) => {
      for (const parent of parents) {
        closed.add(parent.id)
        for (const [id, child] of children) if (child.parent === parent.id) settle(id, false)
      }
    }),
    interrupt: vi.fn((id: string) => { settle(id) }),
  }
  const spawn = (parent: string) => {
    if (closed.has(parent)) throw new Error('DRAINING: the Session admits no new subagents')
    const id = `child-${children.size + 1}`
    children.set(id, { parent, live: true, settled: Promise.withResolvers<void>() })
    agents.set(id, { id, status: 'running', session: { header: { parentSession: parent } } } as never)
    return id
  }
  return { service, settle, spawn, live: (id: string) => !!children.get(id)?.live }
}

/** What a test may put in place of the fixture's own DSH host. */
export interface HostOptions {
  /** Services mounted instead of the fixture's, such as a sandbox backend and a permission preset table. */
  services?: Record<string, unknown>
  /** Machine settings the deployment under test differs in, such as the mode that gates the memory's writes. */
  machine?: Partial<Machine>
  /** A state directory the caller owns: the runtime starts on it, and `stop` leaves it in place. */
  stateDir?: string
  /** The model route its adapter declares, which decides how DSH projects a request before the adapter sees it. */
  route?: RouteUnderTest
}

/**
 * The capabilities of the model route the fixture's adapter serves, as a real adapter declares them through
 * `resolveModel`. Its adapter projects every request with these the way DSH does, so a test observes what the route
 * actually receives rather than what the caller assembled: an absent `toolUpdate` is a route that reads no tool history.
 * The route declares no input modalities, which is what an adapter that declares none does.
 */
export interface RouteUnderTest {
  /** The route's tool update mode: how DSH expands the tool history the Session folded. */
  toolUpdate?: ToolUpdate
  /** Fail route resolution, as a provider whose adapter cannot describe the model does. */
  unresolved?: boolean
}

/** @param seed - writes to the database before the Runtime opens it, such as records an earlier version stored.
 * @param options - the DSH services, machine settings and state directory a test supplies instead of the defaults. */
export async function startRuntime(seed?: (store: Store) => void, options: HostOptions = {}) {
  const directory = options.stateDir ?? mkdtempSync(join(tmpdir(), 'orchestrator-host-'))
  const AGENT = join(directory, 'agent-gh'), BOT = join(directory, 'lark-bot')
  const repository = { default_branch: 'master', permissions: { push: true } }
  vi.spyOn(Commands.prototype, 'gh').mockImplementation(async args => args[1] === 'user' ? { login: 'agent-bot' } : repository)
  vi.spyOn(Commands.prototype, 'lark').mockResolvedValue({ users: [{ member_id: MEMBER, name: 'Alice' }], has_more: false })
  vi.spyOn(Commands.prototype, 'git').mockResolvedValue('')
  vi.spyOn(Commands.prototype, 'run').mockResolvedValue('{"ok":true,"data":{}}')
  const scoped = 'git config -z --show-scope --get-regexp ^(credential\\..*|http\\..*extraheader)$'
  const answers: Record<string, string> = {
    [`${AGENT} api user`]: '{"login":"agent-bot","id":7}',
    [`${AGENT} api repos/acme/widgets --jq {name: .full_name, push: .permissions.push}`]: '{"name":"acme/widgets","push":true}\n',
    [`${BOT} auth status`]: JSON.stringify({ appId: 'cli_bot', brand: 'feishu', identities: { bot: { status: 'ready' } } }),
    [`${BOT} config strict-mode`]: 'strict-mode: bot (source: profile)',
    [`${BOT} api GET /open-apis/bot/v3/info --as bot --format ndjson`]: '{"bot":{"open_id":"ou_bot"},"code":0,"msg":"ok"}',
    ['git config -z --show-origin --get-all credential.https://github.com.helper']: `file:${workerGitConfig(directory)}\0${credentialHelper(AGENT)}\0`,
    [scoped]: `global\0credential.helper\n\0global\0credential.https://github.com.helper\n${credentialHelper(AGENT)}\0`,
  }
  /** A prepare command (`sh -c`) waits for this while it is set. */
  const hooks: { prepare?: Promise<void> } = {}
  const subprocess = { spawn: vi.fn((spec: { argv: readonly string[] }) => {
    const argv = [...spec.argv]
    while (argv[0] === 'env' || /^[A-Z_]+=/.test(argv[0] ?? '')) argv.shift()
    const reader = (text: string) => ({ readFrom: () => ({ text, nextOffset: text.length, lossy: false }) })
    const exited = { exitCode: 0, signal: null }
    const done = argv[0] === 'sh' && hooks.prepare ? hooks.prepare.then(() => exited) : Promise.resolve(exited)
    return { done, collected: { stdout: reader(answers[argv.join(' ')] ?? ''), stderr: reader('') } }
  }) }
  const agents = new Map<string, FakeAgent>()
  /** Each Session's next step, which takes the messages that wait for one. */
  const steps = new Map<string, () => void>(), claims = new Map<string, () => void>()
  const tools = new Map<string, Map<string, RegisteredTool>>()
  /** The system-prompt section each Session registered, which DSH evaluates on every model request. */
  const sections = new Map<string, Section>()
  /** The model-visible log of each Session: the messages its steps took, as DSH records them. */
  const logs = new Map<string, Logged[]>()
  /** The tool declarations a Session's next request carries, as DSH folds its registered tools into `tools`. */
  const definitionsOf = (sessionId: string) =>
    [...tools.get(sessionId)?.values() ?? []].map(({ name, description, parameters }) => ({ name, description, parameters }))
  /**
   * What the fixture's DSH housekeeping services did: every compaction transaction, the state the runtime was in when it asked for a
   * step, what a test makes happen while a step is in flight, and every title generation the runtime asked for. A test reads this to
   * see that a step never commits twice, that an interrupted step changed nothing, that recovery was observably in progress, and what
   * DSH's other housekeeping did to a Session in the middle of a recovery.
   */
  const dsh = { compaction: { runs: [] as CompactionRun[], interruptAfter: undefined as number | undefined,
    duringStep: undefined as (() => Promise<void>) | undefined, observed: [] as string[] }, title: { refreshes: [] as string[] } }
  /**
   * DSH's compaction backend as a Session sees it: `compactRegion` replaces one balanced positional range with a summary it asks a
   * model for. The request is a real one through the same `llm.stream` waterfall every other request takes, so the runtime's budget
   * measures it; the durable bracket is a `compaction/start`, the summary event and its replacement, and one `compaction/end`. A
   * failed or interrupted transaction leaves the log without a replacement, which is what makes a retry safe.
   */
  const compactionService = (sessionId: string) => ({
    compactRegion: vi.fn(async (start: number, end: number, _agent: unknown, signal?: AbortSignal) => {
      const log = logs.get(sessionId)!
      const compactionId = `compaction-${dsh.compaction.runs.length + 1}`
      const fail = (error: Error): never => {
        log.push({ type: 'compaction/end', data: { compactionId, error: error.message } })
        dsh.compaction.runs.push({ start, end, committed: false, error: error.message })
        throw error
      }
      if (signal?.aborted) return fail(new Error('compaction interrupted'))
      dsh.compaction.observed.push(runtime.sessions.recoveryNow(sessionId)?.state ?? 'absent')
      const surface = surfaceOf(log)
      const startAt = surface.findIndex(node => node.seq === start), endAt = surface.findIndex(node => node.seq === end)
      if (startAt < 0 || endAt < 0 || startAt > endAt) return fail(new Error(`compactRegion: ${start}-${end} is not a range on the surface`))
      const callsIn = (event: SeqEvent) => event.type === 'assistant/message'
        ? ((event.data as { message?: { content?: { type: string }[] } }).message?.content ?? []).filter(block => block.type === 'tool-call').length
        : 0
      // Both edges must keep an assistant tool call paired with its results, as DSH's own region validation requires.
      if (startAt > 0 && surface[startAt - 1]!.type === 'assistant/message' && callsIn(surface[startAt - 1]!) > 0)
        return fail(new Error('compactRegion: the range starts after a tool call it leaves outside'))
      const calls = surface.slice(startAt, endAt + 1).reduce((total, node) => total + callsIn(node), 0)
      if (calls > 0 && endAt + 1 < surface.length && surface[endAt + 1]!.type === 'tool/result')
        return fail(new Error('compactRegion: the range ends before the results of a call it contains'))
      log.push({ type: 'compaction/start', data: { compactionId } })
      const selected = surface.slice(startAt, endAt + 1)
      const head = surface[0]!.type === 'system/message' && startAt > 0 ? [messageOf(surface[0]!)] : []
      const messages = [...head, ...selected.map(messageOf),
        { role: 'user' as const, content: [{ type: 'text' as const, text: COMPACTION_INSTRUCTION }] }] as unknown as RequestMessage[]
      const chunks: StreamChunk[] = []
      for await (const chunk of llm.stream({ provider: 'deepseek', model: 'deepseek-chat', messages,
        tools: definitionsOf(sessionId) as never, sessionId: sessionId as never, purpose: 'compaction', maxTokens: 512,
        ...(signal === undefined ? {} : { signal }) })) chunks.push(chunk)
      const refused = chunks.flatMap(chunk => chunk.type === 'finish' && chunk.reason.kind === 'error' ? [chunk.reason.failure] : [])
      if (refused.length > 0) return fail(new Error(refused[0]!.message))
      if (dsh.compaction.interruptAfter !== undefined
        && dsh.compaction.runs.filter(run => run.committed).length >= dsh.compaction.interruptAfter)
        return fail(new Error('interrupted: the compaction step was interrupted before it committed'))
      // The step's request has been measured and sent and nothing is committed yet, which is where a test can make DSH's other
      // housekeeping — naming the Session, say — land while a recovery is in flight.
      if (dsh.compaction.duringStep !== undefined) await dsh.compaction.duringStep()
      const checkpoint = { role: 'user' as const, content: [{ type: 'text' as const, text: `checkpoint: ${selected.length} nodes condensed` }],
        source: { kind: 'compact-checkpoint' as const } }
      log.push({ type: 'compaction/summary', data: { compactionId, shadowedRange: { start, end },
        shadowedSeqs: selected.map(node => node.seq) } })
      log.push({ type: 'user/message', data: { ...checkpoint,
        surfaceOp: { op: 'replace', startSeq: start, endSeq: end, shadowedSeqs: selected.map(node => node.seq) } } })
      log.push({ type: 'compaction/end', data: { compactionId } })
      dsh.compaction.runs.push({ start, end, committed: true })
      return { compactionId, shadowedRange: { start, end }, shadowedSeqs: selected.map(node => node.seq) }
    }),
  })
  /**
   * DSH's title service as a Session sees it: one bounded auxiliary request, generated through the same waterfall. The provider
   * names the Session from the conversation it can see, so its request carries that material exactly as a turn's would and the same
   * budget decides it; a title the budget refuses reaches no adapter, and `refresh` is how the runtime retries a deferred one once
   * the Session has recovered.
   */
  const titleService = (sessionId: string) => ({
    refresh: vi.fn(async (_session: unknown, signal?: AbortSignal) => {
      dsh.title.refreshes.push(sessionId)
      const messages = surfaceOf(logs.get(sessionId)!).map(messageOf)
      const chunks: StreamChunk[] = []
      for await (const chunk of llm.stream({ provider: 'deepseek', model: 'deepseek-chat',
        messages: [...messages, { role: 'user' as const, content: [{ type: 'text' as const, text: 'Name this Session in three words.' }] }],
        tools: definitionsOf(sessionId) as never, sessionId: sessionId as never, purpose: 'session-title', maxTokens: 32,
        ...(signal === undefined ? {} : { signal }) })) chunks.push(chunk)
      const refused = chunks.flatMap(chunk => chunk.type === 'finish' && chunk.reason.kind === 'error' ? [chunk.reason.failure] : [])
      if (refused.length > 0) throw new Error(refused[0]!.message)
      return { title: 'recovered Session', messageSeqs: [], model: { provider: 'deepseek', id: 'deepseek-chat', name: 'deepseek-chat' } }
    }),
  })

  const deliveries = vi.fn<(request: Delivery) => void>()
  let http!: HttpHandler
  const resolveDefault = async (id: string) => agents.has(id) ? { agent: agents.get(id) } : { error: { code: 'session/not-found' } }
  const controller = {
    create: vi.fn(async ({ sessionId }: { sessionId: string }) => {
      if (agents.has(sessionId)) return
      const agentCtx = new Context()
      const sessionTools = new Map<string, RegisteredTool>()
      tools.set(sessionId, sessionTools)
      logs.set(sessionId, [])
      const register = (tool: RegisteredTool) => { sessionTools.set(tool.name, tool); return () => sessionTools.delete(tool.name) }
      agentCtx.reflect.provide('tools', { register, get: () => undefined, restrict: vi.fn(() => () => {}), guard: vi.fn(() => () => {}) })
      agentCtx.reflect.provide('skills', { register: () => () => {} })
      agentCtx.reflect.provide('systemPrompt', { section: (spec: Section) => { sections.set(sessionId, spec); return () => {} } })
      // The Session's own preset mounts the compaction backend and the title service, which the runtime's recovery reaches through it.
      agentCtx.reflect.provide('compaction', compactionService(sessionId))
      agentCtx.reflect.provide('sessionTitle', titleService(sessionId))
      const inbox = { nextTurn: [] as UserMessage[], nextStep: [] as UserMessage[],
        // A pending message taken out, as DSH's inbox does by its id.
        remove: (id: string) => [inbox.nextTurn, inbox.nextStep].some(list => {
          const at = list.findIndex(message => message.id === id)
          if (at >= 0) list.splice(at, 1)
          return at >= 0
        }) }
      // A step claims each message once, all that wait for a step and, as a turn starts, the next queued one, and takes them into
      // the Session's history, unless it is `cut` off before, as a cancel in its pre-step does; DSH says each.
      const taken = new Set<string>()
      let turn = 0
      const take = (starts: boolean, cut = false) => {
        const agent = agents.get(sessionId)!
        const queued = starts ? inbox.nextTurn.filter(message => !taken.has(message.id)).slice(0, 1) : []
        for (const message of [...inbox.nextStep.filter(item => !taken.has(item.id)), ...queued]) {
          taken.add(message.id)
          ctx.emit('agent/inbox/claimed', { agent, message, turn } as never)
          if (!cut) {
            logs.get(sessionId)!.push({ type: 'user/message', data: message })
            ctx.emit('session/event', session as never, { type: 'user/message', data: message } as never)
          }
        }
      }
      steps.set(sessionId, () => { take(false) })
      claims.set(sessionId, () => { take(false, true) })
      const deliver = (mode: 'queue' | 'steer') => vi.fn((message: UserMessage) => {
        inbox[mode === 'queue' ? 'nextTurn' : 'nextStep'].push(message)
        deliveries({ sessionId, mode, id: message.id, text: message.content.map(block => block.type === 'text' ? block.text : '').join('') })
        // A message wakes an idle agent: its turn starts at once, and DSH says so, and its first step takes what waits.
        const agent = agents.get(sessionId)!
        if (agent.status !== 'idle') return
        agent.status = 'running'
        ctx.emit('agent/status', { agent, status: 'running' } as never)
        turn++
        take(true)
      })
      const session = { id: sessionId, requestHeader: () => undefined, append: vi.fn(),
        // DSH stamps a sequence on every log event and derives the model-visible surface from them; the fixture numbers its log the
        // same way, so a compaction range names what the model would see and not a private array position.
        snapshotEvents: () => logs.get(sessionId)!.map((event, seq) => ({ ...event, seq })),
        // The history DSH derives for the next request: the same surface, as the messages a request carries. A range a compaction
        // replaced is absent from it, which is what makes a measurement of it a measurement of what the model is actually given.
        deriveMessages: () => visibleMessages(logs.get(sessionId)!),
        surface: { get nodes() { return surfaceOf(logs.get(sessionId)!).map(node => node.seq) } } }
      let status = 'idle'
      const idle: (() => void)[] = []
      // A cancel drops the inbox unless kept, and the turn it stops ends a moment later, which DSH says.
      const cancel = vi.fn((_cause: unknown, options?: { keepInbox?: boolean }) => {
        if (!options?.keepInbox) { inbox.nextTurn.length = 0; inbox.nextStep.length = 0 }
        if (status === 'idle') return
        queueMicrotask(() => {
          const agent = agents.get(sessionId)!
          if (agent.status === 'idle') return
          agent.status = 'idle'
          ctx.emit('agent/status', { agent, status: 'idle' } as never)
        })
      })
      agents.set(sessionId, { id: sessionId, ctx: agentCtx, inbox, followup: deliver('queue'), steer: deliver('steer'), inject: vi.fn(), session, cancel,
        get status() { return status }, set status(next: string) { status = next; if (next === 'idle') for (const wake of idle.splice(0)) wake() },
        // Once its turn ended, as DSH's does.
        whenIdle: () => status === 'idle' ? Promise.resolve() : new Promise<void>(resolve => { idle.push(resolve) }) } as never)
    }),
    selectModel: vi.fn(async () => {}), resolveAgent: vi.fn(resolveDefault), rename: vi.fn(async () => {}),
    prompt: vi.fn(() => { throw new Error('Plugin delivery must not use user RPC') }),
    inspect: vi.fn(async () => ({ events: [] })),
  }
  const reader = { read: async () => ({ events: [] }), [Symbol.asyncDispose]: async () => {} }
  const persistence = { flush: vi.fn(async () => {}), open: vi.fn(async () => reader) }
  const webServer = { host: '127.0.0.1', port: 3082, register: (route: { handler: HttpHandler }) => { http = route.handler; return () => {} } }
  const jobs = jobRegistry(id => agents.get(id))
  const subagents = subagentRuntime(agents)
  const ctx = new Context()
  /** The capabilities the fixture's one adapter declares, which a test may change while the Runtime runs. */
  const modelRoute: RouteUnderTest = { ...options.route }
  /** The adapter a request reaches when nothing refuses it, which records the request DSH would have sent. */
  const asked = vi.fn<(options: GenerateOptions) => void>()
  /**
   * The request as DSH hands it to its adapter, which is not the one the caller assembled: files become handle text, and
   * the tool declarations are projected through the route's tool update mode — including the historical definitions
   * `toolHistory` holds. These are DSH's own projection functions in DSH's own order (`adapterStream`), so what `asked`
   * records is what a provider would have been sent.
   */
  const projected = (options: GenerateOptions): GenerateOptions => {
    let messages: readonly RequestMessage[] = options.messages
    if (messages.some(message => contentHasFile(message.content))) messages = projectFilesToText(messages, () => '/attachments/fixture')
    const projected = projectToolUpdates(messages, options.tools, modelRoute.toolUpdate, options.toolHistory)
    return { ...options, messages: [...projected.messages],
      ...(projected.tools === undefined || options.tools === undefined ? {} : { tools: [...projected.tools] }) }
  }
  const adapter = (options: GenerateOptions): AsyncIterable<StreamChunk> => {
    asked(projected(options))
    return (async function* () {
      yield { type: 'text-delta', index: 0, text: 'ok' } as StreamChunk
      yield { type: 'finish', reason: { kind: 'stop' } } as StreamChunk
    })()
  }
  // DSH dispatches every model call, foreground or background, through the `llm/stream` waterfall, which may veto it.
  const llm = { resolveCallConfig: vi.fn(async (value: unknown) => value),
    // The exact model metadata the route declares, which is what decides the projection above.
    resolveModelInfo: vi.fn(async (provider: string, model: string) => {
      if (modelRoute.unresolved) throw new Error(`no adapter describes ${provider}/${model}`)
      return { provider, id: model, name: model, ...(modelRoute.toolUpdate === undefined ? {} : { toolUpdate: modelRoute.toolUpdate }) }
    }),
    stream: (options: GenerateOptions) => ctx.waterfall(llm as never, 'llm/stream', options, () => adapter(options)) }
  const services = { agents, llm, sessionController: controller,
    sessionPersistence: persistence, workspaceRegistry: { create: async (cwd: string) => ({ id: cwd }) }, permissionPresets: { set: () => {} }, subprocess, webServer,
    jobs: jobs.service, subagents: subagents.service }
  for (const [name, service] of Object.entries({ ...services, ...options.services })) ctx.reflect.provide(name, service)
  for (const cli of [AGENT, BOT]) writeFileSync(cli, '#!/bin/sh\n', { mode: 0o755 })
  const seeded = new Store(join(directory, 'orchestrator.sqlite'))
  const sources = { github: { enabled: true, config: { repository: 'acme/widgets', cli: AGENT } }, feishu: { enabled: true, config: { cli: BOT } } }
  seeded.saveSettings(SettingsSchema.parse({ ...seeded.settings(), sources }))
  seed?.(seeded)
  seeded.close()
  const runtime = new Runtime(ctx, testMachine({ stateDir: directory, ...options.machine }), vi.fn())
  await runtime.ready
  runtime.sources.register(feishuKind); runtime.sources.register(githubKind)
  const settings = runtime.store.settings()
  runtime.store.saveSettings({ ...settings, eval: { ...settings.eval, mode: 'auto' },
    policy: { ...settings.policy, sources: { feishu: { allowed: [{ id: MEMBER, name: 'Alice' }], syncChat: CHAT }, github: { allowed: [{ id: 'alice' }] } } },
    sources: { ...sources, feishu: { enabled: true, config: { cli: BOT, chats: [{ chatId: CHAT, listen: 'all' }], directMessages: true } } } })
  deliveries.mockClear()

  /** Parsed JSON payloads delivered to `sessionId`. */
  const relays = (sessionId: string) => deliveries.mock.calls.map(([call]) => call).filter(call => call.sessionId === sessionId)
    .map(call => JSON.parse(call.text) as Record<string, unknown>)
  const candidates = () => relays(runtime.masterId).filter(item => item.kind === 'candidate').map(item => item.trigger_id)
  const runTool = async (sessionId: string, name: string, args: unknown) => {
    const tool = tools.get(sessionId)?.get(name)
    if (!tool) throw new Error(`Tool ${name} is not registered for ${sessionId}`)
    return await tool.execute(args, { signal: new AbortController().signal }) as Record<string, unknown>
  }
  /** Route one decision with the main Session's orchestrator_route, answering its result; a refused one throws its reason. */
  async function route(item: Record<string, unknown>): Promise<Record<string, unknown>> {
    const { results } = await runTool(runtime.masterId, 'orchestrator_route', { decisions: [item] }) as { results: Record<string, unknown>[] }
    if (results[0]!.refused) throw new Error(String(results[0]!.refused))
    return results[0]!
  }
  async function acceptedTicket(trigger: Trigger) {
    runtime.receive(trigger)
    await runtime.idle()
    const result = await route({ kind: 'accept', trigger_id: trigger.id, title: `Fix ${trigger.id}`, worktree_name: 'fix-regression', acknowledgement: '收到，修复回归。' })
    await runtime.idle()
    const ticket = runtime.store.tickets.get((result.ticket as { ticket_id: string }).ticket_id)!
    return { trigger, ticket, sessionId: `worker-${ticket.id}` }
  }
  async function api(method: string, path: string, json?: unknown) {
    let status = 0, text = ''
    const chunks = json === undefined ? [] : [Buffer.from(JSON.stringify(json))]
    const req = { method, url: `/orchestrator/api/${path}`, headers: { host: '127.0.0.1:3082', 'x-orchestrator-request': '1' }, async *[Symbol.asyncIterator]() { yield* chunks } }
    await http(req, { writeHead: (code: number) => { status = code }, end: (data: string) => { text = data } })
    return { status, body: JSON.parse(text) as Record<string, unknown> }
  }
  async function stop() { await runtime.stop(); vi.restoreAllMocks(); if (!options.stateDir) rmSync(directory, { recursive: true, force: true }) }
  /** The Session's model takes its next step, which takes the messages steered in since its last. */
  const step = (sessionId: string) => { steps.get(sessionId)!() }
  /** A step of the worker claims what waits for it, and is cut off before the Session took it. */
  const claim = (sessionId: string) => { claims.get(sessionId)!() }
  /** The model request a loop would build for `sessionId`: its system prompt, its tool definitions and the history it took. */
  const request = (sessionId: string, overrides: Partial<GenerateOptions> = {}): GenerateOptions => {
    const messages: unknown[] = [{ role: 'system', content: [{ type: 'text', text: sections.get(sessionId)?.text({}) ?? '' }],
      source: { kind: 'system-prompt' } }]
    // The history is the Session's surface, not its log: a compaction replacement shadows the range it replaced, and a request
    // that would still read the shadowed events could never show that recovery worked.
    for (const event of surfaceOf(logs.get(sessionId) ?? [])) {
      const data = (event.data ?? {}) as { message?: { content?: unknown }; content?: unknown; source?: unknown }
      if (event.type === 'user/message') messages.push({ role: 'user', content: data.content, source: data.source })
      else if (event.type === 'assistant/message') messages.push({ role: 'assistant', content: data.message?.content })
      else if (event.type === 'tool/result') messages.push({ role: 'tool', content: data.message?.content })
    }
    return { provider: 'deepseek', model: 'deepseek-chat', messages, tools: definitionsOf(sessionId), sessionId: sessionId as never,
      ...overrides } as GenerateOptions
  }
  /** Ask the model for `sessionId` as the loop does, through the `llm/stream` waterfall, and return what came back. */
  const ask = async (sessionId: string, overrides: Partial<GenerateOptions> = {}) => {
    const options = request(sessionId, overrides)
    const chunks: StreamChunk[] = []
    for await (const chunk of ctx.llm.stream(options)) chunks.push(chunk)
    const failures = chunks.flatMap(chunk => chunk.type === 'finish' && chunk.reason.kind === 'error' ? [chunk.reason.failure] : [])
    return { options, chunks, failures }
  }
  /** Dispatch a hand-built request — one that belongs to no Session, as a background job's does — through the same waterfall. */
  const streamed = async (options: GenerateOptions) => {
    const chunks: StreamChunk[] = []
    for await (const chunk of ctx.llm.stream(options)) chunks.push(chunk)
    const failures = chunks.flatMap(chunk => chunk.type === 'finish' && chunk.reason.kind === 'error' ? [chunk.reason.failure] : [])
    return { options, chunks, failures }
  }
  return { runtime, ctx, directory, agents, tools, sections, logs, deliveries, relays, candidates, runTool, route, modelRoute, acceptedTicket, api, controller, subprocess,
    hooks, resolveDefault, stop, jobs, subagents, step, claim, request, ask, streamed, asked, dsh, surfaceOf }
}
export type Host = Awaited<ReturnType<typeof startRuntime>>
