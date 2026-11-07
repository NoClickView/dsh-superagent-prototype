/**
 * The memory's crash matrix, driven on a real temporary filesystem: the process is killed at each point of the publication
 * protocol, and what a restart — and a reader that never stopped — may then see is checked against the version that was
 * acknowledged. A version is either complete or absent, a redelivery of an op the crash already published changes nothing, a
 * capture the Engine committed is never lost, a stale candidate never replaces a newer version, and a reader observes one whole
 * version rather than a mix of two. Durability here is durability across a process crash: NTFS cannot flush a directory entry, so
 * nothing in this file claims that a rename survives power loss. The Runtime boundary itself is `memory-runtime.spec.ts`.
 */
import { appendFileSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, truncateSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { DomainEvent } from '../src/core/ports.ts'
import { Effects } from '../src/app/effects.ts'
import { Store } from '../src/app/store.ts'
import { createMemory, type Memory } from '../src/app/memory.ts'
import { HealthBoard } from '../src/infra/health.ts'
import { MemoryService } from '../src/memory/service.ts'
import { journalNameOf, type MemoryStep } from '../src/memory/store.ts'
import type { MemoryLimits } from '../src/memory/model.ts'
import { memoryInput, testLimits } from './fixtures/memory.ts'
import { testMachine } from './fixtures/deployment.ts'

/** How a test kills the process: the store calls this before each step of the protocol, and throwing here is the death. */
type Interrupt = (step: MemoryStep) => void

/** A memory root in a directory of its own, removed when the test ends. */
function scratch(run: (dir: string) => void): void {
  const home = mkdtempSync(join(tmpdir(), 'memory-crash-'))
  try { run(join(home, 'memory')) } finally { rmSync(home, { recursive: true, force: true }) }
}
/** The service on a directory a test owns, opened exactly as the runtime opens it. */
const open = (dir: string, overrides: Partial<MemoryLimits> = {}, interrupt?: Interrupt): MemoryService =>
  MemoryService.open({ dir, limits: testLimits(overrides), now: () => '2026-11-06T09:10:00.000Z', ...(interrupt ? { interrupt } : {}) })
/** A reader of the same directory: the service opened read-only, serving the last complete version and writing nothing at all. */
const reader = (dir: string, overrides: Partial<MemoryLimits> = {}): MemoryService =>
  MemoryService.open({ dir, limits: testLimits(overrides), now: () => '2026-11-06T09:10:00.000Z', readOnly: true })
/** A hook that dies at the `nth` point named `step` and at every one after it, which is a crash and a file held open alike. */
function dieAt(step: MemoryStep, nth = 1): Interrupt {
  let seen = 0
  return hit => { if (hit === step && ++seen >= nth) throw new Error(`the process died at ${step} #${seen}`) }
}
/** The journal's lines, in the order they were appended: the durable record of what was published. */
const journalLines = (dir: string): string[] => readdirSync(join(dir, 'journal')).filter(name => name.endsWith('.ndjson')).sort()
  .flatMap(name => readFileSync(join(dir, 'journal', name), 'utf8').split('\n').filter(line => line !== ''))
/** Every file under the memory root with its size and hash of content: what a reader is not allowed to change. */
function filesOf(dir: string): Record<string, string> {
  const found: Record<string, string> = {}
  const walk = (path: string): void => {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const target = join(path, entry.name)
      if (entry.isDirectory()) { found[`${target.slice(dir.length)}/`] = ''; walk(target) } else found[target.slice(dir.length)] = readFileSync(target).toString('base64')
    }
  }
  walk(dir)
  return found
}

/** One state directory's two durable domains: the SQLite effect queue, and the memory files beside it. */
interface Domains { readonly store: Store; readonly effects: Effects; readonly memory: Memory; readonly dir: string }
/** Open both domains of one state directory, as the runtime does, and leave the queue stopped so a test says when it runs. */
function domains(home: string): Domains {
  const store = new Store(join(home, 'orchestrator.sqlite'))
  const board = new HealthBoard()
  const effects = new Effects(store, board, () => Date.parse('2026-11-06T09:00:00Z'))
  const memory = createMemory({ machine: testMachine({ stateDir: home }), effects, records: store, position: store, masterId: 'master',
    room: () => 4000, health: board.claim('memory-store'), deliver: async () => {}, project: () => 'acme/widgets' })
  effects.handle('memory', input => memory.store(input), { limit: () => 1 })
  return { store, effects, memory, dir: join(home, 'memory') }
}
/** A business fact whose capture reads nothing from the Store, so a test can commit it in a transaction of its own. */
const policyChanged = (from: string, to: string, at = '2026-11-06T09:00:03.000Z'): DomainEvent =>
  ({ type: 'policy.changed', at, data: { from, to } })
/** The second capture of a test, whose identity and time differ from the first's. */
const second = (primary: string, recordedAt = '2026-11-06T09:00:04.742Z') => memoryInput({ primary, recordedAt })

describe('the memory store under interruption', () => {
  it('drops the append a crash tore, keeps the version it acknowledged, and commits the op on redelivery', () => {
    scratch(dir => {
      const first = open(dir)
      expect(first.submit(memoryInput())).toMatchObject({ status: 'created', version: 1 })
      first.close()
      const two = second('feishu:oc_team:om_2')
      // The write was interrupted: bytes without their newline, which no caller ever saw as a version.
      const crashing = open(dir, {}, step => {
        if (step !== 'journal.sync') return
        const path = join(dir, 'journal', journalNameOf(1))
        truncateSync(path, statSync(path).size - 8)
        throw new Error('the process died mid-append')
      })
      expect(() => crashing.submit(two)).toThrow('died mid-append')
      // The store object died with the process; what it left is what a restart reads.
      const recovered = open(dir)
      try {
        expect(recovered.status()).toMatchObject({ version: 1, seq: 1, experiences: 1, writable: true })
        expect(journalLines(dir)).toHaveLength(1)
        // The queue's redelivery is what makes the loss invisible: it appends the op the crash interrupted, as version 2.
        expect(recovered.submit(two)).toMatchObject({ status: 'created', version: 2 })
        expect(recovered.status()).toMatchObject({ version: 2, experiences: 2 })
      } finally { recovered.close() }
    })
  })

  it('applies a line a crash wrote but never fsynced when it survived whole, and its redelivery changes nothing', () => {
    scratch(dir => {
      const first = open(dir)
      first.submit(memoryInput())
      first.close()
      const two = second('feishu:oc_team:om_2')
      // The process died after the write returned and before the fsync did. The bytes are in the OS's hands: a restart applies
      // them, because a line that is complete is a version, whether or not the fsync that would have confirmed it ever returned.
      const crashing = open(dir, {}, dieAt('journal.sync'))
      expect(() => crashing.submit(two)).toThrow('died at journal.sync')
      const recovered = open(dir)
      try {
        expect(recovered.status()).toMatchObject({ version: 2, seq: 2, experiences: 2, writable: true })
        // The unacknowledged op is durable enough to be replayed, so the queue's redelivery must be a no-op rather than a repeat.
        expect(recovered.submit(two)).toMatchObject({ status: 'duplicate', version: 2 })
        expect(journalLines(dir)).toHaveLength(2)
      } finally { recovered.close() }
    })
  })

  it('writes nothing at all when the crash lands before the journal write, so a reader sees only the version it had', () => {
    scratch(dir => {
      const first = open(dir)
      first.submit(memoryInput())
      first.close()
      const before = journalLines(dir)
      const two = second('feishu:oc_team:om_2')
      let seen: number | undefined
      const crashing = open(dir, {}, step => {
        if (step !== 'journal.write') return
        // A reader of the same files, opened at the instant the writer is about to append: it may not see a version that is
        // neither the one published nor a complete next one.
        seen = reader(dir).version
        throw new Error('died before the write')
      })
      expect(() => crashing.submit(two)).toThrow('died before the write')
      expect(seen).toBe(1)
      // Nothing was written: the journal is byte-identical and the reopened version is the one that was acknowledged.
      expect(journalLines(dir)).toEqual(before)
      const recovered = open(dir)
      try {
        expect(recovered.status()).toMatchObject({ version: 1, experiences: 1, writable: true })
        expect(recovered.submit(two)).toMatchObject({ status: 'created', version: 2 })
      } finally { recovered.close() }
    })
  })

  it('never reads a staging file as a version, and sweeps what a crash left there', () => {
    scratch(dir => {
      const first = open(dir)
      first.submit(memoryInput())
      first.close()
      const before = journalLines(dir)
      // A checkpoint and a manifest a crash wrote to scratch and never renamed: neither has ever been a version.
      writeFileSync(join(dir, 'staging', 'half.tmp'), '{"format":"dsh-superagent-memory/1","seq":9,"version":9,"at":"2026-11-06T10:00:00.000Z"')
      writeFileSync(join(dir, 'staging', 'half-manifest.tmp'), '{"format":"dsh-superagent-memory/1","version":9')
      const recovered = open(dir)
      try {
        expect(recovered.status()).toMatchObject({ version: 1, seq: 1, experiences: 1, writable: true })
        expect(readdirSync(join(dir, 'staging'))).toEqual([])
        expect(journalLines(dir)).toEqual(before)
      } finally { recovered.close() }
    })
  })

  it('ignores a checkpoint a crash renamed in but never named, and recovers the same version without it', () => {
    scratch(dir => {
      const limits = { checkpointOps: 2 }
      const first = open(dir, limits)
      first.submit(memoryInput())
      first.close()
      const two = second('feishu:oc_team:om_2')
      // The checkpoint was renamed into published/series/, and the manifest that would name it was not. This store's protocol
      // names a manifest three times before that: once when it opened, once when the rotation sealed the segment, and once here.
      const crashing = open(dir, limits, dieAt('manifest.write', 3))
      // A derived index that cannot be published does not fail the commit it belongs to: the op was already fsynced.
      expect(crashing.submit(two)).toMatchObject({ status: 'created', version: 2 })
      expect(readdirSync(join(dir, 'published', 'series'))).toEqual(['ck-00000002.json'])
      const manifest = JSON.parse(readFileSync(join(dir, 'published', 'manifest.json'), 'utf8')) as { seq: number; checkpoint?: unknown }
      // The index names no checkpoint at all, so the whole state comes from the journal the unreferenced checkpoint covers.
      expect(manifest).toMatchObject({ seq: 2 })
      expect(manifest.checkpoint).toBeUndefined()
      const recovered = open(dir, limits)
      try {
        expect(recovered.status()).toMatchObject({ version: 2, seq: 2, experiences: 2, writable: true, problems: [] })
        expect(recovered.list({ scope: {}, offset: 0, limit: 10 }).items).toHaveLength(2)
      } finally { recovered.close() }
    })
  })

  it('serves the same version when a crash leaves a segment the checkpoint already covers, and replays it as a no-op', () => {
    scratch(dir => {
      const limits = { checkpointOps: 2 }
      const first = open(dir, limits)
      first.submit(memoryInput())
      const two = second('feishu:oc_team:om_2')
      // The manifest names the checkpoint and the journal segment it covers was not deleted: replay must not apply it twice.
      const crashing = open(dir, limits, dieAt('segment.drop'))
      expect(crashing.submit(two)).toMatchObject({ status: 'created', version: 2 })
      expect(readdirSync(join(dir, 'journal'))).toHaveLength(2)
      expect((JSON.parse(readFileSync(join(dir, 'published', 'manifest.json'), 'utf8')) as { checkpoint?: unknown })
        .checkpoint).toBeDefined()
      const recovered = open(dir, limits)
      const again = open(dir, limits)
      try {
        expect(recovered.status()).toMatchObject({ version: 2, seq: 2, experiences: 2, writable: true })
        expect(again.status()).toMatchObject({ version: 2, seq: 2, experiences: 2 })
        // Two readers of the same files, applied twice each: the same state, to the record.
        expect(again.list({ scope: {}, offset: 0, limit: 10 })).toEqual(recovered.list({ scope: {}, offset: 0, limit: 10 }))
        expect(recovered.submit(two)).toMatchObject({ status: 'duplicate', version: 2 })
      } finally { recovered.close(); again.close() }
    })
  })

  it('deletes a blob whose op never committed, so nothing is recalled from material no version names', () => {
    scratch(dir => {
      const first = open(dir)
      first.close()
      const text = `the regression came from a stale cache entry: ${'detail '.repeat(900)}`
      const crashing = open(dir, {}, dieAt('journal.write'))
      expect(() => crashing.submit(memoryInput({ text }))).toThrow('died at journal.write')
      // The blob was written before the op that references it, which is exactly the orphan a crash leaves behind.
      expect(readdirSync(join(dir, 'raw'))).toHaveLength(1)
      const recovered = open(dir)
      try {
        expect(recovered.status()).toMatchObject({ version: 0, experiences: 0, writable: true })
        expect(readdirSync(join(dir, 'raw'))).toEqual([])
        expect(recovered.list({ scope: {}, offset: 0, limit: 10 }).items).toEqual([])
      } finally { recovered.close() }
    })
  })

  it('writes nothing before it has a validated version, so a crash while opening repeats the same work', () => {
    scratch(dir => {
      const first = open(dir)
      first.submit(memoryInput())
      first.close()
      const before = filesOf(dir)
      // A crash at the first point of the republish: the whole state was replayed and nothing was written back yet.
      const crashing = open(dir, {}, dieAt('recovery.republish'))
      expect(crashing.status().problems.join(' ')).toContain('recovery.republish')
      expect(filesOf(dir)).toEqual(before)
      const recovered = open(dir)
      try {
        expect(recovered.status()).toMatchObject({ version: 1, seq: 1, experiences: 1, writable: true })
        expect(recovered.list({ scope: {}, offset: 0, limit: 1 }).items).toHaveLength(1)
      } finally { recovered.close() }
    })
  })
})

describe('a reader of the memory files while the writer publishes', () => {
  it('sees one complete version at every point of a commit, and never a partial one', () => {
    scratch(dir => {
      const first = open(dir)
      first.submit(memoryInput())
      first.close()
      const two = second('feishu:oc_team:om_2')
      // What a reader of the same files may find, checkpoint by checkpoint: the version before the bytes were written, the
      // version the write left behind (whole, though its fsync never returned), and the version the commit acknowledged.
      const seen: { step: MemoryStep; version: number; items: number }[] = []
      const observe = (step: MemoryStep): void => {
        const held = reader(dir)
        try { seen.push({ step, version: held.version, items: held.list({ scope: {}, offset: 0, limit: 10 }).total }) }
        finally { held.close() }
      }
      const crashing = open(dir, {}, step => {
        if (step === 'journal.write' || step === 'journal.sync') observe(step)
        if (step === 'commit.ack') throw new Error('died before the acknowledgement')
      })
      expect(() => crashing.submit(two)).toThrow('died before the acknowledgement')
      const recovered = open(dir)
      try {
        expect(recovered.status()).toMatchObject({ version: 2, experiences: 2 })
        // Every observation is a whole version with as many records as that version has: 1 before the write, 2 after it (the
        // bytes are in the OS's hands before the fsync that would confirm them), and 2 at the acknowledgement.
        expect(seen.map(item => [item.step, item.version, item.items]))
          .toEqual([['journal.write', 1, 1], ['journal.sync', 2, 2]])
      } finally { recovered.close() }
    })
  })

  it('keeps serving the version it opened while the writer publishes a newer one, and writes nothing', () => {
    scratch(dir => {
      const writer = open(dir)
      writer.submit(memoryInput())
      const held = reader(dir)
      try {
        expect(held.status()).toMatchObject({ version: 1, experiences: 1 })
        const before = held.list({ scope: {}, offset: 0, limit: 10 })
        // The writer publishes while the reader holds its version: the reader's answer may not change, and may not mix.
        const two = second('feishu:oc_team:om_2')
        expect(writer.submit(two)).toMatchObject({ status: 'created', version: 2 })
        expect(held.list({ scope: {}, offset: 0, limit: 10 })).toEqual(before)
        expect(held.status()).toMatchObject({ version: 1, experiences: 1 })
        const fresh = reader(dir)
        try {
          expect(fresh.status()).toMatchObject({ version: 2, experiences: 2 })
          // The newer reader sees both experiences of the new version, and nothing of the version the older reader holds was lost.
          expect(fresh.list({ scope: {}, offset: 0, limit: 10 }).items.map(item => item.id).sort())
            .toEqual([before.items[0]!.id, two.id].sort())
        } finally { fresh.close() }
      } finally { held.close(); writer.close() }
    })
  })

  it('changes no byte of the memory root, not even the torn append it reads past or the scratch a crash left', () => {
    scratch(dir => {
      const writer = open(dir)
      writer.submit(memoryInput())
      writer.close()
      // A torn append and a leftover scratch file: a reader must read past both and touch neither.
      appendFileSync(join(dir, 'journal', journalNameOf(1)), '{"t":"exp.put","seq":2,"version":2,"opId":"half')
      writeFileSync(join(dir, 'staging', 'half.tmp'), 'not a version')
      const before = filesOf(dir)
      const held = reader(dir)
      try {
        expect(held.status()).toMatchObject({ version: 1, experiences: 1, writable: false })
        // A reader refuses to write, and says why: it is not the writer and may not repair anything.
        expect(held.submit(second('feishu:oc_team:om_2'))).toMatchObject({ status: 'rejected', reason: 'readOnly' })
      } finally { held.close() }
      expect(filesOf(dir)).toEqual(before)
      // The writer, opening next, is the one that drops the torn append and empties the scratch.
      const recovered = open(dir)
      try {
        expect(recovered.status()).toMatchObject({ version: 1, experiences: 1, writable: true })
        expect(readdirSync(join(dir, 'staging'))).toEqual([])
      } finally { recovered.close() }
    })
  })

  it('refuses a candidate computed before a crash from replacing the version the restart published', () => {
    scratch(dir => {
      const first = open(dir)
      first.submit(memoryInput())
      first.close()
      // A crash happened while a background job's candidate waited in the queue, and a newer capture published version 2 first.
      const writer = open(dir)
      writer.submit(second('feishu:oc_team:om_2'))
      writer.close()
      const before = journalLines(dir)
      const recovered = open(dir)
      try {
        expect(recovered.status()).toMatchObject({ version: 2, experiences: 2 })
        // The candidate of the job that waited is computed from version 1, which the capture replaced: it is refused by name.
        expect(recovered.submitCandidate({ jobId: 'job-1', experienceId: 'a'.repeat(32), baseVersion: 1, text: 'a gist',
          sourceMap: ['a'.repeat(32)], version: 'mem-compression-1', model: 'deepseek/deepseek-chat', digest: 'a'.repeat(64),
          at: '2026-11-06T09:00:00.000Z', cited: ['a'.repeat(32)] }))
          .toEqual({ status: 'conflict', id: 'a'.repeat(32), baseVersion: 1, version: 2 })
        // Nothing of the stale candidate was applied: no line, no record, no version.
        expect(journalLines(dir)).toEqual(before)
        expect(recovered.status()).toMatchObject({ version: 2, seq: 2, experiences: 2, writable: true })
      } finally { recovered.close() }
    })
  })

  it('never drops a journal segment for a checkpoint the manifest does not name, so a lost rename loses nothing', () => {
    scratch(dir => {
      // Every manifest rename fails, as an indexer that holds manifest.json open would make it: the index is derived data, so the
      // commit it belongs to is still durable, and nothing it would have authorized may be deleted.
      const limits = { checkpointOps: 2, budgetBytes: 96 * 1024 }
      const writer = open(dir, limits, dieAt('manifest.rename'))
      const accepted: string[] = []
      try {
        for (let index = 0; index < 60; index++) {
          const input = memoryInput({ primary: `feishu:oc_team:om_${index}`, text: `the cache note number ${index} `.repeat(24),
            recordedAt: `2026-11-06T09:00:${String(index).padStart(2, '0')}.000Z` })
          const result = writer.submit(input)
          if (result.status === 'created') accepted.push(input.id)
        }
      } finally { writer.close() }
      // The index was never written, so recovery reads the journal alone: every experience the store acknowledged is still there.
      expect(accepted.length).toBeGreaterThan(0)
      const recovered = open(dir, limits)
      try {
        expect(recovered.status().problems.join(' ')).not.toContain('corrupt')
        expect(recovered.status()).toMatchObject({ writable: true })
        expect(recovered.status().experiences).toBe(accepted.length)
        for (const id of accepted) expect(recovered.list({ scope: {}, offset: 0, limit: 100 }).items.map(item => item.id)).toContain(id)
      } finally { recovered.close() }
    })
  })
})

describe('the memory and the queue it is fed from, interrupted between them', () => {
  let home: string | undefined
  afterEach(() => { if (home !== undefined) rmSync(home, { recursive: true, force: true }); home = undefined })
  /** A state directory of this test's own, holding both domains. */
  const stateDir = (): string => home = mkdtempSync(join(tmpdir(), 'memory-domains-'))

  it('remembers nothing when the transaction that captured it rolled back', async () => {
    const opened = domains(stateDir())
    opened.effects.start()
    try {
      const event = policyChanged('mem-policy-1', 'mem-policy-2')
      // A capture runs inside the Engine's transaction: if the command rolls back, the intent to remember rolls back with it.
      expect(() => opened.store.atomic(() => { opened.memory.capture(event); throw new Error('the command failed') }))
        .toThrow('the command failed')
      await opened.effects.idle()
      expect(opened.effects.pending('memory')).toBe(false)
      expect(opened.memory.status()).toMatchObject({ version: 0, experiences: 0 })
      expect(journalLines(opened.dir)).toEqual([])
      // The same capture in a transaction that commits is remembered exactly once, and the row is gone afterwards.
      opened.store.atomic(() => { opened.memory.capture(event) })
      await opened.effects.idle()
      expect(opened.effects.pending('memory')).toBe(false)
      expect(opened.memory.status()).toMatchObject({ version: 1, experiences: 1 })
      expect(journalLines(opened.dir)).toHaveLength(1)
    } finally { opened.memory.close(); await opened.effects.drain(); opened.store.close() }
  })

  it('publishes a capture the queue committed and the files never received, once, when the queue runs again', async () => {
    const dir = stateDir()
    const event = policyChanged('mem-policy-1', 'mem-policy-2')
    const first = domains(dir)
    // The queue row is committed and the memory files never received the op: nothing is dispatched before the process stops.
    first.store.atomic(() => { first.memory.capture(event) })
    expect(first.effects.pending('memory')).toBe(true)
    expect(journalLines(first.dir)).toEqual([])
    first.memory.close(); first.store.close()

    // The restart reopens both domains; the row that outlived the crash is what publishes the experience, and only once.
    const second = domains(dir)
    second.effects.start()
    try {
      await second.effects.idle()
      expect(second.effects.pending('memory')).toBe(false)
      expect(second.memory.status()).toMatchObject({ version: 1, experiences: 1 })
      expect(journalLines(second.dir)).toHaveLength(1)
    } finally { second.memory.close(); await second.effects.drain(); second.store.close() }
  })

  it('adds no second change when a row outlives the op it published, which is the crash between the two domains', async () => {
    const dir = stateDir()
    const opened = domains(dir)
    opened.effects.start()
    try {
      const event = policyChanged('mem-policy-1', 'mem-policy-2')
      opened.store.atomic(() => { opened.memory.capture(event) })
      await opened.effects.idle()
      expect(journalLines(opened.dir)).toHaveLength(1)
      // The op is durable and the row that carried it would have been deleted: the crash landed between the two domains, so the
      // row is still there and the very same event is announced again — the same key and the same payload.
      opened.store.atomic(() => { opened.memory.capture(event) })
      await opened.effects.idle()
      // The redelivery found the experience already published, so the journal holds one line and the version did not move.
      expect(journalLines(opened.dir)).toHaveLength(1)
      expect(opened.memory.status()).toMatchObject({ version: 1, seq: 1, experiences: 1 })
      expect(opened.effects.pending('memory')).toBe(false)
    } finally { opened.memory.close(); await opened.effects.drain(); opened.store.close() }
  })
})
