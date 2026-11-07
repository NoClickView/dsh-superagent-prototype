/**
 * The long-term memory at the Runtime integration boundary, end to end: a real Feishu trigger is captured inside the Engine's
 * transaction, published to the memory files, read back as a read-only query, and delivered to the model as labelled background
 * context — each step checked through the runtime's own surface (the durable effect queue, the read resource, the delivered
 * messages, the state directory on disk). Duplicate delivery, a normal restart, scope isolation, the request budget and the absence
 * of any new authority are covered here too.
 */
import { Context } from '@deepseek-ai/cordis'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import { appendFileSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import type { Trigger } from '../src/core/index.ts'
import { Runtime } from '../src/app/runtime.ts'
import { Effects } from '../src/app/effects.ts'
import { Sessions } from '../src/app/sessions.ts'
import { Store } from '../src/app/store.ts'
import { Commands } from '../src/infra/commands.ts'
import { credentialHelper, workerGitConfig } from '../src/infra/environment.ts'
import { SettingsSchema } from '../src/policy.ts'
import { memoryLimits } from '../src/app/memory.ts'
import { KV } from '../src/kv.ts'
import { MemoryService } from '../src/memory/service.ts'
import { journalNameOf } from '../src/memory/store.ts'
import { materialText } from '../src/memory/retrieval.ts'
import type { MemoryRecord } from '../src/memory/model.ts'
import { feishuKind } from '../src/sources/feishu.ts'
import { githubKind } from '../src/sources/github.ts'
import type { Machine } from '../src/deployment.ts'
import { memoryInput } from './fixtures/memory.ts'
import { fakeSession, feishu, jobRegistry, subagentRuntime, CHAT, MEMBER } from './fixtures/host.ts'
import { reference, testMachine } from './fixtures/deployment.ts'

type RegisteredTool = { name: string; execute: (args: unknown, execution: { signal: AbortSignal }) => Promise<unknown> }
type Section = (context: { signal?: AbortSignal }) => string
/** One message the runtime delivered, in the form the model reads: a queued or steered turn, or an injected context message. */
interface Delivered { sessionId: string; mode: string; id: string; text: string; form?: string }
/** One published op, as the journal holds it. */
interface JournalOp { t: string; seq: number; version: number; opId: string; at: string; policy: string; record: MemoryRecord }

let stateDir: string, runtime: Runtime, machine: Machine
const agents = new Map<string, unknown>(), tools = new Map<string, Map<string, RegisteredTool>>(), sections = new Map<string, Section>()
const logs = new Map<string, { type: string; data: unknown }[]>(), delivered: Delivered[] = []
let answers: Record<string, string> = {}
let agentGh = '', larkBot = ''
let enqueue: MockInstance

/** Start (or restart) the runtime on this test's state directory: a fresh Context, the same fake DSH host, and the same state. */
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
      // A message the runtime delivers reaches the Session's own log, as DSH's inbox takes it into its history before the next
      // request; that log is what the request budget measures and what the final model input is asserted on.
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
  const services = { agents, llm: { resolveCallConfig: vi.fn(async (value: unknown) => value) }, sessionController: controller,
    sessionPersistence: { flush: vi.fn(async () => {}), open: vi.fn(async () => reader) },
    workspaceRegistry: { create: async (cwd: string) => ({ id: cwd }) }, permissionPresets: { set: () => {} }, subprocess,
    webServer: { host: '127.0.0.1', port: 3082, register: () => () => {} }, jobs: jobs.service, subagents: subagents.service }
  const ctx = new Context()
  for (const [name, service] of Object.entries(services)) ctx.reflect.provide(name, service)
  machine = testMachine({ stateDir, ...overrides })
  // The setup check reads the Source settings before the Runtime starts, as it does in production, so they are seeded first.
  const seeded = new Store(join(stateDir, 'orchestrator.sqlite'))
  seeded.saveSettings(SettingsSchema.parse({ ...seeded.settings(), sources: { github: { enabled: true, config: { repository: 'acme/widgets',
    cli: agentGh } }, feishu: { enabled: true, config: { cli: larkBot } } } }))
  seeded.close()
  runtime = new Runtime(ctx, machine, vi.fn())
  await runtime.ready
  runtime.sources.register(feishuKind); runtime.sources.register(githubKind)
  const settings = runtime.store.settings()
  runtime.store.saveSettings(SettingsSchema.parse({ ...settings, eval: { ...settings.eval, mode: 'auto' },
    policy: { ...settings.policy, sources: { feishu: { allowed: [{ id: MEMBER, name: 'Alice' }], syncChat: CHAT }, github: { allowed: [{ id: 'alice' }] } } },
    sources: { github: { enabled: true, config: { repository: 'acme/widgets', cli: agentGh } },
      feishu: { enabled: true, config: { cli: larkBot, chats: [{ chatId: CHAT, listen: 'all' }], directMessages: true } } } }))
}

/** The capture payloads the Engine's transaction handed the durable queue, which a crash would leave behind for a redelivery. */
const captures = (): { key: string; payload: unknown }[] => enqueue.mock.calls
  .filter(([kind]) => kind === 'memory').map(([, key, payload]) => ({ key: key as string, payload }))
/** The captures the durable queue really holds, counted from its own rows: what a restart reads rather than what this process offered. */
const queuedCaptures = (): number => Number(runtime.store.db.prepare("SELECT COUNT(*) AS rows FROM effect WHERE kind = 'memory'").get()?.rows ?? 0)

beforeEach(() => {
  // The fixture's messages are dated 2026-09-09, and a memory's rung is its age: with the clock free the checks below would move
  // as the suite ages, so it is pinned one day after the messages this file builds.
  vi.useFakeTimers({ toFake: ['Date'], now: Date.parse('2026-09-10T00:00:00.000Z') })
  delivered.length = 0
  agents.clear(); tools.clear(); sections.clear(); logs.clear()
  stateDir = mkdtempSync(join(tmpdir(), 'memory-runtime-'))
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
/** Receive a trigger and let the runtime settle, which runs every effect that can run now. */
async function receive(trigger: Trigger): Promise<void> { runtime.receive(trigger); await runtime.idle() }
/** Accept one trigger as a ticket, so its worker Session exists and may read what reached it. */
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
/** What the memory read resource answers for a Session. */
const listFor = async (sessionId: string) => await runTool(sessionId, 'orchestrator_read', { resource: 'memory' }) as
  { version: number; total: number; next_offset: number | null; items: { id: string; preview: string; read: string }[] }
/** The recalled-memory notices one Session was sent, parsed as the model reads them. */
const notices = (sessionId: string): Record<string, unknown>[] => delivered
  .filter(item => item.sessionId === sessionId && item.form === 'recall')
  .map(item => JSON.parse(item.text) as Record<string, unknown>)
/** Bytes of every file under one directory, walked: what the memory root really occupies rather than its top level alone. */
const bytesUnder = (dir: string): number => readdirSync(dir, { withFileTypes: true })
  .reduce((sum, entry) => sum + (entry.isDirectory() ? bytesUnder(join(dir, entry.name)) : statSync(join(dir, entry.name)).size), 0)
/** Everything the memory persisted: its files, the payloads still waiting in the business database for it to accept them, and the
 * position a capture the receiving boundary refused waits at. */
const persistedMemoryBytes = (): { files: number; queue: number; redelivery: number; total: number } => {
  // In bytes, which is the unit both halves of the capacity contract state: `LENGTH` over a text value counts characters.
  const row = runtime.store.db.prepare("SELECT IFNULL(SUM(LENGTH(CAST(value AS BLOB))), 0) AS bytes FROM effect WHERE kind = 'memory'").get()
  const held = runtime.store.db.prepare('SELECT IFNULL(LENGTH(CAST(value AS BLOB)), 0) AS bytes FROM kv WHERE key = ?').get(KV.memory.redelivery)
  const files = bytesUnder(memoryDir()), queue = Number(row?.bytes ?? 0), redelivery = Number(held?.bytes ?? 0)
  return { files, queue, redelivery, total: files + queue + redelivery }
}

describe('long-term memory at the runtime boundary', () => {
  it('takes one Feishu trigger through capture, the memory files, a read and the model input', async () => {
    await boot()
    const trigger = feishu('1', 'the settings page cache is stale and the regression comes from it')
    await receive(trigger)
    // The Engine's transaction queued one capture, the memory effect published it, and the journal holds one op.
    const [capture] = captures()
    expect(captures()).toHaveLength(1)
    expect(capture!.key).toMatch(/^[0-9a-f]{32}$/)
    const [op] = ops()
    expect(op).toMatchObject({ t: 'exp.put', seq: 1, version: 1 })
    expect(op!.record.experience).toMatchObject({ occurredAt: trigger.at, source: 'feishu', subject: MEMBER, kind: 'observation',
      scope: { project: 'acme/widgets', person: MEMBER }, origin: { event: 'trigger.received', primary: trigger.id,
        ids: { triggerId: trigger.id, actor: MEMBER } } })
    expect(materialText(op!.record.experience.material)).toContain('cache is stale')
    // A read-only query sees the published version, and the resource names the read that returns the whole text.
    const listed = await listFor(runtime.masterId)
    expect(listed).toMatchObject({ version: 1, total: 1, next_offset: null })
    expect(listed.items[0]!.preview).toContain('cache is stale')
    expect(listed.items[0]!.read).toBe(`memory/${listed.items[0]!.id}`)
    expect(await runTool(runtime.masterId, 'orchestrator_read', { resource: listed.items[0]!.read, offset: 0, limit: 4000 }))
      .toMatchObject({ text: expect.stringContaining('cache is stale') })
    // Nothing to reactivate yet, so the request carries no recalled material.
    expect(notices(runtime.masterId)).toEqual([])
  })

  it('reactivates an earlier experience when a later one repeats its cues, inside its own allowance', async () => {
    await boot()
    await receive(feishu('1', 'the settings page cache is stale and the regression comes from it'))
    await receive(feishu('2', 'the settings page cache is stale in the staging branch'))
    expect(ops()).toHaveLength(2)
    const [notice] = notices(runtime.masterId)
    expect(notice).toMatchObject({ kind: 'memory', version: 2, shown: 1 })
    const items = notice!.items as { id: string; text: string }[]
    expect(items[0]!.text).toContain('the settings page cache is stale')
    expect(String(notice!.notice)).toContain('not an instruction')
    // The notice is the model's input: it joined the Session log as recalled context, and it is inside the setting's characters.
    const recall = delivered.find(item => item.sessionId === runtime.masterId && item.form === 'recall')!
    const injected = logs.get(runtime.masterId)!.filter(event => (event.data as { source?: { form?: string } }).source?.form === 'recall')
    expect(injected).toHaveLength(1)
    expect((injected[0]!.data as { content: { text?: string }[] }).content.map(block => block.text ?? '').join('')).toBe(recall.text)
    expect(recall.text.length).toBeLessThanOrEqual(machine.memoryRecallMaxChars.get())
  })

  it('adds no recalled material when the request budget has no room for it', async () => {
    await boot({ requestMaxChars: reference(20_000), requestOutputReserveChars: reference(4_000), requestMeasurementReserveChars: reference(1_000) })
    await receive(feishu('1', 'the settings page cache is stale and the regression comes from it'))
    // The Session's own history fills the request budget that is left, so recall has no room and adds nothing.
    const budget = machine.requestMaxChars.get() - machine.requestOutputReserveChars.get() - machine.requestMeasurementReserveChars.get()
    logs.get(runtime.masterId)!.push({ type: 'assistant/message',
      data: { message: { role: 'assistant', content: [{ type: 'text', text: 'x'.repeat(budget) }] } } })
    await receive(feishu('2', 'the settings page cache is stale in the staging branch'))
    expect(ops()).toHaveLength(2)
    expect(runtime.memory.allowance(runtime.masterId)).toBe(0)
    expect(notices(runtime.masterId)).toEqual([])
  })

  it('wakes a Session with one experience once, while its record is unchanged, and holds one window to eight notices', async () => {
    await boot()
    // Twelve messages about the same thing, each a new experience that matches every earlier one.
    for (let n = 0; n < 12; n++) await receive(feishu(String(n), `the settings page cache is stale in release ${n} and the regression comes from it`))
    expect(ops()).toHaveLength(12)
    // A wake is a delivered message DSH keeps, so what is bounded is the memory's own proposing: an experience is shown once while
    // its record is unchanged, and the notices one window holds are the setting's — eight here, the window being the default half
    // hour and this burst nowhere near it. It is an allowance rather than a lifetime quota: `memory-reactivation-budget.spec.ts` runs
    // the same burst past eight, lets the window pass, and shows the ninth notice.
    const woken = notices(runtime.masterId).flatMap(notice => (notice.items as { id: string }[]).map(item => item.id))
    expect(notices(runtime.masterId)).toHaveLength(8)
    expect(woken).toHaveLength(8)
    expect(new Set(woken).size).toBe(woken.length)
    // The wake changed nothing about the experiences it delivered: the store is the twelve publications and nothing else.
    expect(runtime.memory.status().version).toBe(12)
  })

  it('publishes a redelivered capture once, so a repeated report changes nothing', async () => {
    await boot()
    await receive(feishu('1', 'the settings page cache is stale and the regression comes from it'))
    const before = ops()
    expect(before).toHaveLength(1)
    // The queue's redelivery after a crash: the same payload, offered again under the same key.
    const [capture] = captures()
    runtime.effects.enqueue('memory', capture!.key, capture!.payload as never)
    await runtime.idle()
    expect(ops()).toEqual(before)
    expect((await listFor(runtime.masterId)).total).toBe(1)
    expect(runtime.memory.status().version).toBe(1)
  })

  it('restores the same identity and content after a normal restart', async () => {
    await boot()
    await receive(feishu('1', 'the settings page cache is stale and the regression comes from it'))
    const [before] = (await listFor(runtime.masterId)).items
    await runtime.stop()
    await boot()
    // The restarted runtime reads the published version from the files, and recovery writes no op of its own.
    expect(runtime.memory.status()).toMatchObject({ version: 1, experiences: 1, writable: true })
    expect(ops()).toHaveLength(1)
    const listed = await listFor(runtime.masterId)
    expect(listed.items.map(item => item.id)).toEqual([before!.id])
    expect(listed.items[0]!.preview).toContain('cache is stale')
    // Recall still finds it by a cue, after the restart.
    const recalled = runtime.memory.service.recall({ scope: { project: 'acme/widgets' }, cues: ['cache', 'stale'], allowanceChars: 4000 })
    expect(recalled.items.map(item => item.id)).toEqual([before!.id])
  })

  it('keeps a capture the full store could not publish, and publishes it after a restart', async () => {
    // The originals here are small enough to stay in the journal, which is append-only: reclamation has nothing it may free, so a
    // full store back-pressures the next fact and keeps waiting for room — the case ticket 09 leaves it: no candidate, no eviction.
    await boot({ memoryBudgetBytes: reference(65_536) })
    let sent = 0
    while (!runtime.effects.pending('memory') && sent < 20) {
      await receive(feishu(String(sent), `the cache note ${sent} ${'x'.repeat(3_900)}`))
      sent += 1
    }
    const published = ops().length
    expect(published).toBeGreaterThan(0)
    expect(published).toBeLessThan(sent)
    // The progress of that delivery is the queue row itself, which SQLite holds across a restart.
    expect(runtime.effects.pending('memory')).toBe(true)
    await runtime.stop()
    // A restart with room for it: the queue re-dispatches the row, and the service publishes it exactly once.
    await boot({ memoryBudgetBytes: reference(4 << 20) })
    await runtime.idle()
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + 5_000 })
    try { await runtime.idle() } finally { vi.useRealTimers() }
    expect(runtime.effects.pending('memory')).toBe(false)
    expect(ops()).toHaveLength(sent)
    expect((await listFor(runtime.masterId)).total).toBe(sent)
  })

  it('offers a capture the receiving boundary refused again after a restart, and publishes it exactly once', async () => {
    // The second review round's reproduction, at the Runtime boundary: the durable queue may hold one capture and the store cannot
    // commit, so one business fact waits and the next is refused at the receiving boundary. Two facts, and the second is the one
    // that must come back.
    await boot({ memoryBudgetBytes: reference(65_536), memoryPendingMaxItems: reference(1), memoryWriteMode: reference('require') })
    const first = feishu('1', 'the settings page cache is stale and the regression comes from it')
    const second = feishu('2', 'the export button is broken for every viewer of the report')
    await receive(first)
    await receive(second)
    // The first fact waits for a store whose gate is shut, and the second was not accepted at all — but it is not a counter this
    // process keeps: it is the payload itself, in the durable record an operator reads as the position it waits at.
    expect(runtime.effects.pending('memory')).toBe(true)
    expect(runtime.memory.status().experiences).toBe(0)
    const held = runtime.store.get(KV.memory.redelivery)!
    expect(held.items).toHaveLength(1)
    const refused = held.items[0]!.input
    expect(runtime.memory.pending()).toMatchObject({ items: 1, notYetAccepted: 2, redelivery: { items: 1, lost: 0 } })
    expect(runtime.health['memory-store']!.detail).toContain('held at a redelivery position')
    await runtime.stop()
    // Space and commutability come back — the same state directory, a store with room, a boundary the deployment waives — and the
    // queue's capacity is unchanged at one, so nothing is admitted out of a burst.
    await boot({ memoryBudgetBytes: reference(4 << 20), memoryPendingMaxItems: reference(1) })
    await runtime.idle()
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + 5_000 })
    try { await runtime.idle() } finally { vi.useRealTimers() }
    // The fact that waited is delivered by the queue it waited in, and the refused one is offered again once that delivery made
    // room: both published, the second exactly once, through the one commit path both of them use.
    expect(runtime.memory.status()).toMatchObject({ version: 2, experiences: 2 })
    const published = ops().map(op => op.record.experience.id)
    expect(published).toHaveLength(2)
    expect(published.filter(id => id === refused.id)).toHaveLength(1)
    expect(materialText(ops().find(op => op.record.experience.id === refused.id)!.record.experience.material))
      .toContain('export button is broken')
    // Nothing is left waiting: the queue and the durable position are both empty, and both are read from what is stored.
    expect(runtime.memory.pending()).toMatchObject({ items: 0, notYetAccepted: 0, redelivery: { items: 0, lost: 0 } })
    // The redelivery kept the capture's stable experience id, so offering it once more cannot apply the same fact twice.
    runtime.effects.enqueue('memory', refused.id, refused as never)
    await runtime.idle()
    expect(ops()).toHaveLength(2)
    expect(runtime.memory.status()).toMatchObject({ version: 2, experiences: 2 })
  })

  it('offers a refused capture back only once the delivered row is really released, so a failed delivery never doubles the queue', async () => {
    // The third review round's reproduction, at the Runtime boundary: the queue may hold one capture and the position one, and a
    // delivery that fails keeps its row queued for the retry the memory promises. An offer made from inside that handler spends a place
    // the row itself still holds, so the durable queue reaches two entries against a bound of one — and a restart keeps both.
    await boot({ memoryPendingMaxItems: reference(1), memoryRedeliveryMaxItems: reference(1) })
    await receive(feishu('1', 'the settings page cache is stale and the regression comes from it'))
    expect(runtime.memory.status().experiences).toBe(1)
    // Every delivery from here fails where it hands its recalled context to the Session, which is a delivery that does not reach the
    // model: the capture's row stays queued for the retry the memory promises, so the place it holds is free for nothing else.
    let failing = true
    const original = Sessions.prototype.prompt
    vi.spyOn(Sessions.prototype, 'prompt').mockImplementation(async function (this: Sessions, ...args: Parameters<typeof original>) {
      if (args[3] === 'recall' && failing) throw new Error('the recalled context did not reach the Session')
      return await original.apply(this, args)
    })
    await receive(feishu('2', 'the settings page cache is stale in the staging branch'))
    expect(runtime.memory.status().experiences).toBe(2)
    expect(runtime.effects.pending('memory')).toBe(true)
    // The fact that arrives next cannot wait, so it is held at the position instead: one capture in each area is the most it may hold.
    await receive(feishu('3', 'the settings page cache is stale in the staging release'))
    const refused = runtime.store.get(KV.memory.redelivery)!.items[0]!.input.id
    expect(runtime.memory.pending()).toMatchObject({ items: 1, redelivery: { items: 1, lost: 0 } })
    // The retry that failure scheduled is the moment the review measured: the row that must keep waiting runs again and fails again,
    // and it must not have offered the refused capture into a place it still holds.
    vi.setSystemTime(new Date(Date.now() + 5_000))
    await runtime.idle()
    const held = runtime.memory.pending()
    expect(held.items).toBeLessThanOrEqual(held.maxItems)
    expect(held.redelivery.items).toBeLessThanOrEqual(held.redelivery.maxItems)
    expect(held).toMatchObject({ items: 1, redelivery: { items: 1, lost: 0 } })
    expect(queuedCaptures()).toBe(1)
    // The refused capture was not published either: it still waits at the position, because no place was genuinely freed for it.
    expect(runtime.memory.status().experiences).toBe(2)
    // A restart reads both areas from what is stored: each is still inside its own bound, and the refused capture still waits.
    await runtime.stop()
    await boot({ memoryPendingMaxItems: reference(1), memoryRedeliveryMaxItems: reference(1) })
    await runtime.idle()
    expect(queuedCaptures()).toBe(1)
    expect(runtime.memory.pending()).toMatchObject({ items: 1, notYetAccepted: 2, redelivery: { items: 1, lost: 0 } })
    // The delivery goes through now, and the place its row really released is what the refused capture is offered into: the bound is
    // never passed on the way, and the fact that waited at the position is published exactly once.
    failing = false
    vi.setSystemTime(new Date(Date.now() + 120_000))
    await runtime.idle()
    expect(queuedCaptures()).toBe(0)
    expect(runtime.memory.pending()).toMatchObject({ items: 0, notYetAccepted: 0, redelivery: { items: 0, lost: 0 } })
    const published = ops().map(op => op.record.experience.id)
    expect(published).toHaveLength(3)
    expect(published.filter(id => id === refused)).toHaveLength(1)
    expect(materialText(ops().find(op => op.record.experience.id === refused)!.record.experience.material))
      .toContain('staging release')
  })

  it('reports the same not-yet-accepted figure for material that stays refused, across a restart', async () => {
    // The queue may hold one capture and the store cannot commit, so one fact waits and the next is refused at the receiving
    // boundary. Nothing frees either of them, which is the case a restart must not lose: the refused material is still outstanding,
    // and the figure an operator reads is read from the durable position rather than from a counter the stopped process took away.
    const shut: Partial<Machine> = { memoryBudgetBytes: reference(65_536), memoryPendingMaxItems: reference(1),
      memoryWriteMode: reference('require') }
    await boot(shut)
    await receive(feishu('1', 'the settings page cache is stale and the regression comes from it'))
    await receive(feishu('2', 'the export button is broken for every viewer of the report'))
    const before = runtime.memory.pending()
    expect(before).toMatchObject({ items: 1, refused: 1, notYetAccepted: 2, redelivery: { items: 1, lost: 0 } })
    expect(runtime.health['memory-background']!.detail).toContain('2 not yet accepted')
    await runtime.stop()
    // A restart with the same shut gate: the queue is still full, so startup offers nothing back. The operational count begins
    // again with this runtime and reads zero, while the durable figure does not — the payload still waits, so it is still not accepted.
    await boot(shut)
    await runtime.idle()
    expect(runtime.memory.pending()).toMatchObject({ items: 1, refused: 0, notYetAccepted: 2,
      redelivery: { items: 1, bytes: before.redelivery.bytes, lost: 0 } })
    expect(runtime.health['memory-background']!.detail).toContain('2 not yet accepted')
    await runtime.stop()
    // A second restart answers the same way: what is outstanding is the stored position, not what this process happened to refuse.
    await boot(shut)
    await runtime.idle()
    expect(runtime.memory.pending()).toMatchObject({ items: 1, refused: 0, notYetAccepted: 2, redelivery: { items: 1, lost: 0 } })
    expect(runtime.store.get(KV.memory.redelivery)!.items[0]!.input.material.text).toContain('export button is broken')
  })

  it('keeps the material waiting to be accepted inside its bound, with the queue and the files counted together', async () => {
    const budget = 65_536
    await boot({ memoryBudgetBytes: reference(budget), memoryPendingMaxItems: reference(8) })
    // The background is held, so no model call runs while the store fills: captures keep arriving and each one is either published,
    // queued or refused, which is the whole of what the receiving boundary decides.
    runtime.memory.pauseBackground()
    const received: string[] = []
    for (let index = 0; index < 16; index++) {
      const trigger = feishu(String(index), `note ${index}: ${'data '.repeat(6_500)}`)
      received.push(trigger.id)
      await receive(trigger)
    }
    const pending = runtime.memory.pending()
    expect(runtime.memory.status().experiences).toBeGreaterThan(0)
    // The queue is bounded in items and in payload bytes, and most of what arrived was refused rather than stored.
    expect(pending.items).toBeLessThanOrEqual(8)
    expect(pending.bytes).toBeLessThanOrEqual(budget)
    expect(pending.refused).toBeGreaterThan(0)
    // A refusal is not dropped: what the queue could not take waits at the redelivery position inside its own two bounds, and what
    // that position could not hold is counted as permanently lost — a fact that will never be remembered has to be readable as one.
    expect(pending.redelivery.items).toBeGreaterThan(0)
    expect(pending.redelivery.bytes).toBeLessThanOrEqual(pending.redelivery.maxBytes)
    expect(pending.redelivery.items + pending.redelivery.lost).toBe(pending.refused)
    expect(pending.notYetAccepted).toBe(pending.items + pending.redelivery.items)
    // Everything the memory persisted — the files under the memory root, the payloads waiting in orchestrator.sqlite *and* the
    // position a refusal waits at — stays inside the contract its three areas state, instead of growing by the size of every event
    // the store could not take.
    const persisted = persistedMemoryBytes()
    expect(persisted.files).toBeLessThanOrEqual(budget)
    expect(persisted.total).toBeLessThanOrEqual(3 * budget)
    // The health entries say so without an operator querying the database: the queue's capacity, its occupancy, why it refuses, what
    // it refused and where that waits, and what the background is doing with the rest.
    const store = runtime.health['memory-store']!, background = runtime.health['memory-background']!
    expect(store.detail).toContain(`${pending.items} of 8 captures`)
    expect(store.detail).toContain(`${pending.bytes} of ${budget} bytes waiting to be accepted`)
    expect(store.detail).toContain(`${pending.refused} refused at the receiving boundary since this runtime opened`)
    expect(store.detail).toContain(`${pending.redelivery.items} of ${pending.redelivery.maxItems} held at a redelivery position`)
    expect(store.detail).toContain(`${pending.redelivery.lost} permanently lost`)
    expect(store.detail).toContain(pending.reason!)
    expect(store.detail).toContain(`capacity ${runtime.memory.status().capacity.state}`)
    expect(background.detail).toContain('held')
    expect(background.detail).toContain(`${pending.notYetAccepted} not yet accepted`)
    // Nothing was dropped from the business: every trigger the runtime received is still its own record, and the memory refusing to
    // remember one changed no ticket, no mandate and no open work.
    expect(received.every(id => runtime.store.triggers.get(id) !== undefined)).toBe(true)
    expect(runtime.store.tickets.open()).toEqual([])
  })

  it('keeps one ticket\'s experiences out of another ticket\'s reads, and shows both to the project', async () => {
    await boot()
    const one = feishu('1', '@bot the settings page cache is stale'), two = feishu('2', '@bot the export button is broken')
    const ticketA = await accept(one), ticketB = await accept(two)
    const read = async (sessionId: string) => (await listFor(sessionId)).items.map(item => item.preview).join('\n')
    const a = await read(`worker-${ticketA}`), b = await read(`worker-${ticketB}`), all = await read(runtime.masterId)
    // A worker reads the facts of its own ticket, and never the other ticket's; the project's scope holds both.
    expect(a).toContain(`Fix ${one.id}`)
    expect(a).not.toContain(`Fix ${two.id}`)
    expect(b).toContain(`Fix ${two.id}`)
    expect(b).not.toContain(`Fix ${one.id}`)
    expect(all).toContain(`Fix ${one.id}`)
    expect(all).toContain(`Fix ${two.id}`)
  })

  it('grants nothing: recalled memory changes no ticket, mandate or open work', async () => {
    await boot()
    const ticket = await accept(feishu('1', '@bot the settings page cache is stale'))
    const before = JSON.stringify(runtime.store.tickets.get(ticket))
    await receive(feishu('2', 'the settings page cache is stale in the staging branch'))
    expect(notices(runtime.masterId)).toHaveLength(1)
    // Memory published and recalled, and the business state is exactly what it was: memory is context, never authority.
    expect(JSON.stringify(runtime.store.tickets.get(ticket))).toBe(before)
    expect(runtime.store.tickets.open().map(item => item.id)).toEqual([ticket])
  })

  it('drops the append a crash tore, and a restart continues the reads from the version it acknowledged', async () => {
    await boot()
    await receive(feishu('1', 'the settings page cache is stale and the regression comes from it'))
    const [before] = (await listFor(runtime.masterId)).items
    await runtime.stop()
    // The bytes a kill mid-append leaves behind: no newline, so they were never an op any caller acknowledged.
    appendFileSync(join(memoryDir(), 'journal', journalNameOf(1)), '{"t":"exp.put","seq":2,"version":2,"opId":"half')
    await boot()
    // Recovery read the longest parseable prefix, which is exactly the version the runtime had acknowledged and no more.
    expect(runtime.memory.status()).toMatchObject({ version: 1, seq: 1, experiences: 1, writable: true })
    expect(ops()).toHaveLength(1)
    expect(readFileSync(join(memoryDir(), 'journal', journalNameOf(1)), 'utf8').endsWith('\n')).toBe(true)
    // The real read paths answer from that version: the paged resource, and the recall the prompt path uses.
    expect((await listFor(runtime.masterId)).items.map(item => item.id)).toEqual([before!.id])
    expect(runtime.memory.service.recall({ scope: { project: 'acme/widgets' }, cues: ['cache', 'stale'], allowanceChars: 4000 })
      .items.map(item => item.id)).toEqual([before!.id])
    // The capture the crash interrupted, delivered again, is the next version and the next readable experience.
    await receive(feishu('2', 'the settings page cache is stale in the staging branch'))
    expect(runtime.memory.status()).toMatchObject({ version: 2, experiences: 2 })
    expect(ops()).toHaveLength(2)
  })

  it('publishes the capture a crash left queued when the files never received it', async () => {
    await boot()
    await receive(feishu('1', 'the settings page cache is stale and the regression comes from it'))
    const [capture] = captures()
    await runtime.stop()
    // The other order of the same crash: the Engine committed the fact and the memory root was never written at all, so the only
    // copy of it is the queue row that SQLite kept.
    rmSync(memoryDir(), { recursive: true, force: true })
    await boot()
    expect(runtime.memory.status()).toMatchObject({ version: 0, experiences: 0 })
    runtime.effects.enqueue('memory', capture!.key, capture!.payload as never)
    await runtime.idle()
    expect(ops()).toHaveLength(1)
    expect((await listFor(runtime.masterId)).total).toBe(1)
    expect(runtime.effects.pending('memory')).toBe(false)
  })

  it('serves a reader of the live memory root one whole version, and lets it change no byte', async () => {
    await boot()
    await receive(feishu('1', 'the settings page cache is stale and the regression comes from it'))
    await receive(feishu('2', 'the export button is broken and the cache is not the cause'))
    const manifest = () => statSync(join(memoryDir(), 'published', 'manifest.json'))
    const before = manifest()
    const reader = MemoryService.open({ dir: memoryDir(), limits: memoryLimits(machine), now: () => '2026-11-06T09:10:00.000Z',
      readOnly: true })
    try {
      // A second reader of the files the runtime holds open: the version the writer published, and nothing it has not.
      const published = runtime.memory.status().version
      expect(reader.status()).toMatchObject({ version: published, experiences: 2, writable: false })
      expect(reader.list({ scope: { project: 'acme/widgets' }, offset: 0, limit: 10 }).items).toHaveLength(2)
      expect(reader.submit(memoryInput())).toMatchObject({ status: 'rejected', reason: 'readOnly' })
    } finally { reader.close() }
    // It wrote nothing: the index the runtime published is the same file, byte for byte, at the same size.
    expect(manifest().size).toBe(before.size)
    expect(manifest().mtimeMs).toBe(before.mtimeMs)
  })
})
