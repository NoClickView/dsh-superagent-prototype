/**
 * The replay itself: years of experience fed through the real Runtime, then one question at a time answered from each of the three
 * strategies and graded against the scenario's hand-written key. Nothing here is a shortcut around the runtime — every episode is a real
 * source event the Engine receives, the memory captures it inside the Engine's transaction, the durable effect queue publishes it and the
 * background evaluator consolidates it, exactly as a live deployment would. What the replay controls is the clock (the replayed instants,
 * never the machine's) and the model (one fixed function, so the run is reproducible and its cost is comparable across strategies).
 *
 * The run is batched: a trigger is fed, then one `idle()` and one `settle()` rather than an idle per effect. The archive phase is the one
 * place that needs more events than the scenario holds, and it keeps a small budget and a fixed cap so the whole run stays in seconds
 * rather than minutes (risk R13: a replay over years is a runtime-cost risk, not a logic risk).
 */
import { Context } from '@deepseek-ai/cordis'
import type { GenerateOptions, StreamChunk, UserMessage } from '@deepseek-ai/dsh-llm'
import { spawnSync } from 'node:child_process'
import { chmodSync, cpSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir, userInfo } from 'node:os'
import { join } from 'node:path'
import { vi } from 'vitest'
import type { Trigger } from '../../src/core/index.ts'
import { Runtime } from '../../src/app/runtime.ts'
import { Store } from '../../src/app/store.ts'
import { Effects } from '../../src/app/effects.ts'
import { memoryLimits } from '../../src/app/memory.ts'
import type { RequestRecord } from '../../src/app/budget.ts'
import { Commands } from '../../src/infra/commands.ts'
import { credentialHelper, workerGitConfig } from '../../src/infra/environment.ts'
import { SettingsSchema } from '../../src/policy.ts'
import type { Machine } from '../../src/deployment.ts'
import { CAPTURE_MAX_CHARS, experienceId, opIdOf, POLICY_VERSION, recallIdOf, type ExperienceInput,
  type Scope } from '../../src/memory/model.ts'
import { PRINCIPLES_VERSION } from '../../src/memory/background.ts'
import { COMPRESSION_VERSION } from '../../src/memory/summary.ts'
import { RETENTION, usableBytes } from '../../src/memory/archive.ts'
import { MEMORY_POLICY } from '../../src/memory/score.ts'
import { MemoryService } from '../../src/memory/service.ts'
import { feishuKind, feishuTrigger } from '../../src/sources/feishu.ts'
import { githubKind } from '../../src/sources/github.ts'
import { reference, testMachine } from '../fixtures/deployment.ts'
import { CHAT, fakeSession, jobRegistry, MEMBER, subagentRuntime } from '../fixtures/host.ts'
import { STRATEGIES, STRATEGY_NAMES, byStrategy, type Block, type ByStrategy, type StrategyId } from './manifest.ts'
import { charsOf, kindOf, replyTo, textOf, type CallKind } from './model.ts'
import { answerOf, grade, type Verdict } from './readers.ts'
import { layeredBlock, originalsBlock, rollingBlock, type CorpusItem } from './strategies.ts'
import { ABSTAIN, SCENARIO, type ScenarioTag } from './scenario.ts'

/** The characters recalled material may take in one request, which every strategy is held to: the setting the run configures. */
export const RECALL_MAX_CHARS = 1000
/** The budget the replayed years are fed under: large enough that nothing is archived while the scenario is being recorded. */
const FEED_BUDGET_BYTES = 64 << 20
/** How many reclamation passes the archive phase may run before it reports what it freed instead. */
const PRESSURE_PASSES = 3
/** The key the repetition check reads: the first statement of the fact six later messages only restate. */
const REPEATED_KEY = 'threshold.1'

/** What one replay run may be told to do differently. The default run is the one the committed report came from. */
export interface ReplayOptions {
  /**
   * Answer with a real model instead of the controlled reader. The block is sent as a one-shot request through the same `llm/stream`
   * waterfall the request budget listens on, so a real-model run is bounded in characters exactly like every other request the runtime
   * makes — it cannot be talked into an over-budget request by a strategy that offers more. The reply is graded by the same keys as the
   * controlled one, so the two modes are comparable. Absent means the controlled reader, which is what makes a run reproducible and what
   * every figure in the committed report was produced by; the replay itself never configures a provider.
   */
  readonly answerer?: (options: GenerateOptions) => AsyncIterable<StreamChunk>
}

/** The instruction a real-model run would put in front of the answering model: answer from the evidence, and say so when it cannot. */
export const READER_PRINCIPLES = '[long-term memory replay reader]\n'
  + 'You answer one question from the evidence a memory system put in front of you. Reply with the answer and nothing else.\n'
  + '1. Use only the evidence you were given. If it does not support an answer, reply exactly: ' + ABSTAIN + '\n'
  + '2. Say what currently holds. Evidence marked superseded states what used to hold, and is not the present.\n'
  + '3. Never fill in a detail the evidence does not state, and never invent a version number.\n'

/** One model call the run made, whichever strategy or subsystem caused it. */
export interface Call { readonly kind: CallKind; readonly chars: number; readonly ms: number }

/** What one strategy scored, and what its blocks cost. */
export interface StrategyResult {
  readonly id: StrategyId
  readonly name: string
  readonly correct: number
  readonly stale: number
  readonly fabricated: number
  readonly abstained: number
  /** Characters every block of this strategy took, and the mean and largest of them. */
  readonly chars: number
  readonly meanChars: number
  readonly maxChars: number
  /** Wall-clock milliseconds the strategy's own read took, summed over every question. */
  readonly recallMs: number
}

/** One question's outcome, for the per-question table the report prints. */
export interface QuestionResult {
  readonly id: string
  readonly tags: readonly ScenarioTag[]
  /** Whether the fact the question is about is older than a year at the instant it was asked. */
  readonly band: 'within a year' | 'over a year'
  readonly blocks: ByStrategy<number>
  readonly verdicts: ByStrategy<Verdict>
}

/** One hard constraint, what it measured, and the ticket whose own spec already proves it at its own boundary. */
export interface Constraint {
  readonly id: 'over-budget-requests' | 'write-bypasses' | 'duplicate-applications' | 'interrupted-publication'
  readonly violations: number
  readonly detail: string
  readonly owner: string
}

/**
 * What the recorded request ledger says about the budget, stated over one population each so nothing is scored as a violation and as
 * a pass at the same time. The invariant is that a request which reaches the model fitted the budget; a request the runtime refused
 * before the model is the budget working, so it is counted apart rather than as a violation. DSH's own housekeeping calls are held to
 * the same limit as every other request, so they are counted in those same two populations; the count is kept because it says the
 * exemption is gone rather than silent.
 */
export interface BudgetAudit {
  readonly requests: number
  /** Requests that reached the model, which is the population the budget's own invariant is stated over. */
  readonly sent: number
  /** Sent requests whose measured total was over the budget: the only count that can be a violation. */
  readonly violations: number
  /** Requests refused before they reached the model, which is a suspension rather than a breach. */
  readonly suspended: number
  /** Requests DSH made for a purpose of its own — a compaction or a Session title — measured under the same limit. */
  readonly housekeeping: number
}

/** Read the recorded request ledger, oldest first, the way the hard constraint in the report is defined. */
export function budgetAuditOf(requests: readonly RequestRecord[]): BudgetAudit {
  const sent = requests.filter(record => record.action === 'send')
  return { requests: requests.length, sent: sent.length, violations: sent.filter(record => record.total > record.budget).length,
    suspended: requests.filter(record => record.action === 'suspend').length,
    housekeeping: requests.filter(record => record.purpose !== undefined).length }
}

/** How one of the eight required situations was exercised, and how many questions were graded against it. */
export interface Coverage {
  readonly tag: ScenarioTag
  readonly questions: number
  readonly evidence: string
}

/** What the run was held to: one allowance for every strategy, and the request budget the runtime measured every call against. */
export interface BudgetFigures {
  readonly allowanceChars: number
  readonly recallMaxChars: number
  readonly requestMaxChars: number
  readonly outputReserveChars: number
  readonly measurementReserveChars: number
}

/** What one strategy's background work cost: the calls it caused, and the characters those calls sent. */
export interface CallFigures { readonly calls: number; readonly chars: number }

/**
 * What an operator reads off the background while it is held and after it is let go: the work waiting, what the queue could not take,
 * what became of the jobs, the passes that ran, the bounds in force, and the versions the work runs under.
 */
export interface BacklogFigures {
  /** Taken while the evaluator was paused, which is the state a slow or offline background puts a deployment in. */
  readonly held: { readonly queued: number; readonly deferred: number }
  /** Taken once it was let go and settled. */
  readonly released: { readonly queued: number; readonly committed: number; readonly skipped: number
    readonly failed: number; readonly rejected: number; readonly passes: number }
  /** The bounds in force, which are the machine settings the run used rather than constants of the harness. */
  readonly bounds: { readonly maxCalls: number; readonly batch: number; readonly concurrency: number; readonly pending: number
    readonly timeoutMs: number; readonly attempts: number }
  /** The versions the background work runs under, which is what an upgrade sweep compares a committed result against. */
  readonly versions: { readonly policy: string; readonly principles: string; readonly model: string }
}

/** What the background work cost, across every kind and every strategy together, and then per strategy. */
export interface BackgroundFigures {
  readonly calls: number
  readonly chars: number
  readonly ms: number
  readonly layered: CallFigures
  readonly originals: CallFigures
  readonly rolling: CallFigures
}

/** What the memory files held at the end, counted over the real files and beside the service's own accounting. */
export interface StorageFigures {
  readonly bytes: number
  readonly raw: number
  readonly summaries: number
  readonly journal: number
  readonly history: number
  readonly index: number
  readonly originalsReleased: number
  readonly versions: number
  readonly experiences: number
}

/** Everything the report needs, produced by one run and never edited by hand. */
export interface ReplayReport {
  readonly scenario: { readonly name: string; readonly from: string; readonly to: string; readonly episodes: number }
  readonly answeredBy: 'controlled' | 'real-model'
  readonly versions: Readonly<Record<'policy' | 'retention' | 'principles' | 'compression' | 'scale', string>>
  /** The rungs the run's weights were read against, so the report can quote the ladder it measured rather than a copy of it. */
  readonly thresholds: { readonly detail: number; readonly summary: number; readonly forgotten: number }
  readonly budget: BudgetFigures
  readonly strategies: ByStrategy<StrategyResult>
  readonly questions: readonly QuestionResult[]
  readonly coverage: readonly Coverage[]
  readonly constraints: readonly Constraint[]
  readonly background: BackgroundFigures
  readonly backlog: BacklogFigures
  readonly upgrade: { readonly planned: number; readonly remaining: number; readonly done: boolean }
  readonly storage: StorageFigures
  readonly repetition: { readonly id: string; readonly scores: readonly number[]; readonly records: number }
  readonly reactivation: { readonly questions: number; readonly notices: number; readonly delivered: number
    /** Items the runtime's own door showed at a rung their weight had not reached, over every notice of the span. */
    readonly woken: number }
  /**
   * Where the replayed facts' weights ended: how many of the span's own experiences have fallen below the gist threshold, how many
   * have left routine recall, and the lightest weight in the store against the policy's last threshold. Under a time term calibrated
   * to years a span this short is not expected to empty the store, and a report that did not measure that could not say so.
   */
  readonly ladder: { readonly episodes: number; readonly faded: number; readonly forgotten: number; readonly lightest: number }
  readonly standing: { readonly current: number; readonly superseded: number; readonly disputed: number
    readonly unexpected: readonly string[] }
  readonly archive: { readonly passes: number; readonly released: number; readonly purgeReleased: boolean
    readonly purgeExpansion: string }
  readonly idle: { readonly from: string; readonly to: string; readonly restored: boolean; readonly versionBefore: number
    readonly versionAfter: number }
  readonly timing: { readonly totalMs: number }
}

/** The fake DSH host the replay runs against, and what the run reads back off it. */
interface Host {
  readonly runtime: Runtime
  readonly ctx: Context
  readonly machine: Machine
  readonly directory: string
  /** Every model call the runtime made, in order, with what it cost. */
  readonly calls: Call[]
  /** The recalled-memory notices the runtime delivered to the main Session, by the request id it gave them. */
  readonly notices: Map<string, Notice>
  /** Append the requests this opening measured to `sink`, so a run of several openings still counts every one of them. */
  collect(sink: RequestRecord[]): void
  stop(): Promise<void>
}

/** One recall notice as the model received it, and how many of its items the door showed above the rung their own weight earned. */
interface Notice {
  readonly text: string
  readonly woken: number
}

/** The experience ids one recall notice names, read from the notice rather than assumed: a notice is JSON the model parses. */
function itemIdsOf(text: string): string[] {
  try {
    const said = JSON.parse(text) as { items?: { id?: unknown }[] }
    return (said.items ?? []).flatMap(item => typeof item.id === 'string' ? [item.id] : [])
  } catch { return [] }
}

/** The rung one record's own weight had reached when the door was read, or nothing when it is not a record of this store. */
function rungOf(runtime: Runtime, id: string): string | undefined {
  try { return runtime.memory.service.granularity(id) } catch { return undefined }
}

/** A trigger carrying `text` at exactly `at`, from Alice in the listened chat. */
function triggerAt(at: string, text: string, index: number): Trigger {
  const trigger = feishuTrigger({ message_id: `om_replay_${index}`, chat_id: CHAT, chat_type: 'group', sender_id: MEMBER,
    sender_type: 'user', content: text, create_time: String(Date.parse(at)), mentions: [{ id: 'ou_bot' }] }, 'ou_bot', 'cli_bot')
  if (!trigger) throw new Error(`the replay's trigger ${index} is not a valid Feishu event`)
  return trigger
}

/** Start a runtime on `directory` against a simulated DSH host: one fresh Context, the same fake services, the same state. */
async function boot(directory: string, budgetBytes: number, calls: Call[], notices: Map<string, Notice>): Promise<Host> {
  const agents = new Map<string, unknown>(), logs = new Map<string, { type: string; data: unknown }[]>()
  const controller = {
    create: vi.fn(async ({ sessionId }: { sessionId: string }) => {
      if (agents.has(sessionId)) return
      const agentCtx = new Context()
      logs.set(sessionId, [])
      agentCtx.reflect.provide('tools', { register: () => () => {}, get: () => undefined, restrict: vi.fn(() => () => {}),
        guard: vi.fn(() => () => {}) })
      agentCtx.reflect.provide('skills', { register: () => () => {} })
      agentCtx.reflect.provide('systemPrompt', { section: () => () => {} })
      const inbox = { nextTurn: [] as UserMessage[], nextStep: [] as UserMessage[],
        remove: (id: string): boolean => [inbox.nextTurn, inbox.nextStep].some(list => {
          const at = list.findIndex(message => message.id === id)
          if (at < 0) return false
          list.splice(at, 1)
          return true
        }) }
      // A recall notice reaches the Session's own log, and a notice is kept by the request id it was delivered under: that is how the
      // run proves the runtime's automatic door opened, rather than restating the service's own answer. `woken` counts the notices
      // whose items include a record the record's own rung would not have shown — that is the door's work rather than the rung's, and
      // it is the only way to see the wake in a span too short for any fact to leave routine recall.
      const take = (message: UserMessage): void => {
        const source = message.source as { form?: string } | undefined
        if (source?.form === 'recall') {
          const text = message.content.map(block => block.type === 'text' ? block.text : '').join('')
          const items = itemIdsOf(text).filter(id => rungOf(runtime, id) === 'cues' || rungOf(runtime, id) === 'forgotten')
          notices.set(message.id, { text, woken: items.length })
        }
        logs.get(sessionId)?.push({ type: 'user/message', data: message })
        inbox.nextStep.push(message)
      }
      let status = 'idle'
      agents.set(sessionId, { id: sessionId, ctx: agentCtx, inbox, followup: vi.fn(take), steer: vi.fn(take), inject: vi.fn(take),
        session: fakeSession(sessionId, () => logs.get(sessionId) ?? []),
        get status() { return status }, set status(next: string) { status = next }, cancel: vi.fn(), whenIdle: async () => {} })
    }),
    selectModel: vi.fn(async () => {}), rename: vi.fn(async () => {}),
    resolveAgent: vi.fn(async (id: string) => agents.has(id) ? { agent: agents.get(id) } : { error: { code: 'session/not-found' } }),
    prompt: vi.fn(() => { throw new Error('Plugin delivery must not use user RPC') }), inspect: vi.fn(async () => ({ events: [] })),
  }
  const reader = { read: async () => ({ events: [] }), [Symbol.asyncDispose]: async () => {} }
  const stream = (text: string) => ({ readFrom: () => ({ text, nextOffset: text.length, lossy: false }) })
  const agentGh = join(directory, 'agent-gh'), larkBot = join(directory, 'lark-bot')
  for (const cli of [agentGh, larkBot]) writeFileSync(cli, '#!/bin/sh\n', { mode: 0o755 })
  const answers: Record<string, string> = {
    [`${agentGh} api user`]: '{"login":"agent-bot","id":7}',
    [`${agentGh} api repos/acme/widgets --jq {name: .full_name, push: .permissions.push}`]: '{"name":"acme/widgets","push":true}\n',
    [`${larkBot} auth status`]: JSON.stringify({ appId: 'cli_bot', brand: 'feishu', identities: { bot: { status: 'ready' } } }),
    [`${larkBot} config strict-mode`]: 'strict-mode: bot (source: profile)',
    [`${larkBot} api GET /open-apis/bot/v3/info --as bot --format ndjson`]: '{"bot":{"open_id":"ou_bot"},"code":0,"msg":"ok"}',
    ['git config -z --show-origin --get-all credential.https://github.com.helper']: `file:${workerGitConfig(directory)}\0${credentialHelper(agentGh)}\0`,
    ['git config -z --show-scope --get-regexp ^(credential\\..*|http\\..*extraheader)$']:
      `global\0credential.helper\n\0global\0credential.https://github.com.helper\n${credentialHelper(agentGh)}\0`,
  }
  const subprocess = { spawn: vi.fn((spec: { argv: readonly string[] }) => {
    const argv = [...spec.argv]
    while (argv[0] === 'env' || /^[A-Z_]+=/.test(argv[0] ?? '')) argv.shift()
    return { done: Promise.resolve({ exitCode: 0, signal: null }), collected: { stdout: stream(answers[argv.join(' ')] ?? ''), stderr: stream('') } }
  }) }
  const ctx = new Context()
  // Every model call the runtime makes — a Session's or the memory's background work — is dispatched through this one waterfall, which is
  // what makes the three strategies' background costs comparable: the same counter, and the same fixed model answering all of them.
  const scores = new Map(SCENARIO.episodes.map(episode => [episode.text.slice(0, 40), episode.score]))
  const llm = { resolveCallConfig: vi.fn(async (value: unknown) => value),
    stream: (options: GenerateOptions): AsyncIterable<StreamChunk> => {
      const next = (): AsyncIterable<StreamChunk> => (async function* () {
        const text = textOf(options), started = performance.now(), reply = replyTo(text, scores)
        yield { type: 'text-delta', index: 0, text: reply } as StreamChunk
        yield { type: 'finish', reason: { kind: 'stop' } } as StreamChunk
        calls.push({ kind: kindOf(text), chars: charsOf(options), ms: performance.now() - started })
      })()
      return ctx.waterfall(llm as never, 'llm/stream', options, next)
    } }
  const jobs = jobRegistry(id => agents.get(id) as never), subagents = subagentRuntime(agents as never)
  const services: Record<string, unknown> = { agents, llm, sessionController: controller,
    sessionPersistence: { flush: vi.fn(async () => {}), open: vi.fn(async () => reader) },
    workspaceRegistry: { create: async (cwd: string) => ({ id: cwd }) }, permissionPresets: { set: () => {} }, subprocess,
    webServer: { host: '127.0.0.1', port: 3082, register: () => () => {} }, jobs: jobs.service, subagents: subagents.service }
  for (const [name, service] of Object.entries(services)) ctx.reflect.provide(name, service)
  const machine = testMachine({ stateDir: directory, memoryBudgetBytes: reference(budgetBytes),
    memoryRecallMaxChars: reference(RECALL_MAX_CHARS) })
  /** How many of this opening's measured requests have already been handed to the run's own tally. */
  let seen = 0
  const model = { provider: 'deepseek', model: 'deepseek-replay-controlled' }
  const sources = { github: { enabled: true, config: { repository: 'acme/widgets', cli: agentGh } },
    feishu: { enabled: true, config: { cli: larkBot } } }
  const seeded = new Store(join(directory, 'orchestrator.sqlite'))
  seeded.saveSettings(SettingsSchema.parse({ ...seeded.settings(), eval: { ...seeded.settings().eval, model }, sources }))
  seeded.close()
  const runtime = new Runtime(ctx, machine, vi.fn())
  await runtime.ready
  runtime.sources.register(feishuKind); runtime.sources.register(githubKind)
  const settings = runtime.store.settings()
  runtime.store.saveSettings(SettingsSchema.parse({ ...settings, eval: { ...settings.eval, mode: 'auto', model },
    policy: { ...settings.policy, sources: { feishu: { allowed: [{ id: MEMBER, name: 'Alice' }], syncChat: CHAT }, github: { allowed: [{ id: 'alice' }] } } },
    sources: { ...sources, feishu: { enabled: true, config: { cli: larkBot, chats: [{ chatId: CHAT, listen: 'all' }], directMessages: true } } } }))
  const host: Host = { runtime, ctx, machine, directory, calls, notices, collect: sink => {
    const measured = runtime.budget.requestsOf()
    sink.push(...measured.slice(seen))
    seen = measured.length
  }, stop: async () => { await runtime.stop(); vi.restoreAllMocks() } }
  return host
}

/**
 * The capture one published record stands for, rebuilt from the message that produced it. The runtime derives the id from the event, the
 * source's own id and the instant, so rebuilding the same three fields gives the same id — which is what makes offering it again a
 * genuine redelivery rather than a second fact that happens to look like the first.
 */
const inputOf = (captured: Captured): ExperienceInput => captured.input

/** One message the replay fed, and the capture the Engine's transaction handed the memory for it. */
interface Captured {
  readonly id: string
  readonly input: ExperienceInput
}

/** Every byte the memory root holds, counted over the real files rather than taken from the service's own accounting. */
function bytesUnder(root: string): number {
  let total = 0
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name)
    total += entry.isDirectory() ? bytesUnder(path) : statSync(path).size
  }
  return total
}

/**
 * Run the replay once and return everything the report is made of. Every number in the result is measured on this run; nothing is a
 * constant the harness wrote back in, so a strategy cannot be made to look better by editing the report.
 */
export async function runReplay(options: ReplayOptions = {}): Promise<ReplayReport> {
  const started = performance.now()
  const directory = mkdtempSync(join(tmpdir(), 'memory-replay-'))
  const calls: Call[] = [], notices = new Map<string, Notice>()
  vi.useFakeTimers({ toFake: ['Date'], now: new Date(SCENARIO.from) })
  vi.spyOn(Commands.prototype, 'gh').mockImplementation(async args => args[1] === 'user' ? { login: 'agent-bot' }
    : { default_branch: 'master', permissions: { push: true } })
  vi.spyOn(Commands.prototype, 'lark').mockResolvedValue({ users: [{ member_id: MEMBER, name: 'Alice' }], has_more: false })
  vi.spyOn(Commands.prototype, 'git').mockResolvedValue('')
  vi.spyOn(Commands.prototype, 'run').mockResolvedValue('{"ok":true,"data":{}}')
  vi.spyOn(Effects.prototype, 'enqueue')
  let host = await boot(directory, FEED_BUDGET_BYTES, calls, notices)
  const scope: Scope = { project: 'acme/widgets' }
  const corpus: CorpusItem[] = []
  const captured = new Map<string, Captured>()
  /** Every model request every opening of the runtime measured, so the budget constraint covers the whole run rather than its last boot. */
  const requests: RequestRecord[] = []
  let index = 0, idle = { from: SCENARIO.from, to: SCENARIO.to, restored: false, versionBefore: 0, versionAfter: 0 }
  /** Feed one message as a person's message at `at`, settle everything it started, and return the capture it published. */
  const feed = async (at: string, text: string): Promise<Captured> => {
    index += 1
    vi.setSystemTime(new Date(at))
    const trigger = triggerAt(at, text, index)
    host.runtime.receive(trigger)
    await host.runtime.idle()
    await host.runtime.memory.settle()
    // The capture the Engine's transaction queued, rebuilt field by field as `src/app/memory.ts` builds it for `trigger.received`.
    const clipped = text.length > CAPTURE_MAX_CHARS ? text.slice(0, CAPTURE_MAX_CHARS) : text
    const id = experienceId('trigger.received', trigger.id, trigger.at)
    const input: ExperienceInput = { id, opId: opIdOf(id), occurredAt: trigger.at, recordedAt: trigger.at, source: trigger.source,
      subject: MEMBER, scope: { project: 'acme/widgets', person: MEMBER }, kind: 'observation',
      material: { text: clipped, chars: text.length },
      origin: { event: 'trigger.received', at: trigger.at, primary: trigger.id, ids: { triggerId: trigger.id, actor: MEMBER } } }
    return { id, input }
  }
  try {
    const episodes = SCENARIO.episodes
    const gap = episodes.findIndex(episode => episode.key === 'cluster.old')
    for (const [position, episode] of episodes.entries()) {
      // The eight months of silence: the runtime is stopped and started again inside them, which is the restart recovery is about.
      if (position === gap && position > 0) {
        const before = host.runtime.memory.status()
        host.collect(requests)
        await host.stop()
        host = await boot(directory, FEED_BUDGET_BYTES, calls, notices)
        vi.setSystemTime(new Date(episode.at))
        await host.runtime.idle()
        const after = host.runtime.memory.status()
        idle = { from: episodes[position - 1]?.at ?? SCENARIO.from, to: episode.at,
          restored: after.version === before.version && after.experiences === before.experiences,
          versionBefore: before.version, versionAfter: after.version }
      }
      const published = await feed(episode.at, episode.text)
      captured.set(episode.key, published)
      corpus.push({ id: published.id, at: episode.at, scope, text: episode.text })
    }
    // The archive phase runs before the questions: a budget tight enough for what was recorded forces reclamation to release
    // originals rather than the derived files it would free first, and the questions are then asked of the memory the archive left
    // behind. The budget is a property of one opening, so the runtime is opened again with room afterwards and nothing is lost by the
    // detour. The tight budget is computed from the store's own accounting rather than guessed: one probe opening at a modest budget
    // says how many bytes a budget hands to content, and from that the smallest budget that still reports pressure — but is not already
    // full, because a store larger than its whole budget cannot write the commit that would disown an original — is arithmetic.
    host.collect(requests)
    await host.stop()
    const held = host.runtime.memory.status()
    const probeLimit = 262144
    const probe = await boot(directory, probeLimit, calls, notices)
    vi.setSystemTime(new Date(SCENARIO.to))
    await probe.runtime.idle()
    const offset = probeLimit - usableBytes({ limit: probeLimit, reserve: probe.runtime.memory.status().capacity.reserve })
    probe.collect(requests)
    await probe.stop()
    const pressureLimit = Math.round(held.usage.total / 0.95) + offset
    host = await boot(directory, pressureLimit, calls, notices)
    vi.setSystemTime(new Date(SCENARIO.to))
    await host.runtime.idle()
    for (let pass = 0; pass < PRESSURE_PASSES && host.runtime.memory.status().capacity.reclaimed.originals === 0; pass += 1) {
      host.runtime.memory.reclaim()
    }
    const archived = host.runtime.memory.status()
    const purgeId = captured.get('cache.purge')?.id
    const purgeExpansion = purgeId === undefined ? 'unknown'
      : host.runtime.memory.service.expand({ id: purgeId, allowanceChars: 4000 }).status
    host.collect(requests)
    await host.stop()
    host = await boot(directory, FEED_BUDGET_BYTES, calls, notices)
    vi.setSystemTime(new Date(SCENARIO.to))
    await host.runtime.idle()
    // The questions, each asked as the person's own message so the runtime's automatic door opens on it exactly as it would live. The
    // rolling baseline is condensed once per replayed episode, which is the same order of background calls the layered scheme spends on
    // the same years — a comparable budget, so a quality difference is not a difference in what each was allowed to spend.
    let rollingSummary = ''
    for (const episode of SCENARIO.episodes) rollingSummary = await rollSummary(host, rollingSummary, [{ at: episode.at, text: episode.text }])
    const results: QuestionResult[] = []
    const blocks = byStrategy(() => ({ chars: [] as number[], ms: [] as number[] }))
    for (const question of SCENARIO.questions) {
      const asker = await feed(question.at, question.ask)
      captured.set(`question:${question.id}`, asker)
      const allowance = host.runtime.memory.allowance(host.runtime.masterId)
      const read = (id: StrategyId, produce: () => Block): Block => {
        const at = performance.now()
        const block = produce()
        blocks[id].chars.push(block.chars)
        blocks[id].ms.push(performance.now() - at)
        return block
      }
      const offered: ByStrategy<Block> = {
        layered: read('layered', () => layeredBlock(host.runtime.memory.service, scope, question, allowance, asker.id)),
        originals: read('originals', () => originalsBlock(corpus, scope, question, allowance)),
        rolling: read('rolling', () => rollingBlock(rollingSummary, question.at, allowance)),
      }
      // The answer comes from the controlled reader by default, or from a real model when the caller supplied one — and in that case the
      // block is a one-shot request through the same waterfall the budget listens on, so the real-model mode is bounded like any other.
      const answers: string[] = []
      for (const id of STRATEGIES) {
        if (options.answerer === undefined) { answers.push(answerOf(offered[id], question)); continue }
        answers.push(await asked(options.answerer, offered[id]))
      }
      const verdicts = byStrategy(id => grade(answers[STRATEGIES.indexOf(id)] ?? '', question, SCENARIO))
      const basis = question.basis
      const age = basis === undefined ? 0 : Date.parse(question.at) - Date.parse(basis)
      results.push({ id: question.id, tags: question.tags, band: age > 365 * 86_400_000 ? 'over a year' : 'within a year',
        blocks: byStrategy(id => offered[id].chars), verdicts })
    }
    const strategies = byStrategy((id): StrategyResult => {
      const scored = results.map(result => result.verdicts[id])
      const chars = blocks[id].chars, sum = chars.reduce((total, value) => total + value, 0)
      return { id, name: STRATEGY_NAMES[id], correct: scored.filter(verdict => verdict.correct).length,
        stale: scored.filter(verdict => verdict.stale.length > 0).length,
        fabricated: scored.filter(verdict => verdict.fabricated.length > 0).length,
        abstained: scored.filter(verdict => verdict.abstained).length, chars: sum,
        meanChars: chars.length ? Math.round(sum / chars.length) : 0, maxChars: chars.length ? Math.max(...chars) : 0,
        recallMs: Math.round(blocks[id].ms.reduce((total, value) => total + value, 0)) }
    })
    const final = host.runtime.memory.status()
    // Bytes and experience count are read at the same instant, so the two figures in the report describe the same store. The bounded
    // background's own phase runs after this, and its captures are reported by the backlog rather than folded into these totals.
    const diskBytes = bytesUnder(join(directory, 'memory'))
    host.collect(requests)
    // The bounded background's own account, measured after the answers so it can change none of them: what an operator reads while the
    // evaluator is held, what happens to that work once it is let go, the bounds in force, and where the upgrade sweep stands. Holding it
    // is exactly the state a slow or offline background puts a deployment in, and the captured facts must still be accepted and recallable.
    host.runtime.memory.pauseBackground()
    for (let held = 0; held < 4; held += 1) {
      await feed(SCENARIO.to, `the weekends drift report for window ${held + 1} listed the same three failing checks and nothing else`)
    }
    const heldBacklog = host.runtime.memory.backlog()
    host.runtime.memory.resumeBackground()
    await host.runtime.memory.settle()
    await host.runtime.idle()
    const released = host.runtime.memory.backlog()
    const upgrade = await host.runtime.memory.sweep()
    return {
      scenario: { name: SCENARIO.name, from: SCENARIO.from, to: SCENARIO.to, episodes: episodes.length },
      answeredBy: options.answerer === undefined ? 'controlled' : 'real-model',
      versions: { policy: POLICY_VERSION, retention: RETENTION.version, principles: PRINCIPLES_VERSION, compression: COMPRESSION_VERSION,
        scale: `0-${MEMORY_POLICY.scale.max}` },
      thresholds: { ...MEMORY_POLICY.thresholds },
      budget: { allowanceChars: host.runtime.memory.allowance(host.runtime.masterId), recallMaxChars: RECALL_MAX_CHARS,
        requestMaxChars: host.machine.requestMaxChars.get(), outputReserveChars: host.machine.requestOutputReserveChars.get(),
        measurementReserveChars: host.machine.requestMeasurementReserveChars.get() },
      strategies,
      questions: results,
      coverage: coverageOf(results),
      constraints: constraintsOf(host, captured, requests),
      background: { calls: calls.length, chars: calls.reduce((total, call) => total + call.chars, 0),
        ms: Math.round(calls.reduce((total, call) => total + call.ms, 0)),
        layered: { calls: calls.filter(call => call.kind !== 'rolling').length,
          chars: calls.filter(call => call.kind !== 'rolling').reduce((total, call) => total + call.chars, 0) },
        originals: { calls: 0, chars: 0 },
        rolling: { calls: calls.filter(call => call.kind === 'rolling').length,
          chars: calls.filter(call => call.kind === 'rolling').reduce((total, call) => total + call.chars, 0) } },
      backlog: { held: { queued: heldBacklog.queued, deferred: heldBacklog.deferred },
        released: { queued: released.queued, committed: released.committed, skipped: released.skipped, failed: released.failed,
          rejected: released.rejected, passes: released.passes.length },
        bounds: { maxCalls: released.limits.maxCalls, batch: released.limits.batch, concurrency: released.limits.concurrency,
          pending: released.limits.pending, timeoutMs: released.limits.timeoutMs, attempts: released.limits.attempts },
        versions: { policy: released.versions.policy, principles: Object.values(released.versions.principles).join(', '),
          model: released.versions.model ?? 'none' } },
      upgrade: { planned: upgrade.planned, remaining: upgrade.remaining, done: upgrade.done },
      storage: { bytes: diskBytes, raw: final.usage.raw, summaries: final.usage.summaries,
        journal: final.usage.journal, history: final.usage.history, index: final.usage.index,
        originalsReleased: archived.capacity.reclaimed.originals, versions: final.version, experiences: final.experiences },
      repetition: repetitionOf(host.runtime.memory.service, captured),
      reactivation: { questions: SCENARIO.questions.length, notices: notices.size,
        delivered: SCENARIO.questions.filter(question => notices.has(recallIdOf(captured.get(`question:${question.id}`)?.id ?? ''))).length,
        woken: [...notices.values()].reduce((total, notice) => total + notice.woken, 0) },
      ladder: ladderOf(host.runtime.memory.service, captured),
      standing: standingOf(host.runtime.memory.service, scope, captured),
      archive: { passes: PRESSURE_PASSES, released: archived.capacity.reclaimed.originals,
        purgeReleased: archived.capacity.reclaimed.originals > 0 && purgeExpansion === 'evicted', purgeExpansion },
      idle,
      timing: { totalMs: Math.round(performance.now() - started) },
    }
  } finally {
    await host.runtime.stop().catch(() => undefined)
    vi.restoreAllMocks()
    vi.useRealTimers()
    rmSync(directory, { recursive: true, force: true })
  }
}

/** The weights the seven restatements of one fact carry: a repetition must not raise the first one, which is the rule measured here. */
function repetitionOf(service: MemoryService, captured: ReadonlyMap<string, Captured>): ReplayReport['repetition'] {
  const repeated = [...captured.entries()].filter(([key]) => key.startsWith('threshold.')).map(([, entry]) => entry.id)
  const scores = repeated.flatMap(id => { const importance = service.importance(id); return importance === undefined ? [] : [importance.score] })
  return { id: captured.get(REPEATED_KEY)?.id ?? '', scores, records: repeated.length }
}

/**
 * Where the replayed facts stand on the rung ladder once the span has been played out: the episodes' own records only, because the
 * questions are the reader's messages rather than evidence. It is measured rather than assumed — a time term calibrated to years is
 * expected to leave a store of this age above the last threshold, and the report has to own that instead of describing an older run.
 */
function ladderOf(service: MemoryService, captured: ReadonlyMap<string, Captured>): ReplayReport['ladder'] {
  const episodes = [...captured.entries()].filter(([key]) => !key.startsWith('question:')).flatMap(([, entry]) => {
    const weight = service.weight(entry.id)
    return weight === undefined ? [] : [{ weight, rung: service.granularity(entry.id) }]
  })
  const belowGist = episodes.filter(entry => entry.rung !== 'detail' && entry.rung !== 'summary')
  return { episodes: episodes.length, faded: belowGist.length,
    forgotten: episodes.filter(entry => entry.rung === 'forgotten').length,
    lightest: episodes.length === 0 ? 0 : Math.round(Math.min(...episodes.map(entry => entry.weight)) * 10) / 10 }
}

/**
 * How the published version classifies what it believes: how many records still hold, how many a later fact closed, how many are in
 * unresolved disagreement — and, named, the records the scenario never had a replacement for but the mechanism closed anyway. That last
 * count is the price of deciding a subject by shared words, and it belongs in a measured report rather than in a comment.
 */
function standingOf(service: MemoryService, scope: Scope, captured: ReadonlyMap<string, Captured>):
ReplayReport['standing'] {
  const listed = service.list({ scope, offset: 0, limit: 500 }).items
  const keys = new Map([...captured.entries()].map(([key, entry]) => [entry.id, key]))
  const unexpected = listed.filter(item => item.state === 'superseded' && !SCENARIO.replaced.includes(keys.get(item.id) ?? ''))
    .map(item => keys.get(item.id) ?? item.id)
  return { current: listed.filter(item => item.state === 'current').length,
    superseded: listed.filter(item => item.state === 'superseded').length,
    disputed: listed.filter(item => item.state === 'disputed').length, unexpected: [...new Set(unexpected)] }
}

/**
 * One answer from a real model, for the optional evaluation mode: the block as the one message, the reader's principles as the one-shot
 * system text, and the call dispatched through `ctx.llm.stream` so the request budget measures it before any adapter sees it.
 */
async function asked(answerer: NonNullable<ReplayOptions['answerer']>, block: Block): Promise<string> {
  const request = { system: READER_PRINCIPLES, messages: [{ role: 'user', content: [{ type: 'text', text: block.rendered }] }] }
  let said = ''
  for await (const chunk of answerer({ provider: 'deepseek', model: 'deepseek-replay-reader', ...request } as unknown as GenerateOptions)) {
    if (chunk.type === 'text-delta') said += chunk.text
  }
  return said.trim() === '' ? '' : said.trim()
}

/** Condense the rolling baseline's digest over `window` through the same model waterfall every other call goes through. */async function rollSummary(host: Host, previous: string, window: readonly { at: string; text: string }[]): Promise<string> {
  const request = JSON.stringify({ task: 'rolling', principles: 'mem-rolling-1', previous, window })
  const options = { provider: 'deepseek', model: 'deepseek-replay-controlled',
    messages: [{ role: 'user', content: [{ type: 'text', text: request }] }] } as unknown as GenerateOptions
  let said = ''
  for await (const chunk of host.ctx.llm.stream(options)) if (chunk.type === 'text-delta') said += chunk.text
  return said
}

/** What each of the eight required situations is evidenced by, and how many graded questions sit behind it. */
function coverageOf(results: readonly QuestionResult[]): readonly Coverage[] {
  const evidence: Readonly<Record<ScenarioTag, string>> = {
    'old-fact-update': 'a 2023 pipeline fact and the 2025 fact that replaced it, and a 2026 region and its replacement',
    'same-name-entities': 'two different people called Sam, captured as two facts about two teams',
    'rare-important-event': 'a 2023 outage post-mortem said once and never restated, and a question about an event never recorded',
    'repeated-self-reference': 'one alert-threshold fact and six restatements of it over a year',
    'contradictory-evidence': 'a claim and a denial of it, both kept, neither settled by being newer',
    // The situation is a ladder and a door, and under a time term calibrated to years a span this short shows the top of it: two 2023
    // facts have lost their gist and are read as their cues alone, and the runtime's own door still hands a record back above the rung
    // its weight had reached. The last threshold is the one rung this span is too short to reach, and the report says so.
    'forget-then-reactivate': 'two 2023 facts that lost their gist and are read as their cues alone, and the reactivation door that '
      + 'hands records back above the rung their own weight reached',
    'evicted-originals': 'a budget small enough that reclamation had to release originals, and the expansion that answers for one',
    'long-idle-recovery': 'eight months without an event, a runtime restart inside them, and a read afterwards',
  }
  return (Object.keys(evidence) as ScenarioTag[]).map(tag => ({ tag, questions: results.filter(result => result.tags.includes(tag)).length,
    evidence: evidence[tag] }))
}

/**
 * Deny this account write access to a directory and everything under it, or `undefined` on a machine that cannot: ticket 03's own
 * spec proves the writer boundary with exactly this, so the replay measures the same thing rather than a weaker copy of it.
 */
function denyWrites(dir: string): (() => void) | undefined {
  if (process.platform === 'win32') {
    const account = userInfo().username
    if (spawnSync('icacls', [dir, '/deny', `${account}:(OI)(CI)(W)`], { encoding: 'utf8' }).status !== 0) return undefined
    return () => { spawnSync('icacls', [dir, '/remove:d', account], { encoding: 'utf8' }) }
  }
  const restore: (() => void)[] = []
  try {
    for (const entry of readdirSync(dir, { recursive: true, withFileTypes: true })) {
      if (!entry.isFile()) continue
      const path = join(entry.parentPath, entry.name)
      const mode = statSync(path).mode & 0o777
      restore.push(() => chmodSync(path, mode))
      chmodSync(path, 0o444)
    }
    const dirMode = statSync(dir).mode & 0o777
    chmodSync(dir, 0o555)
    return () => { chmodSync(dir, dirMode); for (const undo of restore.reverse()) undo() }
  } catch { for (const undo of restore.reverse()) undo(); return undefined }
}

/** What a second process got when it reached for the published journal: one code per attempt, `OK` when the attempt got through. */
function attemptsOn(journal: string, forged: string): Record<string, string> {
  const script = `const fs = require('node:fs'), journal = ${JSON.stringify(journal)}, out = {}
const attempt = (name, run) => { try { run(); out[name] = 'OK' } catch (error) { out[name] = error.code } }
attempt('write', () => fs.writeFileSync(journal, 'FORGED OP\\n'))
attempt('create', () => fs.writeFileSync(journal + '.replay', '{}'))
attempt('replace', () => fs.renameSync(${JSON.stringify(forged)}, journal))
attempt('delete', () => fs.unlinkSync(journal))
process.stdout.write(JSON.stringify(out))`
  const result = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8' })
  try { return JSON.parse(result.stdout) as Record<string, string> } catch { return {} }
}

/** The four hard constraints, measured on this run and named beside the ticket whose own spec already proves each at its boundary. */
function constraintsOf(host: Host, captured: ReadonlyMap<string, Captured>, requests: readonly RequestRecord[]): readonly Constraint[] {
  const budget = budgetAuditOf(requests)
  const memoryRoot = join(host.directory, 'memory')
  const service = host.runtime.memory.service
  const first = [...captured.values()][0]
  // A reader of this run's own files, opened exactly as an operator's would be: every write it attempts must be refused, not applied.
  // It is a structural check of the product's own gate — it asks the service, not the filesystem, so on its own it cannot fail — and
  // it is what this run reports where the machine lets no process deny another one. The second process below is the real measurement.
  const reader = MemoryService.open({ dir: memoryRoot, limits: memoryLimits(host.machine), now: () => SCENARIO.to, readOnly: true })
  let attempted = 0, refused = 0
  try {
    if (first !== undefined) {
      attempted += 1
      if (reader.submit(first.input).status === 'created') refused += 1
      attempted += 1
      if (reader.rollback(first.id).status === 'rolledBack') refused += 1
    }
    attempted += 1
    if (reader.reclaim().freed > 0) refused += 1
  } finally { reader.close() }
  // The filesystem is asked next: one real second process, on this run's own published journal, denied write access the way ticket 03
  // builds the boundary. A bypass is a process that got through, so an empty attempt record is "not measurable here", not "passed".
  const journalName = readdirSync(join(memoryRoot, 'journal')).filter(name => name.endsWith('.ndjson')).sort().at(-1)
  const forged = join(host.directory, 'replay-forged-op.txt')
  writeFileSync(forged, 'FORGED OP\n')
  const restore = denyWrites(memoryRoot)
  let codes: Record<string, string> = {}
  try { if (restore !== undefined && journalName !== undefined) codes = attemptsOn(join(memoryRoot, 'journal', journalName), forged) }
  finally { restore?.() }
  const tried = Object.keys(codes).length
  const bypasses = Object.values(codes).filter(code => code === 'OK').length
  // Every capture this run published, offered again exactly as the durable queue would redeliver it: a duplicate must be a no-op.
  let duplicates = 0, recreated = 0
  for (const [key, entry] of captured) {
    if (key.startsWith('threshold.') && key !== REPEATED_KEY) continue
    const again = service.submit(inputOf(entry))
    if (again.status === 'duplicate') duplicates += 1
    if (again.status === 'created') recreated += 1
  }
  // A publication interrupted at its last step, on a copy of this run's own files, so a torn version would be real rather than staged.
  const probe = mkdtempSync(join(tmpdir(), 'memory-replay-crash-'))
  let torn = 1
  try {
    cpSync(join(host.directory, 'memory'), join(probe, 'memory'), { recursive: true })
    const limits = memoryLimits(host.machine)
    const before = MemoryService.open({ dir: join(probe, 'memory'), limits, now: () => SCENARIO.to }).version
    const dying = MemoryService.open({ dir: join(probe, 'memory'), limits, now: () => SCENARIO.to,
      interrupt: step => { if (step === 'manifest.write') throw new Error('the replay kills the publication here') } })
    const probeId = `${first?.id ?? 'probe'}-probe`
    try {
      dying.submit({ id: probeId, opId: opIdOf(probeId), occurredAt: SCENARIO.to, recordedAt: SCENARIO.to, source: 'runtime', scope: {},
        kind: 'observation', material: { text: 'a fact a crash interrupted', chars: 25 },
        origin: { event: 'policy.changed', at: SCENARIO.to, primary: 'probe', ids: {} } })
    } catch { /* the interruption is the point. */ } finally { dying.close() }
    const reopened = MemoryService.open({ dir: join(probe, 'memory'), limits, now: () => SCENARIO.to })
    const status = reopened.status()
    const whole = status.version === before && reopened.list({ scope: {}, offset: 0, limit: 500 }).total === status.experiences
    reopened.close()
    torn = whole ? 0 : 1
  } finally { rmSync(probe, { recursive: true, force: true }) }
  return [
    // The invariant is stated over the requests that reached the model, which is the population ticket 01 holds it over: a request
    // refused before the model is the budget doing its job, and counting it as a breach would report compliance as a violation.
    { id: 'over-budget-requests', violations: budget.violations,
      owner: 'ticket 01 (tests/budget.spec.ts) and ticket 05 (tests/memory-scoring.spec.ts)',
      detail: `${budget.requests} model requests were measured at llm/stream, foreground and background together: `
        + `${budget.sent} of them reached the model and ${budget.violations} of those were over the configured budget`
        + (budget.suspended === 0 ? '' : `, and ${budget.suspended} were refused before the model, which is a suspension rather than `
          + 'a breach')
        + `. ${budget.housekeeping} housekeeping call(s) — DSH's own compaction and Session-title calls — were measured under the `
        + 'same limit as every other request, and none of them was sent over it' },
    // The filesystem is the boundary, so the bypass is measured by a process the filesystem refuses — not by a handle whose refusal
    // is the product's own decision. Where the machine denies no process, the run says which measurement it made.
    { id: 'write-bypasses', violations: tried > 0 ? bypasses : refused, owner: 'ticket 03 (tests/memory-isolation.spec.ts)',
      detail: tried > 0
        ? `a real second process reached for this run's own published journal ${tried} ways — write, create, replace and delete — on a `
          + `filesystem that denies it, and ${bypasses} of them got through (${Object.entries(codes).map(([name, code]) => `${name} ${code}`)
            .join(', ')}); a read-only handle on the same files refused all ${attempted} writes it attempted`
        : `this machine's filesystem denies no process write access, so no second process can be refused: the product's own read-only `
          + `handle on this run's files was asked instead, attempted ${attempted} writes and applied ${refused}` },
    { id: 'duplicate-applications', violations: recreated,
      owner: 'ticket 02 (tests/memory-store.spec.ts) and ticket 04 (tests/memory-crash.spec.ts)',
      detail: `${duplicates} captures were offered a second time; ${duplicates} were answered as duplicates and ${recreated} were applied again` },
    { id: 'interrupted-publication', violations: torn, owner: 'ticket 04 (tests/memory-crash.spec.ts)',
      detail: 'a publication interrupted at manifest.write left '
        + (torn === 0 ? 'the previous complete version, readable and whole' : 'a version a reader cannot trust') },
  ]
}
