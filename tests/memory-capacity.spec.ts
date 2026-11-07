/**
 * The bounded archive, on a real temporary directory small enough to fill: what the memory files take is accounted for by class,
 * space is held back for the store's own commit, and reclamation runs in the order the spec fixes 閳?rebuildable cache, then
 * versions nothing reads, then the least-retained originals 閳?through the one writer, so the next recall shows the gist or the
 * cues of what it evicted and never the body it no longer holds. The eviction commit is the dangerous one: a reader observes it
 * mid-pass, a crash lands between the commit and the blob it deletes, and a restart has to come back to exactly the version that
 * was acknowledged. The Runtime boundary is `memory-runtime.spec.ts`; the crash matrix of publication is `memory-crash.spec.ts`.
 */
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createMemory } from '../src/app/memory.ts'
import { Store } from '../src/app/store.ts'
import { HealthBoard } from '../src/infra/health.ts'
import type { ExperienceInput, MemoryLimits } from '../src/memory/model.ts'
import { capacityOf, evictionCandidates, retentionOf, retentionProblems, RETENTION, usableBytes } from '../src/memory/archive.ts'
import { MemoryService } from '../src/memory/service.ts'
import type { MemoryStep } from '../src/memory/store.ts'
import { reference, testMachine } from './fixtures/deployment.ts'
import { memoryInput, testLimits } from './fixtures/memory.ts'

/** How a test kills the process: the store calls this before each step of the protocol, and throwing here is the death. */
type Interrupt = (step: MemoryStep) => void

/** A memory root in a directory of its own, removed when the test ends. */
function scratch(run: (dir: string) => void): void {
  const home = mkdtempSync(join(tmpdir(), 'memory-capacity-'))
  try { run(join(home, 'memory')) } finally { rmSync(home, { recursive: true, force: true }) }
}
/** The service on a directory a test owns, opened exactly as the runtime opens it. */
const open = (dir: string, overrides: Partial<MemoryLimits> = {}, interrupt?: Interrupt): MemoryService =>
  MemoryService.open({ dir, limits: testLimits(overrides), now: () => '2026-11-06T09:10:00.000Z', ...(interrupt ? { interrupt } : {}) })
/** A hook that dies at the `nth` point named `step`, which is a crash at exactly that syscall. */
function dieAt(step: MemoryStep, nth = 1): Interrupt {
  let seen = 0
  return hit => { if (hit === step && ++seen >= nth) throw new Error(`the process died at ${step} #${seen}`) }
}
/** One large original, which the store keeps as a content-addressed blob: the only material reclamation can free. */
const largeText = (topic: string): string => `${topic}: ${'detail '.repeat(1200)}`
/** One original small enough to stay in the journal, which reclamation can never free: the pressure a test fills with. */
const inlineText = (index: number): string => `the cache note number ${index}: ${'entry '.repeat(640)}`
/** The blobs under `raw/`, which are the originals an edition of the store holds on disk. */
const blobs = (dir: string): string[] => readdirSync(join(dir, 'raw'))
/** Bytes of every file directly in one directory of the memory root. */
const bytesIn = (dir: string, path: string): number => {
  const target = join(dir, path)
  return readdirSync(target).reduce((sum, name) => sum + statSync(join(target, name)).size, 0)
}
/** A capture of one large original, whose id the test keeps to ask the store about it. */
const large = (topic: string, recordedAt = '2026-11-06T09:00:03.742Z') =>
  memoryInput({ primary: `feishu:oc_team:${topic}`, recordedAt, text: largeText(topic) })
/**
 * Fill the store with small originals that stay in the journal 閳?material reclamation can never free 閳?until `done` holds or the
 * bound is reached. That is what a real store fills with: facts worth remembering whose bodies are not what the archive is for.
 */
function fillUntil(memory: MemoryService, done: () => boolean, limit = 60): ExperienceInput[] {
  const stored: ExperienceInput[] = []
  for (let index = 0; index < limit && !done(); index++) {
    const input = memoryInput({ primary: `feishu:oc_team:filler-${index}`, text: inlineText(index),
      recordedAt: `2026-11-06T09:${String(index).padStart(2, '0')}:06.742Z` })
    if (memory.submit(input).status === 'created') stored.push(input)
  }
  return stored
}

describe('what the memory files take, and what is held back for its own commit', () => {
  it('reports the reserve it keeps free, the classes it accounts for, and the watermarks it reclaims at', () => {
    scratch(dir => {
      const limits = testLimits({ budgetBytes: 256 * 1024 })
      const memory = open(dir, limits)
      try {
        expect(memory.submit(memoryInput())).toMatchObject({ status: 'created' })
        const status = memory.status(), { usage, capacity } = status
        // Every class of file the ticket names is in the accounting, and the total is their sum rather than a figure of its own.
        expect(usage.total).toBe(usage.raw + usage.summaries + usage.index + usage.journal + usage.history + usage.temporary)
        expect(capacity).toMatchObject({ limit: limits.budgetBytes, retention: expect.any(String) })
        // The reserve is space the store may always spend on its own commit, so a committed version never fills it to the brim.
        expect(capacity.reserve).toBeGreaterThan(0)
        expect(capacity.reserve).toBeLessThan(limits.budgetBytes)
        expect(usage.total + capacity.reserve).toBeLessThanOrEqual(limits.budgetBytes)
        // The watermarks are numbers the policy states, ordered the way reclamation walks them.
        expect(capacity.highWater).toBeGreaterThan(capacity.lowWater)
        expect(capacity.lowWater).toBeGreaterThan(0)
        expect(capacity.highWater).toBeLessThan(1)
        expect(status.state).toBe('ready')
      } finally { memory.close() }
    })
  })

  it('accounts for a cache directory that grows, so no file under the root is silently omitted', () => {
    scratch(dir => {
      const memory = open(dir)
      try {
        const held = memory.status().usage
        expect([held.index, held.history, held.temporary]).toEqual([0, held.history, 0])
        // A rebuildable index, a version nothing reads and the scratch an interrupted commit left: none of them is written by
        // this process, and the accounting still has to see every one, because a directory that grows unwatched is a budget.
        writeFileSync(join(dir, 'index', 'index-00000001.json'), JSON.stringify({ cues: { cache: ['a'.repeat(32)] } }))
        writeFileSync(join(dir, 'published', 'series', 'ck-00000000.json'), JSON.stringify({ format: 'dsh-superagent-memory/1',
          filler: 'x'.repeat(4_000) }))
        writeFileSync(join(dir, 'staging', 'interrupted.tmp'), 'y'.repeat(4_000))
        // The accounting is reconciled by the next commit rather than by a guess: the point is that the walk finds them, not that
        // this process remembers writing them.
        memory.submit(memoryInput({ primary: 'feishu:oc_team:om_2', recordedAt: '2026-11-06T09:00:04.742Z' }))
        const after = memory.status().usage
        expect(after.index).toBeGreaterThanOrEqual(bytesIn(dir, 'index'))
        expect(after.temporary).toBeGreaterThanOrEqual(bytesIn(dir, 'staging'))
        expect(after.history).toBeGreaterThanOrEqual(bytesIn(dir, 'published/series'))
        expect(after.total).toBe(after.raw + after.summaries + after.index + after.journal + after.history + after.temporary)
      } finally { memory.close() }
    })
  })
})

describe('the order reclamation walks, and what it chooses', () => {
  it('frees the rebuildable cache before it drops one original, and drops none when the cache is enough', () => {
    const home = mkdtempSync(join(tmpdir(), 'memory-capacity-'))
    const dir = join(home, 'memory')
    // A derived index an earlier version left behind, counted before anything is written: it is a cache by contract, so its loss
    // costs a rebuild and never a record.
    mkdirSync(join(dir, 'index'), { recursive: true })
    writeFileSync(join(dir, 'index', 'index-00000040.json'), JSON.stringify({ cues: { cache: ['a'.repeat(60_000)] } }))
    const limits = testLimits({ budgetBytes: 256 * 1024 })
    const memory = open(dir, limits), accepted: string[] = []
    try {
      expect(memory.status().usage.index).toBeGreaterThan(0)
      // Fill with originals until the store is pressurised: the pass that runs then has a cache it can free, and freeing it is
      // enough to reach the low watermark, so no original is worth dropping yet.
      for (let index = 0; index < 40 && memory.status().capacity.reclaimed.caches === 0; index++) {
        const input = large(`note-${index}`, `2026-11-06T09:${String(index).padStart(2, '0')}:03.742Z`)
        if (memory.submit(input).status === 'created') accepted.push(input.id)
      }
      const { capacity, usage } = memory.status()
      expect(capacity.reclaimed.caches).toBe(1)
      // Cache first, originals not at all: nothing was released while a rebuildable file could pay for the pressure.
      expect(capacity.reclaimed.originals).toBe(0)
      expect(memory.status().state).toBe('ready')
      expect(usage.index).toBe(0)
      expect(readdirSync(join(dir, 'index'))).toEqual([])
      // Every original the store accepted is still readable, and the pass wrote no record it did not have to.
      expect(accepted.length).toBeGreaterThan(0)
      for (const id of accepted) expect(memory.expand({ id, allowanceChars: 100_000 }).status).toBe('available')
    } finally { memory.close(); rmSync(home, { recursive: true, force: true }) }
  })

  it('frees a version nothing reads before it drops one original', () => {
    const home = mkdtempSync(join(tmpdir(), 'memory-capacity-'))
    const dir = join(home, 'memory')
    // Three checkpoints no manifest names 閳?what a store keeps after a crash during a checkpoint and a write that never republished
    // its index. Nothing may be read from them, so reclamation keeps the newest two and frees the rest.
    for (const seq of [1, 2, 3]) {
      mkdirSync(join(dir, 'published', 'series'), { recursive: true })
      writeFileSync(join(dir, 'published', 'series', `ck-${String(seq).padStart(8, '0')}.json`),
        JSON.stringify({ format: 'dsh-superagent-memory/1', filler: 'x'.repeat(40_000) }))
    }
    const limits = testLimits({ budgetBytes: 256 * 1024 })
    const memory = open(dir, limits), accepted: string[] = []
    try {
      expect(memory.status().usage.history).toBeGreaterThan(0)
      for (let index = 0; index < 40 && memory.status().capacity.reclaimed.versions === 0; index++) {
        const input = memoryInput({ primary: `feishu:oc_team:inline-${index}`, text: inlineText(index),
          recordedAt: `2026-11-06T09:${String(index).padStart(2, '0')}:04.742Z` })
        if (memory.submit(input).status === 'created') accepted.push(input.id)
      }
      const { capacity } = memory.status()
      expect(capacity.reclaimed.versions).toBeGreaterThan(0)
      // Versions before originals: the cheaper class paid for the pressure, and no original was released.
      expect(capacity.reclaimed.originals).toBe(0)
      expect(memory.status().state).toBe('ready')
      expect(readdirSync(join(dir, 'published', 'series')).length).toBeLessThanOrEqual(3)
    } finally { memory.close(); rmSync(home, { recursive: true, force: true }) }
  })

  it('releases the original whose gist survives it before one whose text is all that is left', () => {
    scratch(dir => {
      // One block of the budget is one original here: releasing one of the two frees more than the pass needs, so exactly one goes.
      const limits = testLimits({ budgetBytes: 128 * 1024 })
      const memory = open(dir, limits)
      try {
        // Two originals of the same weight and the same instant: only the shorter rendering one of them kept can order them.
        const gisted = memoryInput({ primary: 'feishu:oc_team:gisted', occurredAt: '2026-11-01T09:00:00.000Z',
          recordedAt: '2026-11-06T09:00:03.742Z', text: `gisted: ${'detail '.repeat(4600) + ' end-of-body'}` })
        const plain = memoryInput({ primary: 'feishu:oc_team:plain', occurredAt: '2026-11-01T09:00:00.000Z',
          recordedAt: '2026-11-06T09:00:04.742Z', text: `plain: ${'detail '.repeat(4600) + ' end-of-body'}` })
        expect(memory.submit(gisted)).toMatchObject({ status: 'created' })
        expect(memory.submit(plain)).toMatchObject({ status: 'created' })
        const version = memory.status().version
        expect(memory.submitCandidate({ jobId: 'job-gisted', experienceId: gisted.id, baseVersion: version,
          text: 'the gisted note says the regression came from a stale cache entry', sourceMap: [gisted.id],
          version: 'mem-compression-1', model: 'deepseek/deepseek-chat', digest: 'a'.repeat(64),
          at: '2026-11-06T09:05:00.000Z', cited: [gisted.id] })).toMatchObject({ status: 'created' })
        // Fill with small originals kept in the journal until the store is pressurised, then stop at the first release.
        for (let index = 0; index < 40; index++) {
          const held = memory.record(gisted.id)! 
          if (!held.representation.detail.available || !memory.record(plain.id)!.representation.detail.available) break
          const input = memoryInput({ primary: `feishu:oc_team:filler-${index}`, text: inlineText(index),
            recordedAt: `2026-11-06T09:${String(index).padStart(2, '0')}:05.742Z` })
          memory.submit(input)
        }
        // The one a reader can still recall as its gist went first; the one with nothing shorter to stand in for it is still there.
        expect(memory.record(gisted.id)!.representation.detail.available).toBe(false)
        expect(memory.record(plain.id)!.representation.detail.available).toBe(true)
        expect(memory.expand({ id: plain.id, allowanceChars: 100_000 })).toMatchObject({ status: 'available' })
      } finally { memory.close() }
    })
  })
})

describe('what a reader sees once an original has been released', () => {
  it('answers with the gist and the cues, never with the body, and says when the text stopped being stored', () => {
    scratch(dir => {
      const memory = open(dir, testLimits({ budgetBytes: 128 * 1024 }))
      const gisted = memoryInput({ primary: 'feishu:oc_team:regression', occurredAt: '2026-11-01T09:00:00.000Z',
        recordedAt: '2026-11-06T09:00:03.742Z', text: `regression: ${'detail '.repeat(4600) + ' end-of-body'}` })
      const bare = memoryInput({ primary: 'feishu:oc_team:threshold', occurredAt: '2026-11-01T09:00:00.000Z',
        recordedAt: '2026-11-06T09:00:04.742Z', text: `threshold: ${'detail '.repeat(4600) + ' end-of-body'}` })
      try {
        memory.submit(gisted)
        memory.submit(bare)
        const gistedVersion = memory.status().version
        expect(memory.submitCandidate({ jobId: 'job-regression', experienceId: gisted.id, baseVersion: gistedVersion,
          text: 'the regression was the stale cache entry', sourceMap: [gisted.id], version: 'mem-compression-1',
          model: 'deepseek/deepseek-chat', digest: 'a'.repeat(64), at: '2026-11-06T09:05:00.000Z',
          cited: [gisted.id] })).toMatchObject({ status: 'created' })
        fillUntil(memory, () => !memory.record(gisted.id)!.representation.detail.available)
        // What a reader is left with is what the record kept, and nothing invented.
        expect(memory.record(gisted.id)!.representation.detail.available).toBe(false)
        const expanded = memory.expand({ id: gisted.id, allowanceChars: 100_000 })
        expect(expanded).toMatchObject({ status: 'evicted', evictedAt: '2026-11-06T09:10:00.000Z', evictedBy: 'mem-retention-1',
          summary: { text: 'the regression was the stale cache entry' } })
        // Not one character of the released body: the head the record always kept is not the body, and the tail proves which is read.
        expect(JSON.stringify(expanded)).not.toContain('end-of-body')
        // The gist is what recall shows, labelled as one: the body the store released never comes back through recall.
        const recalled = memory.recall({ scope: {}, cues: ['regression'], allowanceChars: 4000 })
        expect(recalled.text).toContain('[summary] the regression was the stale cache entry')
        // And the line says the original is gone, so a reader is never left thinking the text is merely unasked for.
        expect(recalled.text).toContain('[original no longer stored]')
        expect(recalled.text).not.toContain('end-of-body')
        expect(recalled.items[0]).toMatchObject({ id: gisted.id, summarised: true, readable: false })
        // A record with nothing shorter to stand in for it says only what is left rather than presenting an empty body.
        if (!memory.record(bare.id)!.representation.detail.available) {
          expect(memory.recall({ scope: {}, cues: ['threshold'], allowanceChars: 4000 }).text)
            .toContain('only its retrieval cues remain')
        }
        expect(memory.list({ scope: {}, offset: 0, limit: 10 }).items.find(item => item.id === gisted.id))
          .toMatchObject({ readable: false, summary: { version: 'mem-compression-1' } })
      } finally { memory.close() }
      // And after a restart the same release is what the replayed version says: nothing re-materialises the text.
      const reopened = open(dir, testLimits({ budgetBytes: 128 * 1024 }))
      try {
        expect(reopened.expand({ id: gisted.id, allowanceChars: 100_000 })).toMatchObject({ status: 'evicted' })
        expect(reopened.recall({ scope: {}, cues: ['regression'], allowanceChars: 4000 }).text).not.toContain('end-of-body')
      } finally { reopened.close() }
    })
  })
})

describe('a reclamation pass a crash interrupted', () => {
  it('finishes the release a crash left half done: the version is intact and the orphan blob is swept', () => {
    scratch(dir => {
      const limits = testLimits({ budgetBytes: 128 * 1024 })
      const writer = open(dir, limits)
      const big = memoryInput({ primary: 'feishu:oc_team:orphan', occurredAt: '2026-11-01T09:00:00.000Z',
        recordedAt: '2026-11-06T09:00:03.742Z', text: `orphan: ${'detail '.repeat(4600) + ' end-of-body'}` })
      writer.submit(big)
      // Filled below the pressure point, so the next capture is what starts the pass.
      fillUntil(writer, () => false, 4)
      const version = writer.status().version
      writer.close()
      // A store that dies exactly after the op that disowned the original was fsynced, and before the blob was deleted.
      const crashing = open(dir, limits, dieAt('blob.drop'))
      expect(() => fillUntil(crashing, () => false, 20)).toThrow('died at blob.drop')
      // The commit is durable, so the restart already knows the detail is gone; the bytes it left behind are collected.
      const recovered = open(dir, limits)
      try {
        expect(recovered.status().writable).toBe(true)
        expect(recovered.status().problems).toEqual([])
        expect(recovered.version).toBeGreaterThanOrEqual(version)
        expect(recovered.record(big.id)!.representation.detail.available).toBe(false)
        expect(recovered.expand({ id: big.id, allowanceChars: 100_000 })).toMatchObject({ status: 'evicted' })
        expect(blobs(dir)).toEqual([])
        // Nothing the store acknowledged is missing: every filler it accepted is still listed.
        expect(recovered.list({ scope: {}, offset: 0, limit: 50 }).total).toBe(recovered.status().experiences)
      } finally { recovered.close() }
    })
  })

  it('leaves the original readable when the crash lands before the op that disowns it', () => {
    scratch(dir => {
      const limits = testLimits({ budgetBytes: 128 * 1024 })
      const writer = open(dir, limits)
      const big = memoryInput({ primary: 'feishu:oc_team:survivor', occurredAt: '2026-11-01T09:00:00.000Z',
        recordedAt: '2026-11-06T09:00:03.742Z', text: `survivor: ${'detail '.repeat(4600) + ' end-of-body'}` })
      writer.submit(big)
      fillUntil(writer, () => false, 4)
      const version = writer.status().version
      writer.close()
      // The first journal write this store makes is the op of the reclamation it starts, and it never lands.
      const crashing = open(dir, limits, dieAt('journal.write'))
      expect(() => fillUntil(crashing, () => false, 20)).toThrow('died at journal.write')
      const recovered = open(dir, limits)
      try {
        expect(recovered.version).toBe(version)
        expect(recovered.record(big.id)!.representation.detail.available).toBe(true)
        expect(recovered.expand({ id: big.id, allowanceChars: 100_000 })).toMatchObject({ status: 'available' })
        expect(blobs(dir)).toHaveLength(1)
      } finally { recovered.close() }
    })
  })
})

describe('a reader of the memory files while reclamation runs', () => {
  it('never returns text that has been released, and changes no byte of what it reads', () => {
    scratch(dir => {
      const limits = testLimits({ budgetBytes: 128 * 1024 })
      const writer = open(dir, limits)
      const big = memoryInput({ primary: 'feishu:oc_team:held', occurredAt: '2026-11-01T09:00:00.000Z',
        recordedAt: '2026-11-06T09:00:03.742Z', text: `held: ${'detail '.repeat(4600) + ' end-of-body'}` })
      writer.submit(big)
      fillUntil(writer, () => false, 4)
      // A reader opened before the release: its version says the text is there, and the file is gone the moment it is asked for.
      const held = MemoryService.open({ dir, limits, now: () => '2026-11-06T09:10:00.000Z', readOnly: true })
      try {
        expect(held.record(big.id)!.representation.detail.available).toBe(true)
        fillUntil(writer, () => !writer.record(big.id)!.representation.detail.available)
        expect(writer.record(big.id)!.representation.detail.available).toBe(false)
        // The honest answer, not the text and not an invention: the store does not hold what the reader's version names.
        expect(held.expand({ id: big.id, allowanceChars: 100_000 })).toMatchObject({ status: 'evicted' })
        // What recall may still show is the head the record kept — data that was stored in the record, not in the released blob —
        // and never the body: the marker at its end is the proof of which of the two a reader is reading.
        expect(held.recall({ scope: {}, cues: ['held'], allowanceChars: 4000 }).text).not.toContain('end-of-body')
        // The reader wrote nothing: the writer's release is still exactly the version it committed.
        expect(held.version).toBe(held.status().version)
      } finally { held.close(); writer.close() }
    })
  })
})

describe('a store with nothing left to reclaim', () => {
  it('back-pressures instead of growing, keeps what it published, and stops admitting new large originals', () => {
    scratch(dir => {
      const limits = testLimits({ budgetBytes: 96 * 1024 })
      const memory = open(dir, limits), accepted: string[] = []
      try {
        for (let index = 0; index < 60; index++) {
          const input = memoryInput({ primary: `feishu:oc_team:full-${index}`, text: inlineText(index),
            recordedAt: `2026-11-06T09:${String(index % 60).padStart(2, '0')}:07.742Z` })
          const result = memory.submit(input)
          if (result.status === 'created') accepted.push(input.id)
        }
        const status = memory.status()
        expect(accepted.length).toBeGreaterThan(0)
        expect(accepted.length).toBeLessThan(60)
        // Nothing to free: no candidate, and the state says so rather than pretending there is room.
        expect(status.capacity.candidates).toBe(0)
        expect(status.state === 'overHighWater' || status.state === 'full').toBe(true)
        expect(status.capacity.reclaimed.originals).toBe(0)
        // The hard cap is never breached implicitly, and everything already published is still readable.
        expect(status.usage.total).toBeLessThanOrEqual(limits.budgetBytes)
        for (const id of accepted) expect(memory.expand({ id, allowanceChars: 100_000 }).status).toBe('available')
        // A large original offered to a full store is not admitted as a blob: the fact is kept, its body is not stored.
        const large = memoryInput({ primary: 'feishu:oc_team:late', recordedAt: '2026-11-06T09:59:00.000Z',
          text: `late: ${'detail '.repeat(4600) + ' end-of-body'}` })
        const result = memory.submit(large)
        expect(result.status === 'backpressured' || result.status === 'created').toBe(true)
        expect(blobs(dir)).toEqual([])
        if (result.status === 'created') {
          expect(memory.record(large.id)!.experience.material).toMatchObject({ form: 'truncated' })
          expect(memory.expand({ id: large.id, allowanceChars: 100_000 })).toMatchObject({ status: 'available', truncated: true })
        }
      } finally { memory.close() }
    })
  })

  it('writes nothing on a second pass, and leaves the original of a forgotten experience alone while there is room', () => {
    scratch(dir => {
      const memory = open(dir)
      try {
        // An experience far enough in the past to have left routine recall: forgotten is about candidacy, not about deletion. The
        // age is the policy's own horizon rather than a round number — ten years halves a weight, so this one is thirty years old.
        const old = memoryInput({ primary: 'feishu:oc_team:old', occurredAt: '1996-01-01T09:00:00.000Z',
          recordedAt: '2026-11-06T09:00:03.742Z', text: `old: ${'detail '.repeat(4600) + ' end-of-body'}` })
        memory.submit(old)
        expect(memory.granularity(old.id)).toBe('forgotten')
        expect(memory.recall({ scope: {}, cues: ['old'], allowanceChars: 4000 }).items).toEqual([])
        // Nothing is under pressure, so no pass runs, and the forgetting threshold deleted nothing by itself.
        const before = memory.status()
        const first = memory.reclaim()
        expect(first).toMatchObject({ state: 'ready', freed: 0, evicted: 0, version: before.version })
        expect(before.capacity.reclaimed).toEqual({ caches: 0, versions: 0, originals: 0, bytes: 0 })
        expect(memory.expand({ id: old.id, allowanceChars: 100_000 })).toMatchObject({ status: 'available' })
        // A second pass over the same version changes no byte at all.
        expect(memory.reclaim()).toMatchObject({ freed: 0, evicted: 0, version: before.version })
        expect(memory.status().version).toBe(before.version)
      } finally { memory.close() }
    })
  })
})

describe('the retention policy reclamation ranks an original by', () => {
  it('is one number over the weight and the gist, ordered and refused the way the other policies are', () => {
    scratch(dir => {
      const memory = open(dir)
      try {
        const gisted = memoryInput({ primary: 'feishu:oc_team:policy-gisted', text: `a: ${'detail '.repeat(4600)}` })
        const plain = memoryInput({ primary: 'feishu:oc_team:policy-plain', recordedAt: '2026-11-06T09:00:04.742Z',
          text: `b: ${'detail '.repeat(4600)}` })
        memory.submit(gisted)
        memory.submit(plain)
        expect(memory.submitCandidate({ jobId: 'job-policy', experienceId: gisted.id, baseVersion: memory.status().version,
          text: 'the gisted note says the regression came from a stale cache entry', sourceMap: [gisted.id],
          version: 'mem-compression-1', model: 'deepseek/deepseek-chat', digest: 'a'.repeat(64),
          at: '2026-11-06T09:05:00.000Z', cited: [gisted.id] })).toMatchObject({ status: 'created' })
        const weight = (): number => 60
        const gist = memory.record(gisted.id)!, text = memory.record(plain.id)!
        // One continuous number, not two classes: a reader can read back why one original went before the other.
        expect(retentionOf(gist, weight, RETENTION)).toBeLessThan(retentionOf(text, weight, RETENTION))
        expect(retentionOf(text, weight, RETENTION)).toBeLessThanOrEqual(100)
        // The order a pass walks is that number, and the bytes it frees break a tie so a pass frees as much as it costs.
        expect(evictionCandidates([text, gist], { policy: RETENTION, weightOf: weight }).map(candidate => candidate.id))
          .toEqual([gisted.id, plain.id])
        // Nothing is protected: a weight that would not be dropped last is only ordered last, and the same policy still lists it.
        expect(evictionCandidates([text], { policy: { ...RETENTION, maxEvictions: 1 }, weightOf: weight })).toHaveLength(1)
        expect(evictionCandidates([text], { policy: { ...RETENTION, minEvictBytes: 64 * 1024 }, weightOf: weight })).toEqual([])
      } finally { memory.close() }
    })
    // A policy that cannot rank is refused where a score policy is, rather than filling a store without ever freeing it.
    expect(retentionProblems(RETENTION)).toEqual([])
    expect(retentionProblems({ ...RETENTION, weight: { standing: -1, detail: 1 } })).toContain('negativeCoefficient')
    expect(retentionProblems({ ...RETENTION, weight: { standing: 0, detail: 0 } })).toContain('noPositiveCoefficient')
    expect(retentionProblems({ ...RETENTION, water: { high: 0.5, low: 0.9 } })).toContain('crossedWater')
    expect(retentionProblems({ ...RETENTION, water: { high: 1.4, low: 0.2 } })).toContain('waterOutOfRange')
    expect(retentionProblems({ ...RETENTION, minEvictBytes: -1 })).toContain('negativeMinEvict')
    expect(retentionProblems({ ...RETENTION, maxEvictions: 0 })).toContain('impossibleEvictions')
    // The watermarks are shares of what content may use, so a store that crossed one is still able to write.
    const budget = { limit: 100_000, reserve: 1_000 }
    expect(capacityOf({ raw: 0, summaries: 0, index: 0, journal: 0, history: 0, temporary: 0, total: 0 }, budget, RETENTION)).toBe('ready')
    expect(capacityOf({ raw: 0, summaries: 0, index: 0, journal: 0, history: 0, temporary: 0, total: Math.ceil(usableBytes(budget) * 0.95) },
      budget, RETENTION)).toBe('overHighWater')
    expect(capacityOf({ raw: 0, summaries: 0, index: 0, journal: 0, history: 0, temporary: 0, total: usableBytes(budget) },
      budget, RETENTION)).toBe('full')
  })
})

describe('a cache that disagrees with the version', () => {
  it('never hands a reader a released body out of it, and is deleted the next time space is freed', () => {
    scratch(dir => {
      const limits = testLimits({ budgetBytes: 128 * 1024 })
      const memory = open(dir, limits)
      const held = memoryInput({ primary: 'feishu:oc_team:cached', occurredAt: '2026-11-01T09:00:00.000Z',
        recordedAt: '2026-11-06T09:00:03.742Z', text: `cached: ${'detail '.repeat(4600) + ' end-of-body'}` })
      try {
        memory.submit(held)
        fillUntil(memory, () => !memory.record(held.id)!.representation.detail.available)
        expect(memory.record(held.id)!.representation.detail.available).toBe(false)
        // A cache built before the release, still naming the original as readable and still carrying its body: exactly what a stale
        // index is. It is derived data with no authority, so it may not answer a read the version answers differently.
        writeFileSync(join(dir, 'index', 'index-00000009.json'),
          JSON.stringify({ record: memory.record(held.id), text: `${'detail '.repeat(4600)} end-of-body` }))
        expect(memory.expand({ id: held.id, allowanceChars: 100_000 })).toMatchObject({ status: 'evicted' })
        expect(memory.recall({ scope: {}, cues: ['cached'], allowanceChars: 4000 }).text).not.toContain('end-of-body')
        // Pressure again, and the cache is the first thing freed: a rebuildable file survives no pass.
        fillUntil(memory, () => readdirSync(join(dir, 'index')).length === 0, 60)
        expect(readdirSync(join(dir, 'index'))).toEqual([])
        expect(memory.expand({ id: held.id, allowanceChars: 100_000 })).toMatchObject({ status: 'evicted' })
      } finally { memory.close() }
      // A restart replays the journal and never consults the cache: the same answer either way.
      const reopened = open(dir, limits)
      try {
        expect(reopened.expand({ id: held.id, allowanceChars: 100_000 })).toMatchObject({ status: 'evicted' })
        expect(reopened.recall({ scope: {}, cues: ['cached'], allowanceChars: 4000 }).text).not.toContain('end-of-body')
      } finally { reopened.close() }
    })
  })
})

describe('the composition the runtime builds', () => {
  it('names the capacity it is under on the memory health entry, and releases an original through the same read path', async () => {
    const home = mkdtempSync(join(tmpdir(), 'memory-composed-'))
    const board = new HealthBoard()
    const store = new Store(join(home, 'orchestrator.sqlite'))
    const memory = createMemory({ machine: testMachine({ stateDir: home, memoryBudgetBytes: reference(128 * 1024) }),
      effects: { enqueue: () => undefined, occupancy: () => ({ items: 0, bytes: 0, held: false }), released: () => () => {} },
      records: store, position: store, masterId: 'master',
      room: () => 4000, health: board.claim('memory-store'), deliver: async () => {}, project: () => 'acme/widgets' })
    /** Hand one capture to the composition, as the durable effect does: a full store answers `Later`, which health already says. */
    const feed = async (input: ExperienceInput): Promise<void> => {
      try { await memory.store(input) } catch { /* The store is full; the health entry is what reports it. */ }
    }
    try {
      const large = (topic: string, minute: number) => memoryInput({ primary: `feishu:oc_team:${topic}`,
        occurredAt: '2026-11-01T09:00:00.000Z', recordedAt: `2026-11-06T09:${String(minute).padStart(2, '0')}:03.742Z`,
        text: `${topic}: ${'detail '.repeat(4600) + ' end-of-body'}` })
      const first = large('composed-a', 1), second = large('composed-b', 2)
      await feed(first)
      await feed(second)
      for (let index = 0; index < 40 && memory.status().capacity.reclaimed.originals === 0; index++) {
        await feed(memoryInput({ primary: `feishu:oc_team:composed-filler-${index}`, text: inlineText(index),
          recordedAt: `2026-11-06T09:${String(index).padStart(2, '0')}:08.742Z` }))
      }
      // The pass released an original, and the composition's own health entry says what the store is under and what is left.
      expect(memory.status().capacity.reclaimed.originals).toBeGreaterThan(0)
      const health = board.all['memory-store']!
      expect(health.detail).toContain('capacity ')
      expect(health.detail).toMatch(/capacity (ready|overHighWater|full)/)
      expect(health.detail).toContain('bytes reserved')
      // What the release did is visible through the same read path a model would use, and never as invented text.
      const results = [first.id, second.id].map(id => memory.expand(undefined, id, 100_000))
      const released = results.filter(result => result.status === 'evicted')
      expect(released).toHaveLength(1)
      expect(JSON.stringify(released)).not.toContain('end-of-body')
      // The archive's one door, which ticket 10's scheduler calls on a clock of its own.
      const reclaimed = memory.reclaim()
      expect(reclaimed.version).toBeGreaterThan(0)
      expect(board.all['memory-store']!.state).not.toBe('error')
    } finally { memory.close(); store.close(); rmSync(home, { recursive: true, force: true }) }
  })
})

describe("two experiences that quote the same long text", () => {
  it('releases their shared original by releasing both, and never leaves one to name a blob that is gone', () => {
    scratch(dir => {
      // A blob is content addressed: the same text is one file, so one release alone would free nothing and deleting the file under
      // the other would take an original the policy did not rank. They are one candidate, released together or not at all.
      const text = `shared: ${'detail '.repeat(4600) + ' end-of-body'}`
      const memory = open(dir, testLimits({ budgetBytes: 128 * 1024 }))
      try {
        const quoting = memoryInput({ primary: 'feishu:oc_team:quote-a', occurredAt: '2026-11-01T09:00:00.000Z',
          recordedAt: '2026-11-06T09:00:03.742Z', text })
        const repeated = memoryInput({ primary: 'feishu:oc_team:quote-b', occurredAt: '2026-11-01T09:00:00.000Z',
          recordedAt: '2026-11-06T09:00:04.742Z', text })
        memory.submit(quoting)
        memory.submit(repeated)
        expect(blobs(dir)).toHaveLength(1)
        const both = (): boolean[] => [quoting.id, repeated.id].map(id => memory.record(id)!.representation.detail.available)
        fillUntil(memory, () => !both()[0] || !both()[1])
        // The two agree: one file cannot be half released, and no record may claim a text the store no longer holds.
        expect(both()).toEqual([false, false])
        expect(blobs(dir)).toEqual([])
        for (const id of [quoting.id, repeated.id]) {
          expect(memory.expand({ id, allowanceChars: 100_000 })).toMatchObject({ status: 'evicted' })
        }
        expect(JSON.stringify(memory.expand({ id: quoting.id, allowanceChars: 100_000 }))).not.toContain('end-of-body')
        // One file freed once, so what the store reports is the space it got back rather than two releases of the same bytes.
        expect(memory.status().capacity.reclaimed).toMatchObject({ originals: 1, bytes: 32 * 1024 })
      } finally { memory.close() }
    })
  })
})

