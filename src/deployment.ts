/** Plugin configuration and startup verification for repository access and agent CLI identities. */
import { LIMITS } from './limits.ts'
import type { MemoryWriteMode } from './limits.ts'
import { accessSync, constants, statSync } from 'node:fs'
import { delimiter, isAbsolute, join } from 'node:path'
import type { Volatile } from '@deepseek-ai/cordis'
import s from '@deepseek-ai/schemastery'
import { z } from 'zod'
import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import { runAsWorker, sameDirectory, withoutDirectory, workerBin } from './infra/environment.ts'
import { SetupError } from './setup.ts'

const reason = (error: unknown): string => error instanceof Error ? error.message : String(error)
const absolute = (description: string) => s.string().pattern(/^\//).description(`${description} Absolute path.`)
/** Plugin configuration of the dsh-superagent entry. Volatile fields apply without a restart because dsh-superagent reads them on each use; changing `stateDir` remounts the plugin. */
export const Config = s.object({
  stateDir: absolute('Directory for the database, locks, worker shims, the agent\'s git configuration and, by default, the ticket directories.').required(),
  promptMaxChars: s.number().min(LIMITS.promptMaxChars.min).max(LIMITS.promptMaxChars.max).step(1).default(100000)
    .description('Largest saved prompt configuration, in characters.').volatile(),
  admissionContextMaxPages: s.number().min(LIMITS.admissionContextMaxPages.min).max(LIMITS.admissionContextMaxPages.max).step(1).default(10)
    .description('Pages of thread context one assessment may read.').volatile(),
  admissionContextTimeoutMs: s.number().min(LIMITS.admissionContextTimeoutMs.min).max(LIMITS.admissionContextTimeoutMs.max).step(1)
    .default(15000).description('Time limit of one context read during an assessment, in milliseconds.').volatile(),
  requestMaxChars: s.number().min(LIMITS.requestMaxChars.min).max(LIMITS.requestMaxChars.max).step(1).default(400000)
    .description('Largest model request dsh-superagent lets through, in characters, counting its system prompt, tool definitions, conversation, tool results and recalled material.').volatile(),
  requestOutputReserveChars: s.number().min(LIMITS.requestReserveChars.min).max(LIMITS.requestReserveChars.max).step(1).default(32000)
    .description('Characters of requestMaxChars kept free for the model\'s answer.').volatile(),
  requestMeasurementReserveChars: s.number().min(LIMITS.requestReserveChars.min).max(LIMITS.requestReserveChars.max).step(1).default(8000)
    .description('Characters of requestMaxChars kept free for the measurement of a request.').volatile(),
  memoryBudgetBytes: s.number().min(LIMITS.memoryBudgetBytes.min).max(LIMITS.memoryBudgetBytes.max).step(1).default(67_108_864)
    .description('Total bytes the memory files under the state directory may use; a full store back-pressures rather than growing.')
    .volatile(),
  memoryRecallMaxChars: s.number().min(LIMITS.memoryRecallMaxChars.min).max(LIMITS.memoryRecallMaxChars.max).step(1).default(4000)
    .description('Largest recalled-memory notice one model request may carry, in characters, within that request\'s own budget.')
    .volatile(),
  memoryRecallWakes: s.number().min(LIMITS.memoryRecallWakes.min).max(LIMITS.memoryRecallWakes.max).step(1).default(8)
    .description('Reactivation notices one Session may receive in one recall window. It is the bound on how often a strong cue may '
      + 'interrupt a request, and it is not a lifetime quota: a notice stops counting one window after it landed.').volatile(),
  memoryRecallWindowMs: s.number().min(LIMITS.memoryRecallWindowMs.min).max(LIMITS.memoryRecallWindowMs.max).step(1).default(1_800_000)
    .description('How long one reactivation notice keeps counting, in milliseconds. A strong cue keeps waking old experiences inside '
      + 'this window and the allowance comes back as it passes, so neither a restart nor the agent has to give it back.').volatile(),
  memoryPendingMaxItems: s.number().min(LIMITS.memoryPendingMaxItems.min).max(LIMITS.memoryPendingMaxItems.max).step(1).default(256)
    .description('Captures that may wait in the durable queue for the long-term memory store to accept them. Their payloads may take '
      + 'as many bytes as memoryBudgetBytes, so the two settings are one finite capacity: once the queue holds what it may, the '
      + 'receiving boundary refuses further captures and reports them instead of storing material the store may never take.').volatile(),
  memoryRedeliveryMaxItems: s.number().min(LIMITS.memoryRedeliveryMaxItems.min).max(LIMITS.memoryRedeliveryMaxItems.max).step(1)
    .default(64).description('Captures the receiving boundary refused that may wait at the redelivery position, to be offered again '
      + 'one at a time once the queue has room. Their payloads may take as many bytes as memoryBudgetBytes, the same share the queue '
      + 'takes, and the oldest are evicted past either bound and counted as permanently lost rather than dropped in silence.')
    .volatile(),
  memoryWriteMode: s.union(LIMITS.memoryWriteMode.map(value => s.const(value))).default('require')
    .description('Whether long-term memory writes need a boundary that keeps an agent shell out of the memory files: `require` refuses '
      + 'every write when the deployment proves none, `waive` writes anyway and says so on the memory health entry.').volatile(),
  memoryBackgroundMaxCalls: s.number().min(LIMITS.memoryBackgroundMaxCalls.min).max(LIMITS.memoryBackgroundMaxCalls.max).step(1).default(8)
    .description('Model calls the long-term memory\'s background work may make in one pass before it yields to the foreground.')
    .volatile(),
  memoryBackgroundBatch: s.number().min(LIMITS.memoryBackgroundBatch.min).max(LIMITS.memoryBackgroundBatch.max).step(1).default(8)
    .description('Jobs one background pass takes from its queue in total, whatever calls it could still spend, and records one '
      + 're-evaluation sweep reads, at a time.').volatile(),
  memoryBackgroundConcurrency: s.number().min(LIMITS.memoryBackgroundConcurrency.min).max(LIMITS.memoryBackgroundConcurrency.max).step(1)
    .default(1).description('Background jobs one pass may run at once. One keeps every commit in the order the versions it read were '
      + 'published, which is why it is the default; more buys throughput and pays for it in results refused as stale.').volatile(),
  memoryBackgroundPending: s.number().min(LIMITS.memoryBackgroundPending.min).max(LIMITS.memoryBackgroundPending.max).step(1).default(256)
    .description('Background jobs that may wait for a model call. A plan beyond it is deferred and reported, never queued without end.')
    .volatile(),
  memoryBackgroundTimeoutMs: s.number().min(LIMITS.memoryBackgroundTimeoutMs.min).max(LIMITS.memoryBackgroundTimeoutMs.max).step(1)
    .default(60_000).description('Wall clock of one background model call before it is abandoned and recorded as a failure, in '
      + 'milliseconds; the foreground never waits on it.').volatile(),
  memoryBackgroundAttempts: s.number().min(LIMITS.memoryBackgroundAttempts.min).max(LIMITS.memoryBackgroundAttempts.max).step(1).default(2)
    .description('Attempts one experience\'s job of a kind may be given, across passes and restarts, before the background leaves it alone.')
    .volatile(),
})
export type DeploymentConfig = ReturnType<typeof Config>
export interface Machine {
  stateDir: string
  promptMaxChars: Volatile<number>
  admissionContextMaxPages: Volatile<number>
  admissionContextTimeoutMs: Volatile<number>
  requestMaxChars: Volatile<number>
  requestOutputReserveChars: Volatile<number>
  requestMeasurementReserveChars: Volatile<number>
  memoryBudgetBytes: Volatile<number>
  memoryRecallMaxChars: Volatile<number>
  memoryRecallWakes: Volatile<number>
  memoryRecallWindowMs: Volatile<number>
  memoryPendingMaxItems: Volatile<number>
  memoryRedeliveryMaxItems: Volatile<number>
  memoryWriteMode: Volatile<MemoryWriteMode>
  memoryBackgroundMaxCalls: Volatile<number>
  memoryBackgroundBatch: Volatile<number>
  memoryBackgroundConcurrency: Volatile<number>
  memoryBackgroundPending: Volatile<number>
  memoryBackgroundTimeoutMs: Volatile<number>
  memoryBackgroundAttempts: Volatile<number>
}
const MOVED: Record<string, string> = {
  repository: 'on the GitHub Source', branchPrefix: 'in the prepare command of the Execution settings', github: 'on the GitHub Source',
  feishu: 'on the Feishu Source', author: 'prompt text', repositoryPath: 'in the prepare command of the Execution settings',
  worktreeRoot: 'the ticket directory of the Execution settings', blockedCommands: 'in the Execution settings',
}

/** Read machine settings and reject unknown configuration keys (naming where deprecated keys moved). */
export function machineOf(config: DeploymentConfig): Machine {
  const unknown = Object.keys(config).filter(key => !(key in (Config.dict ?? {})))
  if (unknown.length) throw new Error(`dsh-superagent configuration has keys it does not use: ${unknown.map(key => MOVED[key] ? `${key} (now ${MOVED[key]})` : key).join(', ')}; docs/006-deployment.md lists the keys`)
  const { stateDir, promptMaxChars, admissionContextMaxPages, admissionContextTimeoutMs, requestMaxChars, requestOutputReserveChars,
    requestMeasurementReserveChars, memoryBudgetBytes, memoryRecallMaxChars, memoryRecallWakes, memoryRecallWindowMs, memoryPendingMaxItems,
    memoryRedeliveryMaxItems, memoryWriteMode, memoryBackgroundMaxCalls, memoryBackgroundBatch, memoryBackgroundConcurrency,
    memoryBackgroundPending, memoryBackgroundTimeoutMs, memoryBackgroundAttempts } = config
  // A budget whose reserves take all of it admits no request at all, which is a configuration error, not a runtime state.
  const reserved = requestOutputReserveChars.get() + requestMeasurementReserveChars.get()
  if (reserved >= requestMaxChars.get()) {
    throw new Error(`dsh-superagent reserves ${reserved} characters of a ${requestMaxChars.get()}-character model request: `
      + 'requestOutputReserveChars and requestMeasurementReserveChars must total less than requestMaxChars')
  }
  return { stateDir, promptMaxChars, admissionContextMaxPages, admissionContextTimeoutMs, requestMaxChars, requestOutputReserveChars,
    requestMeasurementReserveChars, memoryBudgetBytes, memoryRecallMaxChars, memoryRecallWakes, memoryRecallWindowMs, memoryPendingMaxItems,
    memoryRedeliveryMaxItems, memoryWriteMode, memoryBackgroundMaxCalls, memoryBackgroundBatch, memoryBackgroundConcurrency,
    memoryBackgroundPending, memoryBackgroundTimeoutMs, memoryBackgroundAttempts }
}

export const GithubAccountsSchema = z.object({
  repository: z.string().trim().regex(/^([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)?$/, 'owner/name').default(''),
  cli: z.string().trim().default(''),
})
export const FeishuBotSchema = z.object({ cli: z.string().trim().default('') })
/** Source configuration keys that affect deployment setup and trigger a restart when changed. */
export const SETUP_FIELDS: Readonly<Record<string, readonly string[]>> = { github: Object.keys(GithubAccountsSchema.shape), feishu: Object.keys(FeishuBotSchema.shape) }

export interface Deployment extends Machine {
  repository: string
  github: { cli: string; login: string; noreply: string }
  feishu?: FeishuBot
}
export interface FeishuBot { cli: string; appId: string; brand: 'feishu' | 'lark'; botId: string; name: string }

/** Resolve a command name or absolute path to an executable file, ignoring the worker shim directory. */
export function executable(name: string, path: string, exclude?: string): string {
  if (name.includes('/') && !isAbsolute(name)) throw new Error(`${name} must be a command name or an absolute path`)
  const candidates = isAbsolute(name) ? [name] : path.split(delimiter).filter(dir => isAbsolute(dir) && !(exclude && sameDirectory(dir, exclude))).map(dir => join(dir, name))
  for (const candidate of candidates) {
    try { if (statSync(candidate).isFile()) { accessSync(candidate, constants.X_OK); return candidate } }
    catch { /* Not an executable file here; try the next PATH directory. */ }
  }
  throw new Error(`${name} is not an executable file${isAbsolute(name) ? '' : ' on PATH'}`)
}

export type Probe = (argv: string[]) => Promise<string>
/** Run startup checks through DSH's worker subprocess service with worker shims removed from PATH so a `gh` wrapper script reaches the real binary. */
export function workerProbe(subprocess: SubprocessRuntime, stateDir: string, cwd: string, signal: AbortSignal): Probe {
  const path = withoutDirectory(process.env.PATH ?? '', workerBin(stateDir))
  return argv => runAsWorker(subprocess, ['env', `PATH=${path}`, ...argv], cwd, AbortSignal.any([signal, AbortSignal.timeout(60_000)]))
}

const GithubUser = z.object({ login: z.string().regex(/^[A-Za-z0-9-]+$/), id: z.number().int().positive() })
const RepositoryAccess = z.object({ name: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/), push: z.boolean().nullable() })
function parsed<T>(schema: z.ZodType<T>, text: string): T | undefined {
  let value: unknown
  try { value = JSON.parse(text) } catch { return undefined /* Non-JSON output; the caller surfaces the setup failure. */ }
  const result = schema.safeParse(value)
  return result.success ? result.data : undefined
}
/** Verify the agent's GitHub CLI identity and push access to the configured repository. */
export async function resolveDeployment(machine: Machine, github: unknown, probe: Probe, path = process.env.PATH ?? ''): Promise<Deployment> {
  const { stateDir } = machine
  const accounts = GithubAccountsSchema.parse(github ?? {})
  const remote = accounts.repository
  if (!remote) throw new SetupError('repositoryUnset')
  if (!accounts.cli) throw new SetupError('agentCliUnset')
  let cli: string
  try { cli = executable(accounts.cli, path, workerBin(stateDir)) } catch (error) { throw new SetupError('agentCliMissing', { output: reason(error) }) }
  const text = await probe([cli, 'api', 'user']).catch((error: unknown) => { throw new SetupError('agentCliSignedOut', { output: reason(error) }) })
  const agent = parsed(GithubUser, text)
  if (!agent) throw new SetupError('agentCliNoAccount')
  // Use the canonical repository name returned by GitHub so renamed repositories match incoming notifications.
  const access = parsed(RepositoryAccess, await probe([cli, 'api', `repos/${remote}`, '--jq', '{name: .full_name, push: .permissions.push}']).catch((error: unknown) => {
    throw new SetupError('repositoryUnreadable', { account: agent.login, repository: remote, output: reason(error) })
  }))
  if (!access) throw new SetupError('repositoryUnreported', { repository: remote })
  const repository = access.name
  if (access.push !== true) throw new SetupError('repositoryReadOnly', { account: agent.login, repository })
  return { ...machine, repository, github: { cli, login: agent.login, noreply: `${agent.id}+${agent.login}@users.noreply.github.com` } }
}

const AuthStatus = z.object({ appId: z.string().regex(/^cli_[A-Za-z0-9]+$/), brand: z.enum(['feishu', 'lark']).default('feishu'), identities: z.object({ bot: z.object({ status: z.string() }) }) })
const BotInfo = z.object({ bot: z.object({ open_id: z.string().regex(/^ou_[A-Za-z0-9]+$/), app_name: z.string().default('') }) })
/**
 * Verify that the configured Feishu CLI is authenticated as a bot and restricted to strict mode `bot`.
 * Workers invoke this CLI as `lark-cli`, so a CLI that also permits a user identity would let workers act as that user.
 */
export async function resolveFeishuBot(machine: Machine, feishu: unknown, probe: Probe, path = process.env.PATH ?? ''): Promise<FeishuBot | undefined> {
  const { cli: name } = FeishuBotSchema.parse(feishu ?? {})
  if (!name) return undefined
  const fail = (error: unknown): never => { throw error instanceof SetupError ? error : new SetupError('feishuCliFailed', { output: reason(error) }) }
  let cli = ''
  try { cli = executable(name, path, workerBin(machine.stateDir)) } catch (error) { fail(error) }
  const run = (...args: string[]): Promise<string> => probe(['env', 'LARKSUITE_CLI_NO_UPDATE_NOTIFIER=1', 'LARKSUITE_CLI_NO_SKILLS_NOTIFIER=1', cli, ...args]).catch(fail)
  const text = await run('auth', 'status')
  const status = parsed(AuthStatus, text.slice(text.indexOf('{')))
  if (!status) return fail(new SetupError('feishuNoApp'))
  if (status.identities.bot.status !== 'ready') fail(new SetupError('feishuBotNotReady', { app: status.appId, status: status.identities.bot.status }))
  const mode = /strict-mode:\s*(\w+)/.exec(await run('config', 'strict-mode'))?.[1]
  if (mode !== 'bot') fail(new SetupError('feishuUserIdentity', { mode: mode ?? 'unknown' }))
  // `--format json` unwraps only `data`, whereas this endpoint returns the payload under `bot`.
  const info = parsed(BotInfo, (await run('api', 'GET', '/open-apis/bot/v3/info', '--as', 'bot', '--format', 'ndjson')).split('\n')[0] ?? '')
  if (!info) return fail(new SetupError('feishuNoBot'))
  return { cli, appId: status.appId, brand: status.brand, botId: info.bot.open_id, name: info.bot.app_name }
}
