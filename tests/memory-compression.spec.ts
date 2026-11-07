/**
 * The consolidation of one experience into a short representation, at the Runtime integration boundary: a long experience starts an
 * independent background job, its request is recorded and proves it carries only the versioned compression principles, this job and a
 * bounded pack of new material with the evidence it needs — never a Session, a previous answer, or the previous summary alone — and
 * the reply it gets becomes a sourced summary committed through the service's one entry. Recall then returns the gist, `memory/<id>`
 * still returns the original inside its allowance, an original that is gone is reported as gone, and an operator can see the
 * compression version and take one step back. The validation a summary must pass, the base version and job id that decide whether a
 * result may apply, and the pause and retry of a job within its base's lifetime are here too, because they are what stops a lossy
 * rendering from silently replacing the record.
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
import type { CompressionCandidate, MemoryRecord } from '../src/memory/model.ts'
import { MemoryService } from '../src/memory/service.ts'
import { COMPRESSION_PRINCIPLES, SUMMARY_MAX_CHARS, summaryProblems } from '../src/memory/summary.ts'
import { feishuKind } from '../src/sources/feishu.ts'
import { githubKind } from '../src/sources/github.ts'
import { memoryInput, testLimits } from './fixtures/memory.ts'
import { fakeSession, feishu, jobRegistry, subagentRuntime, CHAT, MEMBER } from './fixtures/host.ts'
import { reference, testMachine } from './fixtures/deployment.ts'

type RegisteredTool = { name: string; execute: (args: unknown, execution: { signal: AbortSignal }) => Promise<unknown> }
type Section = (context: { signal?: AbortSignal }) => string
/** One published op, as the journal holds it. */
interface JournalOp { t: string; seq: number; version: number; opId: string; at: string; policy: string; record: MemoryRecord }
/** One background request, parsed the way the model reads it. */
interface Requested { job_id: string; task: string; principles: string; base_version: number; evidence: { id: string; text: string }[]
  previous_summary?: { version: string; text: string } }

/** The original of one experience: long enough that a summary is worth a model call, and carrying every feature a summary must keep. */
const LONG = 'Alice: the settings page cache went stale again on 2026-03-04 and the regression tracker reopened the old issue because of it. '
  + 'The deploy runs from the release branch, and the cache is not rebuilt by the deploy step, which is why the settings page keeps '
  + 'serving the old bundle to every viewer long after the fix was merged. Do not raise the threshold before the freeze ends, and do not '
  + 'merge the fix to main without Alice reviewing the deploy notes first.'
/** The gist a controlled reply returns for `LONG`: shorter than the original, and keeping its date, negation, constraint and subject. */
const GIST = 'On 2026-03-04 Alice reported that the stale settings page cache reopened the regression: the deploy does not rebuild the '
  + 'cache, so the page keeps serving the old bundle. Do not raise the threshold before the freeze ends.'
/** A second original, sharing cues with the first so that one is the evidence the other needs. */
const OTHER = 'Bob: the export button is broken for every viewer since the deploy, and the settings page cache is stale on staging too. '
  + 'The release train will not publish while the export check fails, so do not merge anything to main until Bob has re-run the export '
  + 'test on the release branch and the settings page has been checked by hand.'
/** The gist a controlled reply returns for `OTHER`, keeping its own negation and constraint rather than the first one's. */
const OTHER_GIST = 'Bob reported that the export button is broken for every viewer and the settings page cache is stale on staging; the '
  + 'release train will not publish while the export check fails, so do not merge anything to main until Bob re-runs the export test.'

let stateDir: string, runtime: Runtime, machine: Machine
const agents = new Map<string, unknown>(), tools = new Map<string, Map<string, RegisteredTool>>(), sections = new Map<string, Section>()
const logs = new Map<string, { type: string; data: unknown }[]>()
let answers: Record<string, string> = {}
let agentGh = '', larkBot = ''
/** Every model request the runtime made, foreground or background, in the order the adapter would have seen them. */
let asked: GenerateOptions[] = []
/** What the next background calls answer, one entry per call; the default answer is used once this is empty. */
let replies: ((options: GenerateOptions) => string)[] = []
/** The captures the Engine's transaction handed the durable queue. */
let enqueue: MockInstance

/** The text of the one message a hand-built background request carries. */
const textOf = (options: GenerateOptions): string => (options.messages[0]!.content as readonly { type: string; text?: string }[])
  .map(block => block.text ?? '').join('')
/** The parsed request one background call carries. */
const requested = (options: GenerateOptions): Requested => JSON.parse(textOf(options)) as Requested
/** The background calls that were compression jobs, in order. */
const compressions = (): GenerateOptions[] => asked.filter(options => requested(options).task === 'compression')
/** The answer a controlled model gives: a gist citing every experience the request carried, or a score for the scoring job. */
const answer = (options: GenerateOptions): string => {
  const said = requested(options)
  if (said.task === 'compression')
    return JSON.stringify({ job_id: said.job_id, summary: GIST, sources: said.evidence.map(item => item.id) })
  return JSON.stringify({ job_id: said.job_id, score: 50, rationale: 'a person reported a defect that still blocks the work',
    cited: [said.evidence[0]!.id], uncertain: [] })
}
/** Answer with `text` as the summary, or with `parts` replaced in an otherwise well-formed reply. */
const gist = (text: string, parts: Record<string, unknown> = {}) => (options: GenerateOptions): string =>
  JSON.stringify({ job_id: requested(options).job_id, summary: text, sources: requested(options).evidence.map(item => item.id), ...parts })

/** Start the runtime on this test's state directory: a fresh Context, the same fake DSH host, and the same state. */
async function boot(overrides: Partial<Machine> = {}, configure: { model?: boolean } = {}): Promise<void> {
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
      const take = vi.fn((message: UserMessage) => { logs.get(sessionId)!.push({ type: 'user/message', data: message }); inbox.nextStep.push(message) })
      let status = 'idle'
      agents.set(sessionId, { id: sessionId, ctx: agentCtx, inbox, followup: take, steer: take, inject: take,
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
  // DSH dispatches every model call, foreground or background, through the `llm/stream` waterfall, which the request budget listens on.
  const llm = { resolveCallConfig: vi.fn(async (value: unknown) => value),
    stream: (options: GenerateOptions): AsyncIterable<StreamChunk> => {
      const next = (): AsyncIterable<StreamChunk> => {
        asked.push(options)
        const reply = replies.shift() ?? answer
        return (async function* () {
          yield { type: 'text-delta', index: 0, text: reply(options) } as StreamChunk
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
  machine = testMachine({ stateDir, ...overrides })
  const model = configure.model === false ? null : { provider: 'deepseek', model: 'deepseek-chat' }
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
  // The fixture's messages are dated 2026-09-09, and a memory's rung is its age: with the clock free the checks below would move
  // as the suite ages, so it is pinned one day after the messages this file builds.
  vi.useFakeTimers({ toFake: ['Date'], now: Date.parse('2026-09-10T00:00:00.000Z') })
  asked = []; replies = []
  agents.clear(); tools.clear(); sections.clear(); logs.clear()
  stateDir = mkdtempSync(join(tmpdir(), 'memory-compression-'))
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
/** Accept one trigger as work, so the engine's own path runs beside the memory's. */
async function accept(trigger: Trigger): Promise<string> {
  runtime.receive(trigger)
  await runtime.idle()
  const { results } = await runTool(runtime.masterId, 'orchestrator_route', { decisions: [{ kind: 'accept', trigger_id: trigger.id,
    title: `Fix ${trigger.id}`, worktree_name: 'fix-regression', acknowledgement: '收到，修复回归。' }] }) as { results: Record<string, unknown>[] }
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
/** What a recall of `cues` returns for the project, in the order the model would read it. */
const recall = (cues: string[]) => runtime.memory.service.recall({ scope: { project: 'acme/widgets' }, cues, allowanceChars: 8000 })

describe('a new experience is consolidated into a sourced summary recall returns', () => {
  it('makes one clean compression request and commits its summary through the one entry', async () => {
    await boot()
    await receive(feishu('1', LONG))
    const [id] = ids()
    // One compression job beside the scoring job: the same stateless boundary, and the same discipline about what it may carry.
    const calls = compressions()
    expect(calls).toHaveLength(1)
    const [request] = calls
    expect(request!.system).toBe(COMPRESSION_PRINCIPLES.text)
    expect(request!.messages).toHaveLength(1)
    expect(request!.messages[0]!.role).toBe('user')
    expect(request!.sessionId).toBeUndefined()
    expect(request!.tools).toBeUndefined()
    const said = requested(request!)
    expect(said.principles).toBe(COMPRESSION_PRINCIPLES.version)
    expect(said.evidence.map(item => item.id)).toEqual([id])
    // The new material itself is in the pack, bounded: the job is never asked to summarise a summary as its only source.
    expect(said.evidence[0]!.text).toContain('do not merge the fix to main')
    expect(said.evidence[0]!.text.length).toBeLessThanOrEqual(2000)
    // The answer is a representation of the same stable identity, with its sources, its version and the job that wrote it.
    const summary = recordOf(id!).representation.summary!
    expect(summary).toMatchObject({ version: COMPRESSION_PRINCIPLES.version, jobId: said.job_id, model: 'deepseek/deepseek-chat', sourceMap: [id] })
    expect(summary.text).toBe(GIST)
    expect(recordOf(id!).representation.revision).toBe(2)
    // Durable in the journal, beside the experience, not only in the process.
    expect(ops().at(-1)!.record.representation.summary).toEqual(summary)
    expect(runtime.memory.jobs()).toMatchObject([{ kind: 'importance', status: 'committed' }, { kind: 'compression', status: 'committed' }])
  })

  it('returns the short representation on recall and the original on demand, through the same identity', async () => {
    await boot()
    // The background work is held back, so the read before compression is the read of the original.
    runtime.memory.pauseBackground()
    await receive(feishu('1', LONG))
    const [id] = ids()
    const before = recall(['cache', 'stale'])
    expect(before.items[0]!.summarised).toBe(false)
    expect(before.items[0]!.shown).toContain('settings page keeps serving the old bundle')
    const beforeChars = before.items[0]!.text.length
    // Let the job run: recall now returns the gist, which is shorter than what it returned before.
    runtime.memory.resumeBackground()
    await runtime.memory.settle()
    expect(compressions()).toHaveLength(1)
    const after = recall(['cache', 'stale'])
    expect(after.items[0]!.id).toBe(id)
    expect(after.items[0]!.summarised).toBe(true)
    expect(after.items[0]!.shown).toBe(GIST)
    expect(after.items[0]!.text.length).toBeLessThan(beforeChars)
    // The original is not lost: the same id expands to it, inside the allowance the caller has.
    const expanded = runtime.memory.service.expand({ id: id!, allowanceChars: 4000 })
    expect(expanded).toMatchObject({ status: 'available', text: LONG, truncated: false })
    expect(expanded.status === 'available' ? expanded.summary?.text : undefined).toBe(GIST)
    expect(recall(['cache', 'stale']).items[0]!.material).toContain('do not merge the fix to main')
  })

  it('keeps each experience its own summary, and carries the evidence a summary needs', async () => {
    await boot()
    // Each experience gets the gist of its own material: the second one's constraint is not the first one's.
    replies = [answer, gist(GIST), answer, gist(OTHER_GIST)]
    await receive(feishu('1', LONG))
    await receive(feishu('2', OTHER))
    const [first, second] = ids()
    // The second consolidation may read the first experience as evidence, because a later report often needs what came before it.
    const said = requested(compressions().at(-1)!)
    expect(said.evidence[0]!.id).toBe(second)
    expect(said.evidence.map(item => item.id)).toContain(first)
    expect(said.evidence.length).toBeLessThanOrEqual(3)
    // Two experiences, two sourced summaries: never one digest of everything with no sources.
    const one = recordOf(first!).representation.summary!, two = recordOf(second!).representation.summary!
    expect(one.sourceMap).toEqual([first])
    expect(two.sourceMap).toEqual([second, first])
    expect(two.text).toBe(OTHER_GIST)
    // Each keeps its own original, reachable by its own id.
    expect(runtime.memory.service.expand({ id: first!, allowanceChars: 4000 })).toMatchObject({ status: 'available', text: LONG })
    expect(runtime.memory.service.expand({ id: second!, allowanceChars: 4000 })).toMatchObject({ status: 'available', text: OTHER })
    // Retrieval still finds both by the deterministic cues of the originals, whatever the gists say.
    expect(recall(['cache', 'stale']).items.map(item => item.id).sort()).toEqual([first, second].sort())
  })

  it('carries the original material, not only the previous summary, into another pass', async () => {
    await boot()
    await receive(feishu('1', LONG))
    const [id] = ids()
    const first = recordOf(id!).representation.summary!
    // An explicit second consolidation, as a change of principles would plan one.
    replies = [gist(GIST)]
    expect(await runtime.memory.compress(id!)).toMatchObject({ kind: 'compression', status: 'committed' })
    const said = requested(compressions().at(-1)!)
    // The original is the pack's first item; the previous summary is there too, named as what it is, and is never the only source.
    expect(said.evidence[0]!.id).toBe(id)
    expect(said.evidence[0]!.text).toContain('do not merge the fix to main')
    expect(said.previous_summary).toMatchObject({ version: COMPRESSION_PRINCIPLES.version, text: first.text })
    expect(recordOf(id!).representation.revision).toBe(3)
    expect(recordOf(id!).representation.summary!.text).toBe(GIST)
  })

  it('does not spend a call on a brief experience that recall already shows whole', async () => {
    await boot()
    await receive(feishu('1', 'the cache is stale'))
    expect(compressions()).toEqual([])
    const [id] = ids()
    expect(recordOf(id!).representation.summary).toBeUndefined()
    expect(recall(['cache', 'stale']).items[0]!.summarised).toBe(false)
  })

  it('says the original is gone instead of filling it in, and offers what remained', async () => {
    await boot()
    // Long enough that the capture keeps its text as a blob, which is the one file an eviction would take away.
    const text = `${LONG} The trace follows: ${'detail '.repeat(900)}`
    await receive(feishu('1', text))
    const [id] = ids()
    expect(recordOf(id!).representation.summary).toBeDefined()
    // The read returns the original while it is there, and names the gist that stands in for it when it is not.
    expect(await runTool(runtime.masterId, 'orchestrator_read', { resource: `memory/${id}`, offset: 0, limit: 4000 }))
      .toMatchObject({ text: expect.stringContaining('settings page keeps serving the old bundle'),
        summary: { version: COMPRESSION_PRINCIPLES.version, sources: [id] } })
    // Ticket 09 owns eviction; what is asserted here is that a gone original is reported as gone and never invented.
    for (const name of readdirSync(join(memoryDir(), 'raw'))) rmSync(join(memoryDir(), 'raw', name), { force: true })
    expect(runtime.memory.service.expand({ id: id!, allowanceChars: 4000 })).toMatchObject({ status: 'evicted', id })
    await expect(runTool(runtime.masterId, 'orchestrator_read', { resource: `memory/${id}`, offset: 0, limit: 4000 }))
      .rejects.toThrow(/no longer stored; what remains is the summary of mem-compression-1/)
    // The gist is what recall still returns, and it is labelled as one.
    const recalled = recall(['cache', 'stale'])
    expect(recalled.items[0]!.summarised).toBe(true)
    expect(recalled.items[0]!.text).toContain('[summary]')
  })
})

describe('a summary that loses what the original states does not replace it', () => {
  let home: string, memory: MemoryService, id: string, record: MemoryRecord
  const NOW = '2026-11-06T09:10:00.000Z'
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'memory-compress-candidate-'))
    memory = MemoryService.open({ dir: join(home, 'memory'), limits: testLimits(), now: () => NOW })
    // A subject a summary can be expected to keep: prose, not an opaque member id.
    const input = memoryInput({ text: LONG, subject: 'settings cache regression' })
    id = input.id
    expect(memory.submit(input)).toMatchObject({ status: 'created' })
    record = memory.record(id)!
  })
  afterEach(() => { memory.close(); rmSync(home, { recursive: true, force: true }) })
  /** The checks one candidate text fails, read against the original it would replace. */
  const problemsWith = (text: string, sourceMap: string[] = [id]) => summaryProblems({ experience: record.experience, text, sourceMap, cited: [id] })
  /** Hand the service one candidate, computed from the version it names. */
  const submit = (text: string, parts: Partial<CompressionCandidate> = {}) => memory.submitCandidate({ jobId: 'j1', experienceId: id,
    baseVersion: memory.version, text, sourceMap: [id], version: COMPRESSION_PRINCIPLES.version, model: 'deepseek/deepseek-chat',
    digest: 'a'.repeat(64), at: NOW, cited: [id], ...parts })

  it('passes a gist that keeps the date, the negation, the constraint and the subject', () => {
    expect(problemsWith(GIST)).toEqual([])
    expect(GIST.length).toBeLessThan(LONG.length)
  })

  it('refuses a citation the request never carried, or none at all', () => {
    expect(problemsWith(GIST, [])).toContain('citation')
    expect(problemsWith(GIST, ['f'.repeat(32)])).toContain('citation')
    expect(problemsWith(GIST, [id, 'f'.repeat(32)])).toContain('citation')
  })

  it('refuses a gist that drops the subject the original names', () => {
    expect(problemsWith('On 2026-03-04 the deploy did not rebuild the cache, so do not raise the threshold before the freeze ends.'))
      .toContain('subject')
  })

  it('refuses a gist that drops a date the original states', () => {
    expect(problemsWith('Alice reported that the stale settings cache reopened the regression: the deploy does not rebuild the cache, '
      + 'so do not raise the threshold before the freeze ends.')).toContain('time')
  })

  it('refuses a gist that turns a negation into an assertion', () => {
    // The same sentence with the "not" gone: the denial became a claim, which is a false statement rather than a shorter one.
    expect(problemsWith('On 2026-03-04 the settings cache regression reopened because the deploy rebuilds the cache, and the settings '
      + 'cache regression is fixed.')).toContain('negation')
  })

  it('refuses a gist that keeps "not" but drops the constraint itself', () => {
    expect(problemsWith('On 2026-03-04 the settings cache regression reopened and was not fixed before the release, and the settings '
      + 'cache regression remains open.')).toContain('constraint')
  })

  it('commits nothing when the candidate fails, and never presents the gist as the original', () => {
    const version = memory.version
    expect(submit('The cache went stale and the regression reopened.')).toMatchObject({ status: 'rejected', reason: 'invalidInput' })
    expect(memory.version).toBe(version)
    expect(memory.record(id)!.representation.summary).toBeUndefined()
    // A candidate that passes is committed as a summary of sources, not as the sources themselves.
    expect(submit(GIST)).toMatchObject({ status: 'created' })
    expect(memory.record(id)!.representation.summary).toMatchObject({ text: GIST, sourceMap: [id] })
    expect(memory.record(id)!.representation.summary!.text).not.toBe(LONG)
    expect(memory.expand({ id, allowanceChars: 4000 })).toMatchObject({ status: 'available', text: LONG })
    // One job applies once: a second delivery of it changes nothing, and an older base version is refused rather than applied.
    expect(submit(GIST)).toMatchObject({ status: 'rejected', reason: 'stale' })
    expect(submit(GIST, { baseVersion: version - 1 })).toMatchObject({ status: 'conflict' })
    expect(SUMMARY_MAX_CHARS).toBeGreaterThan(GIST.length)
  })
})

describe('the compression version is readable and one rollback step is enough', () => {
  it('names the version in the read surface and takes back the last summary through the commit entry', async () => {
    await boot()
    await receive(feishu('1', LONG))
    const [id] = ids()
    const committed = recordOf(id!).representation.summary!
    const beforeRollback = runtime.memory.status().version
    // An operator reads which compression version produced what is being read.
    const listed = runtime.memory.list(undefined, 0, 5)
    expect(listed.items[0]).toMatchObject({ id, revision: 2,
      summary: { version: COMPRESSION_PRINCIPLES.version, job: committed.jobId, at: committed.at, sources: [id] } })
    // One rollback, through the service, is a new version rather than an edit of a published file.
    expect(runtime.memory.rollback(id!)).toMatchObject({ status: 'rolledBack', id, from: 2 })
    expect(runtime.memory.status().version).toBe(beforeRollback + 1)
    expect(ops().at(-1)!.record.representation).toMatchObject({ revision: 3, rollback: { from: 2 } })
    expect(ops().at(-1)!.record.representation.summary).toBeUndefined()
    // The next read is what it was before the compression: the original, not a half-rolled-back mix of the two.
    const recalled = recall(['cache', 'stale'])
    expect(recalled.items[0]!.summarised).toBe(false)
    expect(recalled.items[0]!.shown).toContain('settings page keeps serving the old bundle')
    expect(recalled.items[0]!.material).toContain('do not merge the fix to main')
    expect(runtime.memory.list(undefined, 0, 5).items[0]!.summary).toBeUndefined()
    // One step is all that was kept: a second rollback changes nothing and says so.
    expect(runtime.memory.rollback(id!)).toMatchObject({ status: 'none' })
    expect(runtime.memory.rollback('f'.repeat(32))).toMatchObject({ status: 'unknown' })
  })
})

describe('a base version and a job id decide whether a compression result may apply', () => {
  it('refuses a summary whose base version a commit replaced while it was being written', async () => {
    await boot()
    // A capture lands while the model is answering, so the version the job read is replaced before its reply can be committed.
    replies = [answer, (options: GenerateOptions) => {
      expect(runtime.memory.service.submit(memoryInput({ primary: 'feishu:oc_team:om_9',
        occurredAt: '2026-11-06T10:00:00.000Z', recordedAt: '2026-11-06T10:00:00.000Z', text: OTHER }))).toMatchObject({ status: 'created' })
      return gist(GIST)(options)
    }]
    await receive(feishu('1', LONG))
    const [id] = ids()
    expect(compressions()).toHaveLength(1)
    expect(recordOf(id!).representation.summary).toBeUndefined()
    expect(runtime.memory.jobs().filter(job => job.kind === 'compression')).toMatchObject([{ status: 'rejected',
      detail: expect.stringContaining('stale') }])
    // The commit that replaced it is the version a reader sees, and nothing of the refused summary was written.
    expect(ops().filter(op => op.record.representation.summary !== undefined)).toEqual([])
    expect(recall(['cache', 'stale']).items.filter(item => item.id === id)[0]!.summarised).toBe(false)
  })

  it('pauses a planned job, runs it on resume, and retries a failed job while its base version is current', async () => {
    await boot()
    runtime.memory.pauseBackground()
    await receive(feishu('1', LONG))
    const [id] = ids()
    // A paused job makes no call and commits nothing; the capture is already published and readable.
    expect(compressions()).toEqual([])
    expect(recordOf(id!).representation.summary).toBeUndefined()
    // Resuming runs exactly the job that was waiting.
    runtime.memory.resumeBackground()
    await runtime.memory.settle()
    expect(compressions()).toHaveLength(1)
    expect(recordOf(id!).representation.summary).toBeDefined()
    // A job that ran and got nothing back is recorded rather than retried on its own.
    replies = [() => { throw new Error('the provider is unreachable') }]
    const failed = (await runtime.memory.compress(id!))!
    expect(failed).toMatchObject({ kind: 'compression', status: 'failed' })
    expect(compressions()).toHaveLength(2)
    // An explicit retry, while the version it read is still current, runs it again and commits once.
    replies = [gist(GIST)]
    expect(await runtime.memory.retryJob(failed.id)).toMatchObject({ status: 'ran' })
    expect(recordOf(id!).representation.summary!.jobId).toBe(failed.id)
    expect(runtime.memory.jobs().filter(job => job.id === failed.id).map(job => job.status)).toEqual(['failed', 'committed'])
    // The version has moved, so the same job can no longer apply: it is stale, and the record keeps its commit.
    expect(await runtime.memory.retryJob(failed.id)).toMatchObject({ status: 'stale' })
    expect(recordOf(id!).representation.summary!.jobId).toBe(failed.id)
  })

  it('leaves the engine working: a ticket accepted after a consolidation still runs', async () => {
    await boot()
    await receive(feishu('1', LONG))
    expect(compressions()).toHaveLength(1)
    const ticket = await accept(feishu('2', '@bot the export button is broken'))
    // The ticket is accepted and open, and its own facts reached the memory beside the consolidated one.
    expect(runtime.store.tickets.get(ticket)).toMatchObject({ id: ticket })
    expect(runtime.store.tickets.open().map(item => item.id)).toEqual([ticket])
    expect(ids().length).toBeGreaterThanOrEqual(3)
    // And the gist of the first experience is still what recall returns, after all of it.
    expect(recall(['cache', 'stale']).items.some(item => item.summarised)).toBe(true)
  })
})
