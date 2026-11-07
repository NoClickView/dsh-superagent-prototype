/**
 * Forgetting and reactivation at the Runtime integration boundary, with a clock the test owns: a Feishu message is captured, scored and
 * consolidated through the runtime's own path, an acceptance starts work that must outlive the memory of it, and then years pass. The
 * same routine recall stops returning the experience, states that it left rather than deleting it, and still lists and expands the
 * original; a later message with strong enough cues wakes the gist without a person asking, writes nothing, and changes no ticket;
 * a situation that shares nothing wakes nothing, and no clock movement starts a model call. Every assertion is on a surface the
 * runtime exposes — the service's recall, the read resource, the delivered notice, the store's open work and the job list — never
 * on an internal class.
 */
import { Context } from '@deepseek-ai/cordis'
import type { GenerateOptions, StreamChunk, UserMessage } from '@deepseek-ai/dsh-llm'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import type { Trigger } from '../src/core/index.ts'
import { Runtime } from '../src/app/runtime.ts'
import { Effects } from '../src/app/effects.ts'
import { Store } from '../src/app/store.ts'
import { Commands } from '../src/infra/commands.ts'
import { credentialHelper, workerGitConfig } from '../src/infra/environment.ts'
import { SettingsSchema } from '../src/policy.ts'
import type { Machine } from '../src/deployment.ts'
import type { MemoryRecord } from '../src/memory/model.ts'
import { feishuKind } from '../src/sources/feishu.ts'
import { githubKind } from '../src/sources/github.ts'
import { cuesOf } from '../src/memory/retrieval.ts'
import { fakeSession, feishu, jobRegistry, subagentRuntime, CHAT, MEMBER } from './fixtures/host.ts'
import { testMachine } from './fixtures/deployment.ts'

type RegisteredTool = { name: string; execute: (args: unknown, execution: { signal: AbortSignal }) => Promise<unknown> }
type Section = (context: { signal?: AbortSignal }) => string
/** One message the runtime delivered, in the form the model reads. */
interface Delivered { sessionId: string; mode: string; id: string; text: string; form?: string }
/** One published op, as the journal holds it. */
interface JournalOp { t: string; seq: number; version: number; opId: string; at: string; policy: string; record: MemoryRecord }
/** One background request, parsed the way the model reads it. */
interface Requested { job_id: string; task: string; principles: string; evidence: { id: string; text: string }[] }

/** The original of the experience the ladder is walked with, long enough to need a gist, carrying a date, a negation and a constraint. */
const ORIGINAL = 'Alice: the settings page cache went stale again on 2026-03-04 and the deploy did not rebuild it, so the settings '
  + 'page keeps serving the old bundle to every viewer long after the fix was merged. Do not raise the threshold before the freeze ends.'
/** What routine recall shows of it once it is read short: the same date, negation and constraint, and less of the rest. */
const GIST = 'On 2026-03-04 the settings page cache went stale and the deploy did not rebuild it, so the settings page keeps serving '
  + 'the old bundle. Do not raise the threshold before the freeze ends.'
/** A later message that shares many cues with the original, which is what a strong correlation is made of. */
const CUE = 'the settings page cache is stale again and the deploy did not rebuild it'
/** Unrelated work from the same person: the same two identity cues, and nothing else the original is about. */
const EXPORT = '@bot the export button is broken for every viewer on the release train, and the staging branch shows a spinner when '
  + 'the report is regenerated, so please check the download path and the retry policy'

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
async function boot(): Promise<void> {
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
  const reader = { read: async () => ({ events: [] }), [Symbol.asyncDispose]: async () => {} }
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
    sessionPersistence: { flush: vi.fn(async () => {}), open: vi.fn(async () => reader) },
    workspaceRegistry: { create: async (cwd: string) => ({ id: cwd }) }, permissionPresets: { set: () => {} }, subprocess,
    webServer: { host: '127.0.0.1', port: 3082, register: () => () => {} }, jobs: jobs.service, subagents: subagents.service }
  for (const [name, service] of Object.entries(services)) ctx.reflect.provide(name, service)
  machine = testMachine({ stateDir })
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
  // The clock belongs to the test: the fixture's messages are dated 2026-09-09, and a memory's age is what this instant makes it.
  vi.useFakeTimers({ toFake: ['Date'], now: Date.parse('2026-09-10T00:00:00.000Z') })
  asked = []
  agents.clear(); tools.clear(); sections.clear(); logs.clear(); delivered.length = 0
  stateDir = mkdtempSync(join(tmpdir(), 'memory-forgetting-runtime-'))
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
/** Accept one trigger as work, so a ticket exists that ordinary forgetting must not close. */
async function accept(trigger: Trigger): Promise<string> {
  await receive(trigger)
  const { results } = await runTool(runtime.masterId, 'orchestrator_route', { decisions: [{ kind: 'accept', trigger_id: trigger.id,
    title: `Fix ${trigger.id}`, worktree_name: 'fix-regression', acknowledgement: '收到，修复回归。' }] }) as
    { results: Record<string, unknown>[] }
  if (results[0]!.refused) throw new Error(String(results[0]!.refused))
  await runtime.idle()
  return (results[0]!.ticket as { ticket_id: string }).ticket_id
}
/** The memory's root, inside the state directory the runtime locked. */
const memoryDir = (): string => join(stateDir, 'memory')
/** The published ops, in the order they were appended. */
const ops = (): JournalOp[] => readdirSync(join(memoryDir(), 'journal')).filter(name => name.endsWith('.ndjson')).sort()
  .flatMap(name => readFileSync(join(memoryDir(), 'journal', name), 'utf8').split('\n').filter(line => line !== '')
    .map(line => JSON.parse(line) as JournalOp))
/** The id of each experience the journal published, in the order it first appeared. */
const ids = (): string[] => [...new Set(ops().map(op => op.record.experience.id))]
/** The record one experience has in the published version. */
const recordOf = (id: string): MemoryRecord => runtime.memory.service.record(id)!
/** What routine recall of `cues` returns for the project. */
const recall = (cues: string[]) => runtime.memory.service.recall({ scope: { project: 'acme/widgets' }, cues, allowanceChars: 4000 })
/** What the memory read resource answers for a Session. */
const listFor = async (sessionId: string) => await runTool(sessionId, 'orchestrator_read', { resource: 'memory' }) as
  { version: number; total: number; items: { id: string; preview: string; read: string }[] }
/** The recalled-memory notices one Session was sent, parsed as the model reads them. */
const notices = (sessionId: string): Record<string, unknown>[] => delivered
  .filter(item => item.sessionId === sessionId && item.form === 'recall')
  .map(item => JSON.parse(item.text) as Record<string, unknown>)
/** Move the clock to `iso` and let the runtime settle, which is how years pass in this test. */
async function later(iso: string): Promise<void> {
  vi.setSystemTime(new Date(iso))
  await runtime.idle()
}

describe('forgetting across years at the runtime boundary', () => {
  it('stops returning a routine experience, still keeps it, wakes its gist on a strong cue, and closes no open work', async () => {
    await boot()
    await receive(feishu('1', ORIGINAL))
    const [id] = ids()
    const gist = recordOf(id!).representation.summary!.text
    const weighted = runtime.memory.importance(id!), held = JSON.stringify(recordOf(id!))
    const ticket = await accept(feishu('2', EXPORT))
    // A fresh, important experience is read in full: its gist exists, and the detail rung is what recall returns.
    expect(recall(['cache', 'stale']).items[0]).toMatchObject({ id, granularity: 'detail', summarised: false })
    expect(gist).toBe(GIST)
    // Two years on, the same record is read as its gist by the same query.
    await later('2028-09-09T00:00:00.000Z')
    expect(recall(['cache', 'stale']).items[0]).toMatchObject({ id, granularity: 'summary', summarised: true, shown: GIST })
    // Ten years on only its cues remain, and what it said is not in the block.
    await later('2036-09-09T00:00:00.000Z')
    const faded = recall(['cache', 'stale'])
    expect(faded.items[0]).toMatchObject({ id, granularity: 'cues', shown: '' })
    expect(faded.text).not.toContain('did not rebuild')
    // Forty years on routine recall does not return it at all, and says that it left rather than that it is gone.
    await later('2066-09-09T00:00:00.000Z')
    const gone = recall(['cache', 'stale'])
    expect(gone.items).toEqual([])
    expect(gone.forgotten).toBeGreaterThanOrEqual(1)
    // Forgotten is not deleted: the inventory still holds it, its whole original is one read away, and the work it started is open.
    const listed = await listFor(runtime.masterId)
    expect(listed.items.map(item => item.id)).toContain(id)
    expect(await runTool(runtime.masterId, 'orchestrator_read', { resource: `memory/${id}`, offset: 0, limit: 4000 }))
      .toMatchObject({ text: expect.stringContaining('did not rebuild'), summary: { version: 'mem-compression-1', sources: [id] } })
    expect(runtime.store.tickets.open().map(item => item.id)).toContain(ticket)

    // A later message shares many cues with it: the correlation wakes it without anyone asking, and it comes back as its gist.
    const before = runtime.memory.status().version, jobs = runtime.memory.jobs().length, calls = asked.length
    await receive(feishu('3', CUE))
    const [notice] = notices(runtime.masterId)
    expect(notice).toMatchObject({ kind: 'memory' })
    expect((notice!.items as { id: string; summary?: boolean; text: string }[])[0]).toMatchObject({ id, summary: true, text: GIST })
    // The wake raised nothing durable: the same weight, the same age, the same gist, the same record and the same open ticket.
    expect(runtime.memory.importance(id!)).toEqual(weighted)
    expect(recordOf(id!).experience.occurredAt).toBe(new Date(Date.parse('2026-09-09T00:00:00.000Z') + 1000).toISOString())
    expect(JSON.stringify(recordOf(id!))).toBe(held)
    expect(runtime.store.tickets.open().map(item => item.id)).toContain(ticket)
    // The only writes are the ones the new capture and its own scoring job made; the reactivation added none of its own.
    expect(runtime.memory.status().version).toBe(before + 2)
    expect(runtime.memory.jobs().length).toBe(jobs + 1)
    expect(asked.length).toBe(calls + 1)

    // The situation changes and the old experience does not come back again: a message with no cue in common wakes nothing.
    await receive(feishu('4', 'the weekly planning note is due next quarter'))
    expect(notices(runtime.masterId)).toHaveLength(1)
    // Moving the clock five more years starts no job and no model call: a rung is arithmetic over the record and the instant.
    const settled = runtime.memory.jobs().length, askedBefore = asked.length
    await later('2071-09-09T00:00:00.000Z')
    expect(recall(['cache', 'stale']).items).toEqual([])
    expect(runtime.memory.jobs().length).toBe(settled)
    expect(asked.length).toBe(askedBefore)
  })
})
