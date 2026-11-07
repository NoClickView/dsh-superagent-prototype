/**
 * Retrieval v1 as a caller meets it: cues derived from text on both sides, the scope filter that runs before any matching, an order
 * two runs agree on, and a rendered block that stays inside the characters it was given and says what it left out. Deterministic, no
 * model and no clock: every expectation here is a fixed input and a fixed answer.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MemoryService } from '../src/memory/service.ts'
import { RECALL_HEADER, cuesOf, inScope } from '../src/memory/retrieval.ts'
import { memoryInput, testLimits } from './fixtures/memory.ts'

let home: string, dir: string, memory: MemoryService
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'memory-recall-'))
  dir = join(home, 'memory')
  memory = MemoryService.open({ dir, limits: testLimits(), now: () => '2026-11-06T09:10:00.000Z' })
})
afterEach(() => { memory.close(); rmSync(home, { recursive: true, force: true }) })

/** Publish one experience and return its id. */
const publish = (parts: Parameters<typeof memoryInput>[0]): string => {
  const input = memoryInput(parts)
  expect(memory.submit(input)).toMatchObject({ status: 'created' })
  return input.id
}

describe('retrieval v1', () => {
  it('finds an experience by a keyword cue and says it is background, not an instruction', () => {
    const id = publish({ text: 'The regression came from a stale cache entry in the settings page.' })
    const recalled = memory.recall({ scope: { project: 'acme/widgets' }, cues: ['cache', 'settings'], allowanceChars: 4000 })
    expect(recalled.items.map(item => item.id)).toEqual([id])
    expect(recalled.text.length).toBeLessThanOrEqual(4000)
    expect(recalled.text.startsWith(RECALL_HEADER)).toBe(true)
    // The reader can name the version it was read from, and nothing in the block grants or changes anything.
    expect(recalled.text).toContain(`Published version ${recalled.version}.`)
    expect(recalled.text).toContain('stale cache')
    expect(recalled.text).not.toMatch(/member|topic|(?<![\w-])event\/|(?<![\w-])task\/|reopen|admission_|guide\//)
  })

  it('cuts to the characters it was given, keeps the most relevant, and states what did not fit', () => {
    const first = publish({ text: 'cache and settings: the cache was stale in the settings page' })
    publish({ text: 'settings got a mention here', recordedAt: '2026-11-06T09:00:04.742Z', primary: 'feishu:oc_team:om_2' })
    const request = { scope: {}, cues: ['cache', 'settings'] }
    const wide = memory.recall({ ...request, allowanceChars: 4000 })
    expect(wide.items).toHaveLength(2)
    expect(wide.items[0]!.id).toBe(first)
    expect(wide.omitted.count).toBe(0)
    // Room for the header and the best line and nothing else: one item, exact text, and the caller still learns one was left out.
    const [header, bestLine, otherLine] = wide.text.split('\n') as [string, string, string]
    const tightAllowance = header.length + bestLine.length + 2
    const tight = memory.recall({ ...request, allowanceChars: tightAllowance })
    expect(tight.text).toBe(`${header}\n${bestLine}`)
    expect(tight.items.map(item => item.id)).toEqual([first])
    expect(tight.omitted.count).toBe(1)
    // Room for the line that states the omission too: the block says it rather than dropping the match silently.
    const footer = '- (1 more matched and did not fit this request\'s budget.)'
    const roomy = memory.recall({ ...request, allowanceChars: tightAllowance + footer.length + 1 })
    expect(roomy.text).toBe(`${header}\n${bestLine}\n${footer}`)
    expect(roomy.items).toHaveLength(1)
    expect(otherLine).toContain('mention')
    // Nothing fits at all: no header without content, and the caller is told so by an empty block.
    expect(memory.recall({ scope: {}, cues: ['cache'], allowanceChars: 10 })).toMatchObject({ text: '', chars: 0, items: [] })
  })

  it('matches Chinese by its character bigrams, and two texts that share only a stopword share no cue', () => {
    // CJK writes no spaces, so a clause's words are its overlapping bigrams, and a short run is a cue of its own.
    expect(cuesOf(['缓存未失效'])).toEqual(['缓存未失效', '缓存', '存未', '未失', '失效'])
    expect(cuesOf(['The cache was stale'])).toEqual(['cache', 'stale'])
    // "一下" and "the" say nothing about what an experience is about, so they never revive one.
    expect(cuesOf(['先别急着改一下'])).toEqual(['先别急着改一下', '先别', '别急', '急着', '着改', '改一'])
    expect(cuesOf(['the regression'])).toEqual(['regression'])
    const id = publish({ text: '这次回归是缓存未失效导致的，先别急着改阈值。', primary: 'feishu:oc_team:om_9' })
    expect(memory.recall({ scope: {}, cues: cuesOf(['缓存']), allowanceChars: 4000 }).items.map(item => item.id)).toEqual([id])
    expect(memory.recall({ scope: {}, cues: cuesOf(['一下']), allowanceChars: 4000 }).items).toEqual([])
  })

  it('never returns an experience outside the requested scope, and a request that names no scope key sees every scope', () => {
    const mine = publish({ text: 'the deploy needs a cache flush' })
    const other = publish({ text: 'the deploy needs a cache flush', scope: { project: 'other/widgets' }, primary: 'feishu:oc_team:om_2' })
    const theirs = publish({ text: 'the deploy needs a cache flush', scope: { project: 'acme/widgets', task: 'ticket-b' },
      primary: 'feishu:oc_team:om_3' })
    // A record whose scope is a different project, or a task this request is not that task, is not evidence about this project.
    expect(memory.recall({ scope: { project: 'acme/widgets' }, cues: ['deploy', 'cache'], allowanceChars: 4000 }).items.map(item => item.id).sort())
      .toEqual([mine, theirs].sort())
    // A ticket-scoped request sees its own ticket's records, and a project-level record is not a wildcard for it: an absent scope
    // key is not evidence about a task.
    expect(memory.recall({ scope: { project: 'acme/widgets', task: 'ticket-a' }, cues: ['deploy', 'cache'], allowanceChars: 4000 }).items)
      .toEqual([])
    expect(memory.recall({ scope: { project: 'other/widgets' }, cues: ['deploy', 'cache'], allowanceChars: 4000 }).items.map(item => item.id))
      .toEqual([other])
    expect(memory.recall({ scope: { task: 'ticket-b' }, cues: ['deploy', 'cache'], allowanceChars: 4000 }).items.map(item => item.id))
      .toEqual([theirs])
    expect(inScope({ experience: { scope: { project: 'acme/widgets' } } } as never, { project: 'acme/widgets', task: 'ticket-a' })).toBe(false)
  })

  it('orders by relevance, then the newest, then the id, so two runs of the same query agree', () => {
    const shared = { text: 'the cache is stale on the settings page' }
    const older = publish({ ...shared, occurredAt: '2026-11-01T09:00:00.000Z', recordedAt: '2026-11-01T09:00:00.100Z', primary: 'a' })
    const newer = publish({ ...shared, occurredAt: '2026-11-02T09:00:00.000Z', recordedAt: '2026-11-02T09:00:00.100Z', primary: 'b' })
    const request = { scope: {}, cues: ['cache', 'settings'], allowanceChars: 8000 }
    const first = memory.recall(request), again = memory.recall(request)
    expect(first.items.map(item => item.id)).toEqual([newer, older])
    expect(first.text).toBe(again.text)
    // Recall correlates only with this query: nothing it computes is stored, and reading twice changes no version.
    expect(memory.status().version).toBe(2)
  })

  it('lists what is in scope, newest first, paged, with the read that returns one whole text', () => {
    const older = publish({ text: 'first note', occurredAt: '2026-11-01T09:00:00.000Z', primary: 'a' })
    const newer = publish({ text: 'second note', occurredAt: '2026-11-02T09:00:00.000Z', primary: 'b' })
    const page = memory.list({ scope: {}, offset: 0, limit: 1 })
    expect(page).toMatchObject({ total: 2, next: 1, version: 2 })
    expect(page.items[0]).toMatchObject({ id: newer, preview: expect.stringContaining('second note'), readable: true })
    expect(memory.list({ scope: {}, offset: 1, limit: 1 }).items[0]).toMatchObject({ id: older, readable: true })
    expect(memory.expand({ id: older, allowanceChars: 4000 })).toMatchObject({ status: 'available', text: 'first note', omittedChars: 0 })
    expect(memory.expand({ id: 'f'.repeat(32), allowanceChars: 4000 })).toEqual({ status: 'unknown', id: 'f'.repeat(32) })
  })

  it('keeps a truncated capture honest about how much of it was never stored', () => {
    // Larger than a capture keeps: the head is stored, and expand says how many characters are gone rather than inventing them.
    const text = 'x'.repeat(40_000)
    const id = publish({ text, primary: 'huge' })
    const expanded = memory.expand({ id, allowanceChars: 100_000 })
    expect(expanded).toMatchObject({ status: 'available', chars: 32_768, omittedChars: 40_000 - 32_768 })
    expect(expanded.status === 'available' && expanded.text).toBe(text.slice(0, 32_768))
    expect(memory.list({ scope: {}, offset: 0, limit: 1 }).items[0]).toMatchObject({ chars: 40_000, readable: true })
  })
})
