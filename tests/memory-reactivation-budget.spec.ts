/**
 * The allowance automatic reactivation runs under, at the Runtime integration boundary: a strong cue wakes an old experience without a
 * person asking, and it keeps doing so — a bounded number of notices inside a moving window rather than a count one process spends once
 * and can only get back by restarting. What is asserted is what the model was handed (the delivered notices, parsed as the model reads
 * them) and what the memory says about itself (the published experiences, the records, the allowance it reports), never an internal call.
 */
import { Context } from '@deepseek-ai/cordis'
import type { GenerateOptions, StreamChunk, UserMessage } from '@deepseek-ai/dsh-llm'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import type { Trigger } from '../src/core/index.ts'
import { Runtime } from '../src/app/runtime.ts'
import { Sessions } from '../src/app/sessions.ts'
import { Effects } from '../src/app/effects.ts'
import { Store } from '../src/app/store.ts'
import { Commands } from '../src/infra/commands.ts'
import { credentialHelper, workerGitConfig } from '../src/infra/environment.ts'
import { SettingsSchema } from '../src/policy.ts'
import type { Machine } from '../src/deployment.ts'
import type { MemoryRecord } from '../src/memory/model.ts'
import { WakeAllowance, WAKE_DEDUPE_MAX, WAKE_DEDUPE_WINDOWS } from '../src/memory/wake.ts'
import { feishuKind } from '../src/sources/feishu.ts'
import { githubKind } from '../src/sources/github.ts'
import { fakeSession, feishu, jobRegistry, subagentRuntime, CHAT, MEMBER } from './fixtures/host.ts'
import { reference, testMachine } from './fixtures/deployment.ts'

type RegisteredTool = { name: string; execute: (args: unknown, execution: { signal: AbortSignal }) => Promise<unknown> }
type Section = (context: { signal?: AbortSignal }) => string
/** One message the runtime delivered, in the form the model reads. */
interface Delivered { sessionId: string; mode: string; id: string; text: string; form?: string }
/** One published op, as the journal holds it. */
interface JournalOp { t: string; seq: number; version: number; opId: string; at: string; policy: string; record: MemoryRecord }
/** One background request, parsed the way the model reads it. */
interface Requested { job_id: string; task: string; principles: string; evidence: { id: string; text: string }[] }

/** The original of the experience the allowance is walked with, long enough to need a gist: a dated report with a constraint. */
const ORIGINAL = 'Alice: the settings page cache went stale again on 2026-03-04 and the deploy did not rebuild it, so the settings '
  + 'page keeps serving the old bundle to every viewer long after the fix was merged. Do not raise the threshold before the freeze ends.'
/** What routine recall shows of it once it is read short, which is what a wake hands the model first. */
const GIST = 'On 2026-03-04 the settings page cache went stale and the deploy did not rebuild it, so the settings page keeps serving '
  + 'the old bundle. Do not raise the threshold before the freeze ends.'
/** A later message that shares many cues with the original, which is what a strong correlation is made of. */
const CUE = 'the settings page cache is stale again and the deploy did not rebuild it'
/** Unrelated work from the same person: the same two identity cues, and nothing else the original is about. */
const EXPORT = '@bot the export button is broken for every viewer on the release train, and the staging branch shows a spinner'
/** A situation that shares no subject with either: a cue too weak to wake anything, which is a property the allowance must keep. */
const WEAK = 'the weekly planning note is due next quarter'

let stateDir: string, runtime: Runtime, machine: Machine
const agents = new Map<string, unknown>(), tools = new Map<string, Map<string, RegisteredTool>>(), sections = new Map<string, Section>()
const logs = new Map<string, { type: string; data: unknown }[]>(), delivered: Delivered[] = []
let answers: Record<string, string> = {}
let agentGh = '', larkBot = ''
/** Every model request the runtime made, foreground or background, in the order the adapter would have seen them. */
let asked: GenerateOptions[] = []
let enqueue: MockInstance

/** The text of the one message a hand-built background request carries. */
const textOf = (options: GenerateOptions): string => (options.messages[0]!.content as readonly { type: string; text?: string }[])
  .map(block => block.text ?? '').join('')
/** The parsed request one background call carries. */
const requested = (options: GenerateOptions): Requested => JSON.parse(textOf(options)) as Requested
/** The answer a controlled model gives: the gist for the compression job, and a high importance for everything else. */
const answer = (options: GenerateOptions): string => {
  const said = requested(options)
  if (said.task === 'compression')
    return JSON.stringify({ job_id: said.job_id, summary: GIST, sources: said.evidence.map(item => item.id) })
  return JSON.stringify({ job_id: said.job_id, score: 100, rationale: 'a person reported a defect that still blocks the work',
    cited: [said.evidence[0]!.id], uncertain: [] })
}

/** Start the runtime on this test's state directory: a fresh Context, the same fake DSH host, and the same state. */
async function boot(overrides: Partial<Machine> = {}): Promise<void> {
  const controller = {
    create: vi.fn(async ({ sessionId }: { sessionId: string }) => {
      if (agents.has(sessionId)) return
      const agentCtx = new Context()
      const own = new Map<string, RegisteredTool>()
      tools.set(sessionId, own); logs.set(sessionId, [])
      agentCtx.reflect.provide('tools', { register: (tool: RegisteredTool) => { own.set(tool.name, tool); return () => own.delete(tool.name) },
        get: () => undefined, restrict: vi.fn(() => () => {}), guard: vi.fn(() => () => {}) })
      agentCtx.reflect.provide('skills', { register: () => () => {} })
      agentCtx.reflect.provide('systemPrompt', { section: (spec: { text: Section }) => { sections.set(sessionId, spec.text); return () => {} } })
      const inbox = { nextTurn: [] as UserMessage[], nextStep: [] as UserMessage[],
        remove: (id: string) => [inbox.nextTurn, inbox.nextStep].some(list => {
          const at = list.findIndex(message => message.id === id)
          if (at >= 0) list.splice(at, 1)
          return at >= 0
        }) }
      const take = (mode: string) => vi.fn((message: UserMessage) => {
        const form = (message.source as { form?: string }).form
        delivered.push({ sessionId, mode, id: message.id, text: message.content.map(block => block.type === 'text' ? block.text : '').join(''),
          ...(form === undefined ? {} : { form }) })
        if (mode === 'inject') logs.get(sessionId)!.push({ type: 'user/message', data: message })
        else inbox[mode === 'queue' ? 'nextTurn' : 'nextStep'].push(message)
      })
      let status = 'idle'
      agents.set(sessionId, { id: sessionId, ctx: agentCtx, inbox, followup: take('queue'), steer: take('steer'), inject: take('inject'),
        session: fakeSession(sessionId, () => logs.get(sessionId)!),
        get status() { return status }, set status(next: string) { status = next }, cancel: vi.fn(), whenIdle: async () => {} })
    }),
    selectModel: vi.fn(async () => {}), rename: vi.fn(async () => {}),
    resolveAgent: vi.fn(async (id: string) => agents.has(id) ? { agent: agents.get(id) } : { error: { code: 'session/not-found' } }),
    prompt: vi.fn(() => { throw new Error('Plugin delivery must not use user RPC') }), inspect: vi.fn(async () => ({ events: [] })),
  }
  // The Session's own history, read back the way DSH's persistence holds it: this is what makes a delivery idempotent across a restart,
  // so a notice a crash redelivered lands no second copy rather than being counted as one this process never gave.
  const reader = (id: string) => ({ read: async (offset: number, limit: number) => ({ events: (logs.get(id) ?? []).slice(offset, offset + limit) }),
    [Symbol.asyncDispose]: async () => {} })
  const stream = (text: string) => ({ readFrom: () => ({ text, nextOffset: text.length, lossy: false }) })
  const subprocess = { spawn: vi.fn((spec: { argv: readonly string[] }) => {
    const argv = [...spec.argv]
    while (argv[0] === 'env' || /^[A-Z_]+=/.test(argv[0] ?? '')) argv.shift()
    return { done: Promise.resolve({ exitCode: 0, signal: null }), collected: { stdout: stream(answers[argv.join(' ')] ?? ''), stderr: stream('') } }
  }) }
  const jobs = jobRegistry(id => agents.get(id) as never), subagents = subagentRuntime(agents as never)
  const ctx = new Context()
  // Every model call, foreground or background, is dispatched through the `llm/stream` waterfall, which the request budget listens on.
  const llm = { resolveCallConfig: vi.fn(async (value: unknown) => value),
    stream: (options: GenerateOptions): AsyncIterable<StreamChunk> => {
      const next = (): AsyncIterable<StreamChunk> => {
        asked.push(options)
        return (async function* () {
          yield { type: 'text-delta', index: 0, text: answer(options) } as StreamChunk
          yield { type: 'finish', reason: { kind: 'stop' } } as StreamChunk
        })()
      }
      return ctx.waterfall(llm as never, 'llm/stream', options, next)
    } }
  const services = { agents, llm, sessionController: controller,
    sessionPersistence: { flush: vi.fn(async () => {}), open: vi.fn(async (id: string) => reader(id)) },
    workspaceRegistry: { create: async (cwd: string) => ({ id: cwd }) }, permissionPresets: { set: () => {} }, subprocess,
    webServer: { host: '127.0.0.1', port: 3082, register: () => () => {} }, jobs: jobs.service, subagents: subagents.service }
  for (const [name, service] of Object.entries(services)) ctx.reflect.provide(name, service)
  machine = testMachine({ stateDir, ...overrides })
  const model = { provider: 'deepseek', model: 'deepseek-chat' }
  const seeded = new Store(join(stateDir, 'orchestrator.sqlite'))
  seeded.saveSettings(SettingsSchema.parse({ ...seeded.settings(), eval: { ...seeded.settings().eval, model },
    sources: { github: { enabled: true, config: { repository: 'acme/widgets', cli: agentGh } }, feishu: { enabled: true, config: { cli: larkBot } } } }))
  seeded.close()
  runtime = new Runtime(ctx, machine, vi.fn())
  await runtime.ready
  runtime.sources.register(feishuKind); runtime.sources.register(githubKind)
  const settings = runtime.store.settings()
  runtime.store.saveSettings(SettingsSchema.parse({ ...settings, eval: { ...settings.eval, mode: 'auto', model },
    policy: { ...settings.policy, sources: { feishu: { allowed: [{ id: MEMBER, name: 'Alice' }], syncChat: CHAT }, github: { allowed: [{ id: 'alice' }] } } },
    sources: { github: { enabled: true, config: { repository: 'acme/widgets', cli: agentGh } },
      feishu: { enabled: true, config: { cli: larkBot, chats: [{ chatId: CHAT, listen: 'all' }], directMessages: true } } } }))
}

beforeEach(() => {
  // The clock belongs to the test: the fixture's messages are dated 2026-09-09, and the allowance replenishes by the clock.
  vi.useFakeTimers({ toFake: ['Date'], now: Date.parse('2026-09-10T00:00:00.000Z') })
  asked = []
  agents.clear(); tools.clear(); sections.clear(); logs.clear(); delivered.length = 0
  stateDir = mkdtempSync(join(tmpdir(), 'memory-reactivation-'))
  agentGh = join(stateDir, 'agent-gh'); larkBot = join(stateDir, 'lark-bot')
  for (const cli of [agentGh, larkBot]) writeFileSync(cli, '#!/bin/sh\n', { mode: 0o755 })
  const repository = { default_branch: 'master', permissions: { push: true } }
  vi.spyOn(Commands.prototype, 'gh').mockImplementation(async args => args[1] === 'user' ? { login: 'agent-bot' } : repository)
  vi.spyOn(Commands.prototype, 'lark').mockResolvedValue({ users: [{ member_id: MEMBER, name: 'Alice' }], has_more: false })
  vi.spyOn(Commands.prototype, 'git').mockResolvedValue('')
  vi.spyOn(Commands.prototype, 'run').mockResolvedValue('{"ok":true,"data":{}}')
  enqueue = vi.spyOn(Effects.prototype, 'enqueue')
  answers = {
    [`${agentGh} api user`]: '{"login":"agent-bot","id":7}',
    [`${agentGh} api repos/acme/widgets --jq {name: .full_name, push: .permissions.push}`]: '{"name":"acme/widgets","push":true}\n',
    [`${larkBot} auth status`]: JSON.stringify({ appId: 'cli_bot', brand: 'feishu', identities: { bot: { status: 'ready' } } }),
    [`${larkBot} config strict-mode`]: 'strict-mode: bot (source: profile)',
    [`${larkBot} api GET /open-apis/bot/v3/info --as bot --format ndjson`]: '{"bot":{"open_id":"ou_bot"},"code":0,"msg":"ok"}',
    ['git config -z --show-origin --get-all credential.https://github.com.helper']: `file:${workerGitConfig(stateDir)}\0${credentialHelper(agentGh)}\0`,
    ['git config -z --show-scope --get-regexp ^(credential\\..*|http\\..*extraheader)$']:
      `global\0credential.helper\n\0global\0credential.https://github.com.helper\n${credentialHelper(agentGh)}\0`,
  }
})
afterEach(async () => { await runtime?.stop(); vi.restoreAllMocks(); vi.useRealTimers(); rmSync(stateDir, { recursive: true, force: true }) })

/** Run one registered tool of a Session, as the Session's model does. */
const runTool = async (sessionId: string, name: string, args: unknown) => await tools.get(sessionId)!.get(name)!
  .execute(args, { signal: new AbortController().signal }) as Record<string, unknown>
/** Receive a trigger, let the runtime settle, and settle the background jobs it started. */
async function receive(trigger: Trigger): Promise<void> {
  runtime.receive(trigger)
  await runtime.idle()
  await runtime.memory.settle()
}
/** Move the clock `ms` forward and let the runtime settle, which is how a window passes in this test. */
async function advance(ms: number): Promise<void> {
  vi.setSystemTime(new Date(Date.now() + ms))
  await runtime.idle()
}
/** The memory's root, inside the state directory the runtime locked. */
const memoryDir = (): string => join(stateDir, 'memory')
/** The published ops, in the order they were appended. */
const ops = (): JournalOp[] => readdirSync(join(memoryDir(), 'journal')).filter(name => name.endsWith('.ndjson')).sort()
  .flatMap(name => readFileSync(join(memoryDir(), 'journal', name), 'utf8').split('\n').filter(line => line !== '')
    .map(line => JSON.parse(line) as JournalOp))
/** The capture payloads the Engine's transaction handed the durable queue, which is what the queue redelivers after a crash. */
const captures = (): { key: string; payload: unknown }[] => enqueue.mock.calls
  .filter(([kind]) => kind === 'memory').map(([, key, payload]) => ({ key: key as string, payload }))
/** The id of each experience the journal published, in the order it first appeared. */
const ids = (): string[] => [...new Set(ops().map(op => op.record.experience.id))]
/** The record one experience has in the published version. */
const recordOf = (id: string): MemoryRecord => runtime.memory.service.record(id)!
/** What the allowance says about itself, which is the status an operator and this test read a non-wake off. */
const allowance = () => runtime.memory.status().wake
/** The recalled-memory notices one Session was sent, parsed as the model reads them. */
const notices = (sessionId: string): Record<string, unknown>[] => delivered
  .filter(item => item.sessionId === sessionId && item.form === 'recall')
  .map(item => JSON.parse(item.text) as Record<string, unknown>)
/** The experience ids one notice carries. */
const shownBy = (notice: Record<string, unknown> | undefined): string[] =>
  ((notice?.items ?? []) as { id: string }[]).map(item => item.id)

describe('the allowance automatic reactivation runs under', () => {
  it('keeps waking old experiences past the eighth notice, and takes the quota back when its window passes', async () => {
    await boot({ memoryRecallWindowMs: reference(60_000) })
    // Thirteen messages about the same defect, each a new experience that repeats enough of the ones before it to wake them.
    for (let index = 0; index < 13; index++) await receive(feishu(String(index + 1), `${CUE} in release ${index}`))
    // One window holds eight notices, and the ninth cue waits for the window to pass rather than being refused for good.
    expect(notices(runtime.masterId)).toHaveLength(8)
    expect(allowance()).toMatchObject({ notices: 8, capacity: 8, windowMs: 60_000 })
    expect(allowance().last).toMatchObject({ outcome: 'quota' })
    expect(allowance().nextAt).toBe('2026-09-10T00:01:00.000Z')
    // The window passes on its own: nothing was restarted, nothing was managed, and the allowance is whole again.
    await advance(60_000)
    expect(allowance()).toMatchObject({ notices: 0 })
    await receive(feishu('14', `${CUE} in release 13`))
    expect(allowance().last).toMatchObject({ outcome: 'delivered' })
    expect(notices(runtime.masterId)).toHaveLength(9)
    // The ninth notice is the work the spent allowance had held back: the five experiences no earlier notice carried.
    expect(shownBy(notices(runtime.masterId)[8]).sort()).toEqual(ids().slice(8, 13).sort())
    // Waking writes nothing: the store is exactly the fourteen captures and not one experience more.
    expect(ids()).toHaveLength(14)
    expect(recordOf(ids()[0]!).representation.cues.length).toBeGreaterThan(0)
  })

  it('shows one unchanged experience once, and lets it wake again only when the dedupe lets it go', async () => {
    await boot({ memoryRecallWindowMs: reference(60_000) })
    await receive(feishu('1', ORIGINAL))
    await receive(feishu('2', CUE))
    expect(notices(runtime.masterId)).toHaveLength(1)
    expect(shownBy(notices(runtime.masterId)[0])).toEqual([ids()[0]])
    expect(allowance()).toMatchObject({ notices: 1, capacity: 8 })
    // The same capture offered again by the queue matches only what this Session already has: nothing is pushed, and the status says why.
    const second = captures()[1]!
    runtime.effects.enqueue('memory', second.key, second.payload as never)
    await runtime.idle()
    expect(notices(runtime.masterId)).toHaveLength(1)
    expect(allowance().last).toMatchObject({ outcome: 'duplicate' })
    expect(runtime.health['memory-store']!.detail).toContain('already shown')
    // The dedupe's own memory is bounded by time: after the windows it remembers an experience for, it holds nothing.
    await advance(WAKE_DEDUPE_WINDOWS * 60_000)
    // An experience nothing has changed may then wake again, because nothing says this Session still has it.
    await receive(feishu('3', `${CUE} in the staging branch`))
    expect(shownBy(notices(runtime.masterId)[1])).toContain(ids()[0])
  })

  it('wakes the experience a cue is about, not whichever one woke last, and wakes nothing on a cue too weak to say it', async () => {
    await boot({ memoryRecallWindowMs: reference(60_000) })
    await receive(feishu('1', ORIGINAL))
    await receive(feishu('2', EXPORT))
    // Each cue carries the correlation of its own subject: the cache cue wakes the cache report and nothing else.
    await receive(feishu('3', CUE))
    expect(shownBy(notices(runtime.masterId)[0])).toEqual([ids()[0]])
    await receive(feishu('4', `${EXPORT} again`))
    expect(shownBy(notices(runtime.masterId)[1])).toEqual([ids()[1]])
    expect(shownBy(notices(runtime.masterId)[1])).not.toContain(ids()[0])
    // A situation that shares no subject with either is under the policy's correlation: nothing wakes, and the status says which reason.
    await receive(feishu('5', WEAK))
    expect(notices(runtime.masterId)).toHaveLength(2)
    expect(allowance()).toMatchObject({ notices: 2 })
    expect(allowance().last).toMatchObject({ outcome: 'weak' })
    expect(runtime.health['memory-store']!.detail).toContain('shared cues')
  })

  it('wakes a forgotten experience as its gist, inside the request budget, and changes nothing durable', async () => {
    await boot({ memoryRecallWindowMs: reference(60_000) })
    await receive(feishu('1', ORIGINAL))
    const [id] = ids()
    const weight = runtime.memory.importance(id!), confidence = runtime.memory.confidence(id!), held = JSON.stringify(recordOf(id!))
    // Forty years on routine recall has left it behind, and it is still stored rather than deleted.
    await advance(40 * 365 * 86_400_000)
    expect(runtime.memory.service.recall({ scope: { project: 'acme/widgets' }, cues: ['cache', 'stale'], allowanceChars: 4000 })
      .items).toEqual([])
    await receive(feishu('2', CUE))
    const [notice] = notices(runtime.masterId)
    expect(shownBy(notice)).toEqual([id])
    // What the model is handed is the gist, never the original's detail, and the whole notice stays inside the request budget.
    expect((notice!.items as { summary?: boolean }[])[0]).toMatchObject({ summary: true })
    expect(JSON.stringify(notice)).not.toContain('every viewer')
    expect(delivered.find(item => item.form === 'recall')!.text.length).toBeLessThanOrEqual(machine.memoryRecallMaxChars.get())
    // And the wake raised nothing durable: the same weight, the same confidence, the same age, the same record, the same experiences.
    expect(runtime.memory.importance(id!)).toEqual(weight)
    expect(runtime.memory.confidence(id!)).toEqual(confidence)
    expect(JSON.stringify(recordOf(id!))).toBe(held)
    expect(ids()).toHaveLength(2)
  })

  it('spends no allowance on a cue the request had no room for, and wakes it once the room comes back', async () => {
    await boot({ memoryRecallWindowMs: reference(60_000) })
    await receive(feishu('1', ORIGINAL))
    // The Session's own history fills the request budget, so there is no room for recalled material at this instant.
    const budget = machine.requestMaxChars.get() - machine.requestOutputReserveChars.get() - machine.requestMeasurementReserveChars.get()
    const filler = { type: 'assistant/message', data: { message: { role: 'assistant', content: [{ type: 'text', text: 'x'.repeat(budget) }] } } }
    const log = logs.get(runtime.masterId)!
    log.push(filler)
    await receive(feishu('2', CUE))
    expect(runtime.memory.allowance(runtime.masterId)).toBe(0)
    expect(notices(runtime.masterId)).toHaveLength(0)
    // Nothing was spent, and the status names the request rather than the correlation as the reason.
    expect(allowance()).toMatchObject({ notices: 0, capacity: 8 })
    expect(allowance().last).toMatchObject({ outcome: 'no-room' })
    expect(runtime.health['memory-store']!.detail).toContain('no room for recalled material')
    // The room comes back as the pager moves that history out, and the cue the request had no room for wakes what it earns.
    log.splice(log.indexOf(filler), 1)
    expect(runtime.memory.allowance(runtime.masterId)).toBeGreaterThan(0)
    await receive(feishu('3', CUE))
    expect(allowance()).toMatchObject({ notices: 1 })
    expect(allowance().last).toMatchObject({ outcome: 'delivered' })
    expect(notices(runtime.masterId)).toHaveLength(1)
  })

  it('spends no allowance on a delivery that failed, and lands the notice once when the queue retries it', async () => {
    await boot({ memoryRecallWindowMs: reference(60_000) })
    await receive(feishu('1', ORIGINAL))
    expect(allowance().notices).toBe(0)
    // The recall delivery fails once, as an adapter that dropped the write would; every other delivery is untouched.
    const original = Sessions.prototype.prompt
    let dropped = false
    vi.spyOn(Sessions.prototype, 'prompt').mockImplementation(async function (this: Sessions, sessionId: string, requestId: string,
      text: string, mode: 'queue' | 'steer' | 'recall' | { inject: string }) {
      if (!dropped && mode === 'recall') { dropped = true; throw new Error('the adapter dropped the write') }
      return await original.call(this, sessionId, requestId, text, mode)
    })
    await receive(feishu('2', CUE))
    expect(notices(runtime.masterId)).toHaveLength(0)
    expect(allowance()).toMatchObject({ notices: 0, capacity: 8 })
    expect(allowance().last).toMatchObject({ outcome: 'failed' })
    expect(runtime.effects.pending('memory')).toBe(true)
    // The retry spends the one notice it would have spent, and the notice is delivered once rather than twice.
    await advance(2_000)
    await runtime.memory.settle()
    expect(allowance()).toMatchObject({ notices: 1 })
    expect(allowance().last).toMatchObject({ outcome: 'delivered' })
    expect(notices(runtime.masterId)).toHaveLength(1)
    expect(runtime.effects.pending('memory')).toBe(false)
  })

  it('begins a fresh window after a restart, and a redelivered cue lands no second copy', async () => {
    await boot({ memoryRecallWindowMs: reference(60_000) })
    for (let index = 0; index < 12; index++) await receive(feishu(String(index + 1), `${CUE} in release ${index}`))
    expect(notices(runtime.masterId)).toHaveLength(8)
    const version = runtime.memory.status().version
    await runtime.stop()
    await boot({ memoryRecallWindowMs: reference(60_000) })
    // A restart begins a new window, because the allowance is this process's own state; the store it reads is exactly what it wrote.
    expect(allowance()).toMatchObject({ notices: 0, capacity: 8 })
    expect(runtime.memory.status().version).toBe(version)
    // A cue new to this process wakes the experiences the spent allowance had held back.
    await receive(feishu('13', `${CUE} in release 12`))
    expect(allowance().last).toMatchObject({ outcome: 'delivered' })
    expect(notices(runtime.masterId)).toHaveLength(9)
    // The same capture offered again finds the notice already in DSH's own log, so a restart cannot turn a redelivery into a second copy.
    const last = captures().at(-1)!
    runtime.effects.enqueue('memory', last.key, last.payload as never)
    await runtime.idle()
    expect(notices(runtime.masterId)).toHaveLength(9)
  })

  it('bounds the dedupe by capacity too, so a run of woken experiences cannot grow it without end', () => {
    const wake = new WakeAllowance(() => ({ wakes: 8, windowMs: 60_000 }))
    const at = '2026-09-10T00:00:00.000Z'
    for (let index = 0; index < WAKE_DEDUPE_MAX + 5; index++) wake.record(at, [{ id: `experience-${index}`, version: 1 }])
    // The least recently shown is what it let go, so the oldest may wake again and the newest is still known.
    expect(wake.shown('experience-0', 1, at)).toBe(false)
    expect(wake.shown(`experience-${WAKE_DEDUPE_MAX + 4}`, 1, at)).toBe(true)
  })
})
