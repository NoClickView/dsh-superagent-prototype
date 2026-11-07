/**
 * The boundary the long-term memory's single writer needs, and what the product does when the deployment does not have one: the
 * probe's verdicts on a real temporary directory, the write gate the service consumes, a real restricted process kept out of the
 * authoritative files where this machine can restrict one, and the runtime refusing to enable writes with the reason on its own
 * health entry. Only outcomes are asserted — files on disk, service results, permission denials — never classes or call counts.
 */
import { spawnSync } from 'node:child_process'
import { appendFileSync, chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir, userInfo } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { probeIsolation, type IsolationHost } from '../src/infra/isolation.ts'
import { writeGate } from '../src/app/memory.ts'
import { MemoryService, type WriteGate } from '../src/memory/service.ts'
import { MEMORY_POLICY, ruleScoreOf } from '../src/memory/score.ts'
import { feishu, startRuntime, type Host } from './fixtures/host.ts'
import { reference, testMachine } from './fixtures/deployment.ts'
import { memoryInput, testLimits } from './fixtures/memory.ts'

let home: string, stateDir: string, memoryDir: string, workDir: string

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'memory-isolation-'))
  stateDir = join(home, 'state'); workDir = join(stateDir, 'work'); memoryDir = join(stateDir, 'memory')
  mkdirSync(memoryDir, { recursive: true }); mkdirSync(workDir, { recursive: true })
})
afterEach(() => { rmSync(home, { recursive: true, force: true }) })

/** The sandbox service of a deployment whose backend enforces confinement (`full`, `partial`, or none mounted). */
const sandbox = (enforcement: 'full' | 'partial') => () => ({ enforcement })
/** The preset table of a deployment: the preset the Session runs under, and the two knobs it bundles. */
const presets = (mode: string, approval: string) => () => ({ current: () => 'the preset', resolve: () => ({ sandbox: mode, approval }) })
/** What the probe reads, on this test's temporary state directory: a deployment that confines nothing until a test says so. */
const host = (overrides: Partial<IsolationHost> = {}): IsolationHost => ({ stateDir, dir: memoryDir, workspaces: [workDir],
  sandbox: () => undefined, presets: () => undefined, session: () => ({ id: 'orchestrator-7' }), ...overrides })
/** A link at `path` pointing at `target`: a junction on Windows, a directory link elsewhere. */
const linkDirectory = (path: string, target: string): void => {
  if (process.platform === 'win32') expect(spawnSync('cmd', ['/c', 'mklink', '/J', path, target]).status).toBe(0)
  else symlinkSync(target, path, 'dir')
}

describe('the deployment boundary', () => {
  it('proves nothing on a deployment whose shells run unconfined as the operator', async () => {
    const report = await probeIsolation(host({ presets: presets('danger-full-access', 'never') }))
    expect(report.proven).toBe(false)
    expect(report.gates.map(gate => [gate.name, gate.held])).toEqual([['sandbox', false], ['preset', false], ['outside', true], ['links', true]])
    // The refusal names the condition that failed, so an operator can act on it rather than guess.
    expect(report.detail).toContain('danger-full-access')
  })

  it('proves the boundary a confined deployment establishes', async () => {
    const report = await probeIsolation(host({ sandbox: sandbox('full'), presets: presets('workspace-write', 'never') }))
    expect(report.proven).toBe(true)
    expect(report.gates.filter(gate => !gate.held)).toEqual([])
  })

  it('keeps the boundary unproven when the backend enforces only part of a preset, or approval can widen it', async () => {
    const partial = await probeIsolation(host({ sandbox: sandbox('partial'), presets: presets('workspace-write', 'never') }))
    expect(partial.proven).toBe(false)
    // `ask` is an escalation path: the shell can be widened with an approval, so the preset is not a boundary on its own.
    const escalatable = await probeIsolation(host({ sandbox: sandbox('full'), presets: presets('workspace-write', 'ask') }))
    expect(escalatable.proven).toBe(false)
    expect(escalatable.gates.find(gate => gate.name === 'preset')).toMatchObject({ held: false })
  })

  it('keeps the boundary unproven when a confined shell may write the state directory itself', async () => {
    // The trap behind risk R4: an Execution directory set to the state directory makes the memory files part of the workspace.
    const report = await probeIsolation(host({ sandbox: sandbox('full'), presets: presets('workspace-write', 'never'), workspaces: [stateDir] }))
    expect(report.proven).toBe(false)
    expect(report.gates.find(gate => gate.name === 'outside')).toMatchObject({ held: false })
  })

  it('keeps the boundary unproven when a link stands where the memory directory should be', async () => {
    const elsewhere = join(home, 'elsewhere')
    mkdirSync(elsewhere)
    rmSync(memoryDir, { recursive: true })
    linkDirectory(memoryDir, elsewhere)
    const report = await probeIsolation(host({ sandbox: sandbox('full'), presets: presets('workspace-write', 'never') }))
    expect(report.proven).toBe(false)
    expect(report.gates.find(gate => gate.name === 'links')).toMatchObject({ held: false })
  })

  it('records what the deployment is, whether or not it proves a boundary', async () => {
    const report = await probeIsolation(host({ presets: presets('danger-full-access', 'never') }))
    const observed = report.observed.map(fact => fact.name)
    // The platform, the account a shell runs as, whether the memory directory's parent is writable, and its permissions.
    expect(observed).toEqual(['platform', 'account', 'parent', 'permissions'])
    expect(report.observed.find(fact => fact.name === 'platform')?.detail).toBe(process.platform)
    // The parent is the state directory, which this process writes; a shell running as this account can replace the directory.
    expect(report.observed.find(fact => fact.name === 'parent')?.detail).toContain('writable')
  })
})

describe('the memory write gate', () => {
  /** The decision the deployment reached, which the service reads on every write rather than capturing it once. */
  let gate: WriteGate
  const opened = (): MemoryService => MemoryService.open({ dir: memoryDir, limits: testLimits(), now: () => '2026-11-06T09:10:00.000Z',
    gate: () => gate })

  beforeEach(() => { gate = { open: false, detail: 'the deployment proves no boundary that keeps a shell out of the memory files' } })

  it('refuses a capture while the deployment proves no boundary, and publishes it once the gate opens', () => {
    const memory = opened()
    expect(memory.submit(memoryInput())).toMatchObject({ status: 'rejected', reason: 'noIsolation' })
    expect(memory.status()).toMatchObject({ version: 0, experiences: 0, writable: false, state: 'readOnly' })
    expect(memory.status().problems.join(' ')).toContain('proves no boundary')
    // Nothing was published, so there is no authoritative record for a shell to have bypassed in the first place.
    expect(readdirSync(join(memoryDir, 'journal')).filter(name => name.endsWith('.ndjson'))
      .map(name => readFileSync(join(memoryDir, 'journal', name), 'utf8')).join('')).toBe('')
    gate = { open: true, detail: 'a test opened it' }
    expect(memory.submit(memoryInput())).toMatchObject({ status: 'created', version: 1 })
    expect(memory.status()).toMatchObject({ writable: true, state: 'ready' })
    memory.close()
  })

  it('answers every read from what it published before the gate closed', () => {
    gate = { open: true, detail: 'a test opened it' }
    const memory = opened()
    const id = memoryInput().id
    expect(memory.submit(memoryInput())).toMatchObject({ status: 'created' })
    gate = { open: false, detail: 'the deployment proves no boundary' }
    // Reads are not gated: the specification refuses writes, not the recall of what was already published.
    expect(memory.recall({ scope: { project: 'acme/widgets' }, cues: ['cache'], allowanceChars: 4000 }).items.map(item => item.id)).toEqual([id])
    expect(memory.list({ scope: {}, offset: 0, limit: 10 }).items.map(item => item.id)).toEqual([id])
    expect(memory.expand({ id, allowanceChars: 4000 })).toMatchObject({ status: 'available' })
    memory.close()
  })

  it('refuses the commits a queued background job holds exactly as it refuses a capture, and moves no version', () => {
    gate = { open: true, detail: 'a test opened it' }
    const memory = opened()
    const input = memoryInput()
    expect(memory.submit(input)).toMatchObject({ status: 'created', version: 1 })
    const record = memory.record(input.id)!
    // A compression job's gist committed while the deployment still writes, so a rollback has one step to take.
    const gist = { jobId: 'job-gated-gist', experienceId: input.id, baseVersion: memory.version,
      text: 'the regression is a stale cache; do not raise the threshold yet', sourceMap: [input.id], version: 'mem-compression-1',
      model: 'deepseek/deepseek-chat', digest: 'e'.repeat(64), at: '2026-11-06T09:10:00.000Z', cited: [input.id] }
    expect(memory.submitCandidate(gist)).toMatchObject({ status: 'created', version: 2 })
    gate = { open: false, detail: 'the deployment proves no boundary that keeps a shell out of the memory files' }
    // The two candidates a background job computed from the version it read, and the operator rollback beside them: all of them
    // commit through the same store as a capture, so all of them refuse with the same answer and none of them moves the version.
    const rule = ruleScoreOf(record.experience, MEMORY_POLICY)
    expect(memory.submitScore({ jobId: 'job-gated-score', experienceId: input.id, baseVersion: memory.version, semantic: 60,
      rule: rule.score, ruleParts: rule.parts, policy: MEMORY_POLICY.version, principles: 'mem-principles-1', model: 'deepseek/deepseek-chat',
      digest: 'd'.repeat(64), rationale: 'a person reported the defect this record is about', cited: [input.id], uncertain: [],
      at: '2026-11-06T09:10:00.000Z' })).toMatchObject({ status: 'rejected', reason: 'noIsolation', version: 2 })
    expect(memory.submitCandidate({ ...gist, jobId: 'job-gated-gist-2', baseVersion: memory.version }))
      .toMatchObject({ status: 'rejected', reason: 'noIsolation', version: 2 })
    expect(memory.rollback(input.id)).toMatchObject({ status: 'noIsolation', id: input.id, version: 2 })
    expect(memory.reclaim()).toMatchObject({ freed: 0, evicted: 0, version: 2 })
    // Nothing was written: no weight, no second gist, no version, and the journal is the two lines the open gate published.
    expect(memory.importance(input.id)).toBeUndefined()
    expect(memory.record(input.id)!.representation.summary?.jobId).toBe('job-gated-gist')
    expect(memory.status()).toMatchObject({ version: 2, experiences: 1, writable: false, state: 'readOnly' })
    expect(readdirSync(join(memoryDir, 'journal')).filter(name => name.endsWith('.ndjson'))
      .map(name => readFileSync(join(memoryDir, 'journal', name), 'utf8')).join('').split('\n').filter(line => line !== '')).toHaveLength(2)
    memory.close()
  })
})

describe('the runtime on the deployment it runs on', () => {
  /** What the main Session's memory read answers: the published experiences it may read, and their count. */
  const listed = async (host: Host) => await host.runTool(host.runtime.masterId, 'orchestrator_read', { resource: 'memory' }) as
    { version: number; total: number; items: { id: string }[] }

  it('refuses the capture on a deployment that proves no boundary, and says so on the memory health entry', async () => {
    const host = await startRuntime(undefined, { machine: { memoryWriteMode: reference('require') } })
    try {
      host.runtime.receive(feishu('1', 'the settings page cache is stale and the regression comes from it'))
      await host.runtime.idle()
      // The reason is on the health entry the panel and the service status read, not in a log an operator has to find.
      expect(host.runtime.health['memory-store']).toMatchObject({ state: 'error' })
      expect(host.runtime.health['memory-store']!.detail).toContain('no DSH permission preset service')
      expect(host.runtime.health['memory-store']!.detail).toContain('refused')
      // Nothing was published, so there is no authoritative record for a shell to have got past in the first place.
      expect(host.runtime.memory.status()).toMatchObject({ writable: false, experiences: 0, version: 0 })
      expect(readdirSync(join(host.directory, 'memory', 'journal')).filter(name => name.endsWith('.ndjson'))
        .map(name => readFileSync(join(host.directory, 'memory', 'journal', name), 'utf8')).join('')).toBe('')
      // The capture is not dropped: it waits in the durable queue for an operator who establishes the boundary or waives it.
      expect(host.runtime.effects.pending('memory')).toBe(true)
      // Reading keeps working, which is all the specification allows on such a deployment.
      expect(await listed(host)).toMatchObject({ total: 0 })
    } finally { await host.stop() }
  })

  it('serves what was already published while it refuses the next capture', async () => {
    const before = MemoryService.open({ dir: join(stateDir, 'memory'), limits: testLimits(), now: () => '2026-11-06T09:10:00.000Z' })
    const id = memoryInput().id
    expect(before.submit(memoryInput())).toMatchObject({ status: 'created' })
    before.close()
    const host = await startRuntime(undefined, { stateDir, machine: { memoryWriteMode: reference('require') } })
    try {
      // The version published before the runtime started is still read, and no new capture joins it.
      expect(await listed(host)).toMatchObject({ version: 1, total: 1, items: [{ id }] })
      host.runtime.receive(feishu('2', 'the export button is broken'))
      await host.runtime.idle()
      expect(await listed(host)).toMatchObject({ version: 1, total: 1 })
      expect(host.runtime.memory.status()).toMatchObject({ writable: false, experiences: 1 })
    } finally { await host.stop() }
  })

  it('writes on a deployment that proves the boundary, with nothing waived', async () => {
    const host = await startRuntime(undefined, { machine: { memoryWriteMode: reference('require') },
      services: { sandbox: { enforcement: 'full' },
        permissionPresets: { set: () => {}, current: () => 'workspace-write', resolve: () => ({ sandbox: 'workspace-write', approval: 'never' }) } } })
    try {
      host.runtime.receive(feishu('1', 'the settings page cache is stale and the regression comes from it'))
      await host.runtime.idle()
      expect(host.runtime.memory.status()).toMatchObject({ writable: true, experiences: 1, version: 1 })
      expect(await listed(host)).toMatchObject({ total: 1 })
      expect(host.runtime.health['memory-store']).toMatchObject({ state: 'ready' })
    } finally { await host.stop() }
  })

  it('writes in the degraded mode the operator waives, and says so on every health report', async () => {
    // The documented operator configuration: a deployment that cannot prove the boundary runs with `memoryWriteMode: waive`,
    // which is the one setting this guide tells an operator to change. Nothing here mounts a sandbox or a confining preset.
    const mode = reference<'waive' | 'require'>('waive')
    const host = await startRuntime(undefined, { machine: { memoryWriteMode: mode } })
    try {
      host.runtime.receive(feishu('1', 'the settings page cache is stale and the regression comes from it'))
      await host.runtime.idle()
      // The memory works end to end under it: captured, published, and readable through the resource the model reads.
      expect(host.runtime.memory.status()).toMatchObject({ writable: true, experiences: 1, version: 1 })
      expect(await listed(host)).toMatchObject({ version: 1, total: 1 })
      // The health entry says both halves at once: the memory writes, and no boundary was proven for it.
      expect(host.runtime.health['memory-store']).toMatchObject({ state: 'ready' })
      expect(host.runtime.health['memory-store']!.detail).toContain('memoryWriteMode waives it')
      expect(host.runtime.health['memory-store']!.detail).toContain('writing without a proven isolation boundary')
      // A second capture reports again: the waiver is the configuration in force, not a one-time admission.
      host.runtime.receive(feishu('2', 'the export button is broken for every viewer'))
      await host.runtime.idle()
      expect(host.runtime.memory.status()).toMatchObject({ writable: true, experiences: 2 })
      expect(host.runtime.health['memory-store']!.detail).toContain('writing without a proven isolation boundary')
      // And it is the setting that admits the write: the same deployment under the shipped default refuses the next capture.
      mode.set('require')
      host.runtime.receive(feishu('3', 'the cache is stale again after the deploy'))
      await host.runtime.idle()
      expect(host.runtime.memory.status()).toMatchObject({ writable: false, experiences: 2 })
      expect(host.runtime.health['memory-store']).toMatchObject({ state: 'error' })
      expect(host.runtime.health['memory-store']!.detail).toContain('refused')
    } finally { await host.stop() }
  })
})

/** Deny this account write access to a directory and its files, or `undefined` on a machine that cannot: it is real or it is not. */
function denyWrites(dir: string): (() => void) | undefined {
  const files = (): string[] => readdirSync(dir, { recursive: true, withFileTypes: true }).filter(entry => entry.isFile())
    .map(entry => join(entry.parentPath, entry.name))
  if (process.platform === 'win32') {
    const account = userInfo().username
    if (spawnSync('icacls', [dir, '/deny', `${account}:(OI)(CI)(W)`], { encoding: 'utf8' }).status !== 0) return undefined
    return () => { spawnSync('icacls', [dir, '/remove:d', account], { encoding: 'utf8' }) }
  }
  try {
    const modes = files().map(path => [path, statSync(path).mode & 0o777] as const)
    for (const [path] of modes) chmodSync(path, 0o444)
    chmodSync(dir, 0o555)
    return () => { for (const [path, mode] of modes) chmodSync(path, mode); chmodSync(dir, 0o755) }
  } catch { return undefined }
}
/** What a second process got when it reached for the published files: one code per attempt, `OK` when the attempt got through. */
function attempts(journal: string, forged: string): Record<string, string> {
  const script = `const fs = require('node:fs'), journal = ${JSON.stringify(journal)}, out = {}
const attempt = (name, run) => { try { run(); out[name] = 'OK' } catch (error) { out[name] = error.code } }
attempt('write', () => fs.writeFileSync(journal, 'FORGED OP\\n'))
attempt('create', () => fs.writeFileSync(journal + '.new', '{}'))
attempt('replace', () => fs.renameSync(${JSON.stringify(forged)}, journal))
attempt('delete', () => fs.unlinkSync(journal))
process.stdout.write(JSON.stringify(out))`
  const result = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8' })
  return JSON.parse(result.stdout) as Record<string, string>
}

describe('a restricted process and the authoritative memory files', () => {
  it('keeps a second process out of the published files on a machine that can deny it, and refuses to write where it cannot', async () => {
    const now = (): string => '2026-11-06T09:10:00.000Z'
    const memory = MemoryService.open({ dir: memoryDir, limits: testLimits(), now, gate: () => ({ open: true, detail: 'a test opened it' }) })
    expect(memory.submit(memoryInput())).toMatchObject({ status: 'created' })
    const journal = join(memoryDir, 'journal', readdirSync(join(memoryDir, 'journal')).find(name => name.endsWith('.ndjson'))!)
    const published = readFileSync(journal, 'utf8')
    const forged = join(home, 'forged-op.txt')
    writeFileSync(forged, 'FORGED OP\n')
    // Release the handle before the restriction: an open handle keeps the access it was granted, which is why an access control
    // entry alone can never be the boundary for a writer that is already running.
    memory.close()
    const restore = denyWrites(memoryDir)
    try {
      if (!restore) {
        // This machine denies no process a directory, so the only outcome it can verify is the product's refusal to write there at
        // all: no proven boundary, no authoritative record to bypass.
        expect(writeGate(testMachine({ memoryWriteMode: reference('require') }), await probeIsolation(host({ presets: presets('danger-full-access', 'never') }))))
          .toMatchObject({ open: false })
        return
      }
      const reached = attempts(journal, forged)
      // The second process is refused every way in: writing over the journal, creating beside it, replacing it by rename, deleting it.
      expect(Object.values(reached).every(code => code === 'EPERM' || code === 'EACCES')).toBe(true)
      // And the same restriction shuts the memory service out too, because it, its shells and this test are one account: an access
      // control entry that keeps a shell out of the journal keeps the writer out of it as well, which is why it cannot be the boundary.
      expect(() => appendFileSync(journal, '')).toThrow()
    } finally { restore?.() }
    // Lifted, the authoritative record is byte for byte what the service published, and the service writes again.
    expect(readFileSync(journal, 'utf8')).toBe(published)
    const again = MemoryService.open({ dir: memoryDir, limits: testLimits(), now })
    expect(again.submit(memoryInput({ primary: 'feishu:oc_team:om_3' }))).toMatchObject({ status: 'created' })
    again.close()
  })
})
