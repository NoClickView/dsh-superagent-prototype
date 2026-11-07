/**
 * The memory store's own invariants on real files, in a real temporary directory: a version is complete or absent, replay of the
 * journal yields the same identity and content, a duplicate delivery changes nothing, a torn tail costs a redelivery, a corrupt line
 * costs a write but never a record, and a full store back-pressures instead of growing without bound. The acceptance path itself is
 * `memory-runtime.spec.ts`; the retrieval rules are `memory-recall.spec.ts`.
 */
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { MemoryService } from '../src/memory/service.ts'
import { journalNameOf } from '../src/memory/store.ts'
import type { MemoryLimits } from '../src/memory/model.ts'
import { memoryInput, testLimits } from './fixtures/memory.ts'

/** A memory root in a directory of its own, the service opened on it, and both removed afterwards. */
function withStore(run: (memory: MemoryService, dir: string) => void, limits: MemoryLimits = testLimits()): void {
  const home = mkdtempSync(join(tmpdir(), 'memory-store-')), dir = join(home, 'memory')
  const memory = open(dir, limits)
  try { run(memory, dir) } finally { memory.close(); rmSync(home, { recursive: true, force: true }) }
}
/** The service on a directory a test owns, opened as the runtime opens it. */
const open = (dir: string, limits: MemoryLimits = testLimits()): MemoryService =>
  MemoryService.open({ dir, limits, now: () => '2026-11-06T09:10:00.000Z' })
/** The journal's lines, in the order they were appended. */
const journalLines = (dir: string): string[] => readdirSync(join(dir, 'journal')).filter(name => name.endsWith('.ndjson')).sort()
  .flatMap(name => readFileSync(join(dir, 'journal', name), 'utf8').split('\n').filter(line => line !== ''))
/** A directory of this test's own, removed when the test ends. */
function scratch(run: (dir: string) => void): void {
  const home = mkdtempSync(join(tmpdir(), 'memory-store-'))
  try { run(join(home, 'memory')) } finally { rmSync(home, { recursive: true, force: true }) }
}

describe('the memory store', () => {
  it('writes one experience through the service and reopens it with the same identity, version and text', () => {
    withStore((memory, dir) => {
      const input = memoryInput()
      expect(memory.submit(input)).toEqual({ status: 'created', id: input.id, version: 1 })
      expect(memory.status()).toMatchObject({ version: 1, seq: 1, experiences: 1, writable: true })
      // The commit point is a journal line: one op, naming the version a reader may identify.
      expect(journalLines(dir)).toEqual([expect.stringContaining('"version":1')])
      memory.close()
      const reopened = open(dir)
      try {
        expect(reopened.status()).toMatchObject({ version: 1, seq: 1, experiences: 1, writable: true })
        const [item] = reopened.list({ scope: {}, offset: 0, limit: 10 }).items
        expect(item).toMatchObject({ id: input.id, at: input.occurredAt, source: 'feishu:oc_team', kind: 'observation' })
        expect(item!.preview).toContain('stale cache')
        expect(reopened.expand({ id: input.id, allowanceChars: 4000 })).toMatchObject({ status: 'available', text: input.material.text })
      } finally { reopened.close() }
    })
  })

  it('applies a redelivered capture once, also when the redelivery comes after a restart', () => {
    withStore((memory, dir) => {
      const input = memoryInput()
      expect(memory.submit(input)).toMatchObject({ status: 'created', version: 1 })
      // The same delivery again, as the effect queue's retry after a crash hands it over: no line, no version, no change.
      expect(memory.submit(input)).toMatchObject({ status: 'duplicate', version: 1 })
      expect(journalLines(dir)).toHaveLength(1)
      memory.close()
      const reopened = open(dir)
      try {
        expect(reopened.submit(input)).toMatchObject({ status: 'duplicate', version: 1 })
        expect(reopened.status()).toMatchObject({ version: 1, experiences: 1 })
      } finally { reopened.close() }
      expect(journalLines(dir)).toHaveLength(1)
    })
  })

  it('drops the append a crash interrupted, keeps the acknowledged version, and lets the redelivery commit it', () => {
    scratch(dir => {
      const first = open(dir)
      const one = memoryInput(), two = memoryInput({ primary: 'feishu:oc_team:om_2', recordedAt: '2026-11-06T09:00:04.742Z' })
      first.submit(one)
      // The bytes `write(2)` never finished: no newline, so they were never an acknowledged op.
      appendFileSync(join(dir, 'journal', journalNameOf(1)), '{"t":"exp.put","seq":2,"version":2,"opId":"half')
      first.close()
      const recovered = open(dir)
      try {
        expect(recovered.status()).toMatchObject({ version: 1, seq: 1, experiences: 1, writable: true })
        // The torn bytes are gone rather than merged with the next op, which is what keeps the journal readable.
        expect(readFileSync(join(dir, 'journal', journalNameOf(1)), 'utf8').endsWith('\n')).toBe(true)
        expect(recovered.submit(two)).toMatchObject({ status: 'created', version: 2 })
      } finally { recovered.close() }
      const again = open(dir)
      try { expect(again.status()).toMatchObject({ version: 2, experiences: 2 }) } finally { again.close() }
    })
  })

  it('serves the version it has and refuses to write when a journal line is corrupt, instead of truncating it', () => {
    scratch(dir => {
      const first = open(dir)
      first.submit(memoryInput())
      first.submit(memoryInput({ primary: 'feishu:oc_team:om_2', recordedAt: '2026-11-06T09:00:04.742Z' }))
      first.close()
      // A finished line that cannot be read is corruption, not a torn tail: the bytes after it may be fine, so they are kept.
      const path = join(dir, 'journal', journalNameOf(1)), lines = readFileSync(path, 'utf8').split('\n')
      writeFileSync(path, [lines[0]!, '{"t":"exp.put","oops":true}', lines[2] ?? '', ''].join('\n'))
      const recovered = open(dir)
      try {
        expect(recovered.status()).toMatchObject({ version: 1, writable: false, state: 'readOnly' })
        expect(recovered.status().problems.join(' ')).toContain('corrupt')
        expect(recovered.list({ scope: {}, offset: 0, limit: 10 }).items).toHaveLength(1)
        expect(recovered.submit(memoryInput({ primary: 'feishu:oc_team:om_3' }))).toMatchObject({ status: 'rejected', reason: 'readOnly' })
      } finally { recovered.close() }
      // Unread data is still there: nothing was truncated and nothing was rewritten.
      expect(readFileSync(path, 'utf8')).toContain('"oops"')
    })
  })

  it('recovers from the checkpoint the manifest names, and ignores a checkpoint no manifest names', () => {
    scratch(dir => {
      const limits = testLimits({ checkpointOps: 2 })
      const first = open(dir, limits)
      first.submit(memoryInput())
      first.submit(memoryInput({ primary: 'feishu:oc_team:om_2', recordedAt: '2026-11-06T09:00:04.742Z' }))
      expect(first.status()).toMatchObject({ version: 2, experiences: 2 })
      expect(readdirSync(join(dir, 'published', 'series'))).toEqual(['ck-00000002.json'])
      // The crash after the checkpoint rename but before the manifest rename: an unreferenced checkpoint must be ignored.
      writeFileSync(join(dir, 'published', 'series', 'ck-00000009.json'), JSON.stringify({ format: 'dsh-superagent-memory/1', seq: 9,
        version: 9, at: '2026-11-06T10:00:00.000Z', policy: 'mem-policy-1', records: [] }))
      first.close()
      const fromCheckpoint = open(dir, limits)
      try {
        expect(fromCheckpoint.status()).toMatchObject({ version: 2, experiences: 2 })
        // The checkpoint is the materialised state, so a reader needs no journal segment the checkpoint already covers.
        for (const name of readdirSync(join(dir, 'journal'))) unlinkSync(join(dir, 'journal', name))
        fromCheckpoint.close()
        const alone = open(dir, limits)
        try { expect(alone.status()).toMatchObject({ version: 2, experiences: 2, writable: true }) } finally { alone.close() }
      } finally { fromCheckpoint.close() }
    })
  })

  it('replays the whole journal when the published manifest is gone, so the index is never the only copy', () => {
    scratch(dir => {
      const limits = testLimits({ checkpointOps: 64 })
      const first = open(dir, limits)
      first.submit(memoryInput())
      first.submit(memoryInput({ primary: 'feishu:oc_team:om_2', recordedAt: '2026-11-06T09:00:04.742Z' }))
      first.close()
      unlinkSync(join(dir, 'published', 'manifest.json'))
      const replayed = open(dir, limits)
      try {
        expect(replayed.status()).toMatchObject({ version: 2, experiences: 2, writable: true })
        // The index it rebuilt names the same version the journal's last line does.
        const manifest = JSON.parse(readFileSync(join(dir, 'published', 'manifest.json'), 'utf8')) as { version: number; seq: number }
        expect(manifest).toMatchObject({ version: 2, seq: 2 })
      } finally { replayed.close() }
    })
  })

  it('back-pressures instead of growing past its budget, and keeps everything it already published', () => {
    scratch(dir => {
      const limits = testLimits({ budgetBytes: 96 * 1024 })
      const memory = open(dir, limits), accepted: string[] = []
      try {
        for (let index = 0; index < 60; index++) {
          const input = memoryInput({ primary: `feishu:oc_team:om_${index}`, text: `the cache note number ${index} `.repeat(24),
            recordedAt: `2026-11-06T09:00:${String(index).padStart(2, '0')}.000Z` })
          const result = memory.submit(input)
          if (result.status === 'created') accepted.push(input.id)
          else expect(result).toMatchObject({ status: 'backpressured', reason: 'capacity' })
        }
        // The budget did its job: the store refused rather than writing unboundedly, and said so.
        expect(accepted.length).toBeGreaterThan(0)
        expect(accepted.length).toBeLessThan(60)
        expect(memory.status().state).not.toBe('readOnly')
        expect(memory.status().usage.total).toBeLessThanOrEqual(limits.budgetBytes)
        expect(memory.list({ scope: {}, offset: 0, limit: 50 }).total).toBe(accepted.length)
      } finally { memory.close() }
      // A refusal loses nothing: every accepted experience is still there after a restart.
      const reopened = open(dir, limits)
      try { expect(reopened.status().experiences).toBe(accepted.length) } finally { reopened.close() }
    })
  })

  it('accounts for what its files take, by class, and names the version a reader sees', () => {
    withStore((memory, dir) => {
      memory.submit(memoryInput())
      const status = memory.status(), { usage } = status
      expect(usage.total).toBe(usage.raw + usage.summaries + usage.index + usage.journal + usage.history + usage.temporary)
      expect(status.version).toBe(status.seq)
      expect(status.limits).toEqual(testLimits())
      const files = (path: string) => statSync(join(dir, path)).size
      // The journal holds at least the committed op, so the accounting cannot be a figure the store made up.
      expect(usage.journal).toBeGreaterThanOrEqual(files(join('journal', journalNameOf(1))))
      expect(usage.summaries).toBeGreaterThan(0)
    })
  })

  it('refuses a candidate whose base version a newer commit replaced, naming both versions and writing nothing', () => {
    withStore((memory, dir) => {
      memory.submit(memoryInput())
      const before = journalLines(dir)
      /** A candidate of the shape a compression job hands the service, about an experience this store does not hold. */
      const candidate = (baseVersion: number) => ({ jobId: 'job-1', experienceId: 'a'.repeat(32), baseVersion, text: 'a gist',
        sourceMap: ['a'.repeat(32)], version: 'mem-compression-1', model: 'deepseek/deepseek-chat', digest: 'a'.repeat(64),
        at: '2026-11-06T09:00:00.000Z', cited: ['a'.repeat(32)] })
      // A candidate computed from a version this store has left behind is a conflict, not a silent overwrite: both versions are
      // named so the caller can recompute from the current material, and no file is touched.
      expect(memory.submitCandidate(candidate(0))).toEqual({ status: 'conflict', id: 'a'.repeat(32), baseVersion: 0, version: 1 })
      expect(journalLines(dir)).toEqual(before)
      expect(memory.status()).toMatchObject({ version: 1, experiences: 1 })
      // A candidate whose base is the current version is not stale; it names no experience this store holds, so it applies nothing.
      expect(memory.submitCandidate(candidate(1))).toMatchObject({ status: 'rejected', reason: 'unknown' })
      expect(journalLines(dir)).toEqual(before)
    })
  })

  it('keeps large material in a blob that recall reaches without, and expand reaches after a restart', () => {
    withStore((memory, dir) => {
      const text = `the regression came from a stale cache entry, and the whole trace follows: ${'detail '.repeat(900)}`
      const input = memoryInput({ text })
      expect(memory.submit(input)).toMatchObject({ status: 'created' })
      expect(readdirSync(join(dir, 'raw'))).toHaveLength(1)
      // Recall shows the head, which is data that was legitimately kept, and never fabricates the rest.
      expect(memory.list({ scope: {}, offset: 0, limit: 1 }).items[0]).toMatchObject({ preview: expect.stringContaining('stale cache'),
        chars: text.length, readable: true })
      memory.close()
      const reopened = open(dir)
      try {
        expect(reopened.expand({ id: input.id, allowanceChars: 100_000 })).toMatchObject({ status: 'available', text, truncated: false })
        expect(reopened.expand({ id: input.id, allowanceChars: 20 })).toMatchObject({ status: 'available', chars: 20, truncated: true })
      } finally { reopened.close() }
    })
  })
})
