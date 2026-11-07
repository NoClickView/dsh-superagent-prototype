/**
 * The deployment's own boundary between the long-term memory's single writer and an agent's shell, measured as evidence rather than
 * assumed as policy: which conditions a shell would have to get past to edit the authoritative memory files, whether this deployment
 * meets them, and what it actually is. The write gate in `src/app/memory.ts` consumes the verdict, so a deployment that proves nothing
 * refuses to write instead of claiming a guarantee it does not have.
 *
 * What it cannot do, said plainly: on Windows a process inherits its parent's access token, `chmod` only toggles the read-only
 * attribute, Node has no ACL API, and the memory service is in-process code of the same Node process that starts the shells. So the
 * account, process or sandbox separation is the only thing that can hold, and this probe can merely report whether one is there.
 */
import { lstatSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { userInfo } from 'node:os'
import { join, relative, resolve, sep } from 'node:path'

/** The conditions a shell would have to get past to edit the memory files, and what this deployment did about each one. */
export interface IsolationGate {
  readonly name: 'sandbox' | 'preset' | 'outside' | 'links'
  readonly held: boolean
  /** What was found, in one clause an operator can act on. */
  readonly detail: string
}
/** What the deployment actually is, recorded whether or not a gate held, so a report shows what was checked. */
export interface IsolationFact {
  readonly name: 'platform' | 'account' | 'parent' | 'permissions'
  readonly detail: string
}
/** The probe's answer: `proven` only when every gate held, which is what admits long-term memory writes. */
export interface IsolationReport {
  readonly proven: boolean
  readonly gates: readonly IsolationGate[]
  readonly observed: readonly IsolationFact[]
  /** One sentence naming what a shell could reach, which the health entry and a refused capture quote verbatim. */
  readonly detail: string
}
/**
 * What the probe reads. The two DSH services and the Session are read through `ctx.get`, because a profile need not mount either of
 * them, and a deployment that mounts neither can prove nothing.
 */
export interface IsolationHost {
  /** The directory the memory root sits in, and the one a shell would replace it through. */
  readonly stateDir: string
  /** The memory root the memory service alone may write: `<stateDir>/memory` in the runtime. */
  readonly dir: string
  /** The roots a confined agent shell may write: the Execution settings' ticket directory. */
  readonly workspaces: readonly string[]
  readonly sandbox: () => unknown
  readonly presets: () => unknown
  /** The Session whose effective preset is the one a worker shell runs under. */
  readonly session: () => unknown
  /** Reads a directory's access control on a platform that has no ACL API in Node, such as `icacls` on Windows. */
  readonly acl?: (dir: string) => Promise<string | undefined>
}
/** The part of DSH's permission presets this probe reads: the preset a Session runs under and the two knobs it bundles. */
interface PresetReader {
  current(session: unknown): unknown
  resolve(name: string): unknown
}
/** The part of DSH's sandbox service this probe reads: how much of a preset its backend can enforce. A service that does not report
 * one proves nothing, which keeps the gate shut instead of open — the safe side of a field this build cannot compile against. */
interface SandboxReader { readonly enforcement?: unknown }

/** A path as the file system resolves it, so a comparison is about the same directory and not about its spelling. */
const canonical = (path: string): string => {
  let real: string
  try { real = realpathSync.native(path) } catch { real = resolve(path) }
  return process.platform === 'win32' ? real.toLowerCase() : real
}
/** Whether `path` is `root` or lies inside it, which is what makes the memory files reachable by a confined shell. */
function within(path: string, root: string): boolean {
  const from = canonical(root), to = canonical(path)
  return to === from || to.startsWith(from.endsWith(sep) ? from : from + sep)
}
/** The directories from `root` down to `path`, which are the places a link could stand in for the real one. */
function chain(root: string, path: string): string[] {
  const rest = relative(root, path)
  if (rest === '' || rest.startsWith('..')) return [path]
  return rest.split(sep).reduce<string[]>((walked, part) => [...walked, join(walked.at(-1) ?? root, part)], [root])
}
/** A link or junction at `path`, which on Windows needs no privilege to create and redirects every write behind it. */
const isLink = (path: string): boolean => { try { return lstatSync(path).isSymbolicLink() } catch { return false } }
/** The preset service, when the profile mounts one that can answer: a service without these methods proves nothing. */
const presetReader = (service: unknown): PresetReader | undefined => {
  const reader = service as Partial<PresetReader> | undefined
  return typeof reader?.current === 'function' && typeof reader.resolve === 'function' ? reader as PresetReader : undefined
}
/** Whether a preset confines a shell, and cannot be left for a wider one by an approval. */
const confines = (sandbox: unknown, approval: unknown): boolean =>
  (sandbox === 'read-only' || sandbox === 'workspace-write') && approval === 'never'

/**
 * Measure the boundary between the memory service and an agent's shell: the sandbox backend, the preset the Sessions run under, whether
 * a confined shell may write where the memory lives, and whether a link on the way there stands in for it. It never throws: a check it
 * cannot make is a gate that did not hold, which refuses writes rather than assuming them.
 */
export async function probeIsolation(host: IsolationHost): Promise<IsolationReport> {
  const account = userInfo().username
  const gates = [sandboxGate(host), presetGate(host), outsideGate(host), linksGate(host)]
  const observed = [platformFact(), accountFact(account), parentFact(host, account), await permissionsFact(host)]
  const missing = gates.filter(gate => !gate.held)
  return { proven: missing.length === 0, gates, observed,
    detail: missing.length === 0 ? `The deployment proves that a shell cannot write ${host.dir}`
      : `No boundary keeps an agent shell out of ${host.dir}: ${missing.map(gate => gate.detail).join('; ')}` }
}

/** A sandbox backend that enforces all of a preset is the only confinement DSH offers; `partial` is not a boundary. */
function sandboxGate(host: IsolationHost): IsolationGate {
  const service = host.sandbox()
  const enforcement = service === undefined ? undefined : (service as SandboxReader).enforcement
  if (service === undefined) return { name: 'sandbox', held: false, detail: 'no DSH sandbox service is mounted, so no preset confines a shell' }
  return enforcement === 'full'
    ? { name: 'sandbox', held: true, detail: 'the sandbox backend enforces a preset in full' }
    : { name: 'sandbox', held: false, detail: `the sandbox backend enforces only ${String(enforcement)} of a preset` }
}

/** The preset the bundle forces on its Sessions decides what a shell may write, and whether an approval can widen it. */
function presetGate(host: IsolationHost): IsolationGate {
  const reader = presetReader(host.presets())
  const session = host.session()
  if (!reader) return { name: 'preset', held: false, detail: 'no DSH permission preset service is mounted, so the preset a shell runs under is unknown' }
  if (session === undefined) return { name: 'preset', held: false, detail: 'no Session exists yet, so the preset a shell runs under is unknown' }
  let name: unknown, spec: unknown
  try { name = reader.current(session); spec = reader.resolve(String(name)) }
  catch (error) { return { name: 'preset', held: false, detail: `the preset a shell runs under could not be read: ${String(error)}` } }
  const { sandbox, approval } = (spec ?? {}) as { sandbox?: unknown; approval?: unknown }
  if (confines(sandbox, approval)) {
    return { name: 'preset', held: true, detail: `the Sessions run ${String(name)} (${String(sandbox)}, approval ${String(approval)}), which a shell cannot leave` }
  }
  const reason = sandbox === 'danger-full-access' ? 'a shell has the write access of the memory service itself'
    : sandbox === 'read-only' || sandbox === 'workspace-write' ? 'an approval can widen a denied write' : 'the preset confines nothing'
  return { name: 'preset', held: false, detail: `the Sessions run ${String(name)} (${String(sandbox)}, approval ${String(approval)}): ${reason}` }
}

/** A confined shell writes its workspace root, so the memory files must lie outside every root the Execution settings allow. */
function outsideGate(host: IsolationHost): IsolationGate {
  const reached = host.workspaces.filter(root => within(host.dir, root) || within(host.stateDir, root))
  const roots = host.workspaces.length ? host.workspaces.join(', ') : 'no directory'
  return reached.length === 0
    ? { name: 'outside', held: true, detail: `the memory directory is outside the roots a shell may write (${roots})` }
    : { name: 'outside', held: false, detail: `a shell may write ${reached.join(', ')}, which holds the memory directory` }
}

/** A junction needs no privilege on Windows, and a link where the memory directory should be redirects everything behind it. */
function linksGate(host: IsolationHost): IsolationGate {
  const linked = chain(host.stateDir, host.dir).filter(isLink)
  return linked.length === 0
    ? { name: 'links', held: true, detail: `no link stands on the way from ${host.stateDir} to the memory directory` }
    : { name: 'links', held: false, detail: `${linked.join(', ')} is a link, so it can stand in for the memory directory` }
}

const platformFact = (): IsolationFact => ({ name: 'platform', detail: process.platform })
const accountFact = (account: string): IsolationFact => ({ name: 'account', detail: account })

/** Whether the state directory takes a write from the account the shells run as, which is how a shell would replace the memory. */
function parentFact(host: IsolationHost, account: string): IsolationFact {
  const probe = join(host.stateDir, `.isolation-${process.pid}-${Date.now()}`)
  try {
    writeFileSync(probe, '')
    return { name: 'parent', detail: `${host.stateDir} is writable to ${account}, so a shell running as that account can replace the memory directory` }
  } catch (error) {
    return { name: 'parent', detail: `${host.stateDir} is not writable to ${account} (${String(error)}), so its files cannot be replaced there` }
  } finally { rmSync(probe, { force: true }) }
}

/** The memory directory's own permissions: the mode bits where the platform has them, the access control where it does not. */
async function permissionsFact(host: IsolationHost): Promise<IsolationFact> {
  if (process.platform === 'win32') {
    const text = await host.acl?.(host.dir).catch(() => undefined)
    return { name: 'permissions', detail: text === undefined || text.trim() === ''
      ? 'the access control of the memory directory could not be read, and Node has no ACL API'
      : text.trim().split('\n').slice(0, 4).join(' | ').trim() }
  }
  try {
    const mode = statSync(host.dir).mode & 0o777
    return { name: 'permissions', detail: mode & 0o022 ? `mode ${mode.toString(8)} lets group or other write` : `mode ${mode.toString(8)} keeps the directory to its owner` }
  } catch (error) { return { name: 'permissions', detail: `the mode of the memory directory could not be read: ${String(error)}` } }
}
