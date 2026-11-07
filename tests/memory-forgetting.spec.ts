/**
 * Forgetting and reactivation as the program decides them: the ordered thresholds of the one numeric policy, the equality rule on
 * either side of each, the ladder a declining weight walks — full detail, then the gist, then its cues alone, then out of routine
 * recall — and the correlation that wakes a forgotten experience without rewriting what it weighed. A controlled clock moves years
 * at a time, so every expectation here is a fixed record, a fixed instant and a fixed answer; nothing is scored again because the
 * clock moved, because the weight is a pure function of the policy, the record and the time.
 */
import { mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { CompressionCandidate, MemoryPolicy, MemoryRecord, ScoreCandidate } from '../src/memory/model.ts'
import { MemoryService } from '../src/memory/service.ts'
import { MEMORY_POLICY, granularityOf, policyProblems, ruleScoreOf, weightOf } from '../src/memory/score.ts'
import { memoryInput, testLimits } from './fixtures/memory.ts'

/** The policy with one field replaced, for the configurations the loader must refuse. */
const withPolicy = (overrides: Partial<MemoryPolicy>): MemoryPolicy => ({ ...MEMORY_POLICY, ...overrides })

let home: string, dir: string, memory: MemoryService
/** The clock the service reads: a memory's age is this instant less the one its experience occurred at. */
let at: string

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'memory-forgetting-'))
  dir = join(home, 'memory')
  at = '2026-01-01T00:00:00.000Z'
  memory = MemoryService.open({ dir, limits: testLimits(), now: () => at })
})
afterEach(() => { memory.close(); rmSync(home, { recursive: true, force: true }) })

/** Publish one experience as a capture does at this instant, and return its id. */
const publish = (parts: Parameters<typeof memoryInput>[0] = {}): string => {
  const input = memoryInput({ occurredAt: at, recordedAt: at, ...parts })
  expect(memory.submit(input)).toMatchObject({ status: 'created' })
  return input.id
}
/** The record of one published experience, which is what the rule half is computed from. */
const recordOf = (id: string): MemoryRecord => memory.record(id)!
/** The candidate a background job would hand the service for `id`, computed from the version it read. */
const candidateOf = (id: string, parts: Partial<ScoreCandidate> = {}): ScoreCandidate => {
  const record = recordOf(id)
  const rule = ruleScoreOf(record.experience, MEMORY_POLICY)
  return { jobId: `job-${id}`, experienceId: id, baseVersion: memory.version, semantic: 60, rule: rule.score, ruleParts: rule.parts,
    policy: MEMORY_POLICY.version, principles: 'mem-principles-1', model: 'deepseek/deepseek-chat', digest: 'd'.repeat(64),
    rationale: 'a person reported a defect that still blocks the work', cited: [id], uncertain: [], at, ...parts }
}

describe('the ladder a declining weight walks', () => {
  it('puts a weight in exactly one rung, and a weight at a threshold keeps the higher rung', () => {
    // The calibration this build ships, recorded rather than implied: the three ordered thresholds on the 0–100 scale.
    expect([MEMORY_POLICY.thresholds.detail, MEMORY_POLICY.thresholds.summary, MEMORY_POLICY.thresholds.forgotten]).toEqual([70, 40, 15])
    expect(MEMORY_POLICY.inclusive).toBe(true)
    // A fresh, important record keeps its detail; an aged one keeps its gist; an older one keeps only its cues; the oldest left
    // routine recall. A weight exactly at a threshold takes the higher rung, which is the rule the policy declares.
    expect(granularityOf(100, MEMORY_POLICY)).toBe('detail')
    expect(granularityOf(70, MEMORY_POLICY)).toBe('detail')
    expect(granularityOf(69.99, MEMORY_POLICY)).toBe('summary')
    expect(granularityOf(40, MEMORY_POLICY)).toBe('summary')
    expect(granularityOf(39.99, MEMORY_POLICY)).toBe('cues')
    expect(granularityOf(15, MEMORY_POLICY)).toBe('cues')
    expect(granularityOf(14.99, MEMORY_POLICY)).toBe('forgotten')
    expect(granularityOf(0, MEMORY_POLICY)).toBe('forgotten')
    // The other side of the same boundary is a configuration choice, not a hidden convention: an exclusive policy gives a weight
    // exactly at the threshold to the lower rung, and the loader accepts it because the order is still unambiguous.
    const exclusive = withPolicy({ inclusive: false })
    expect(policyProblems(exclusive)).toEqual([])
    expect(granularityOf(70, exclusive)).toBe('summary')
    expect(granularityOf(40, exclusive)).toBe('cues')
    expect(granularityOf(15, exclusive)).toBe('forgotten')
    expect(granularityOf(70.01, exclusive)).toBe('detail')
    // A weight off the scale still lands on one rung rather than nowhere: the program never reports a fifth state.
    expect(granularityOf(Number.NaN, MEMORY_POLICY)).toBe('forgotten')
  })

  it('keeps an important experience readable as its gist across a span of years, which is what the ladder is calibrated to', () => {
    const at = '2026-01-01T00:00:00.000Z'
    const rungAt = (score: number, iso: string): string => granularityOf(weightOf(score, at, iso, MEMORY_POLICY), MEMORY_POLICY)
    // The product requirement this ladder serves: after experiences span many years, the important ones are still recallable as their
    // gist. A fact of the highest importance keeps its detail for four years, its gist for thirteen, and stops being a candidate for
    // routine recall some seventy years on — the shipped term used to lose the detail within five months and the gist within a year
    // and a half, which read a year-old fact as history.
    expect(rungAt(100, '2030-01-01T00:00:00.000Z')).toBe('detail')
    expect(rungAt(100, '2030-06-01T00:00:00.000Z')).toBe('summary')
    expect(rungAt(100, '2039-01-01T00:00:00.000Z')).toBe('summary')
    expect(rungAt(100, '2042-01-01T00:00:00.000Z')).toBe('cues')
    // Importance 70 is the least a fact that once reached the detail threshold can weigh, and it holds its gist for seven years.
    expect(rungAt(70, '2033-01-01T00:00:00.000Z')).toBe('summary')
    expect(rungAt(70, '2034-01-01T00:00:00.000Z')).toBe('cues')
    // The rungs are still three ordered doors and not one: a fact of middling importance ages out of the gist long before a 100 does.
    expect(rungAt(45, '2026-07-01T00:00:00.000Z')).toBe('summary')
    expect(rungAt(45, '2030-01-01T00:00:00.000Z')).toBe('cues')
  })

  it('refuses a ladder that cannot be walked, and a hysteresis pair that would not settle', () => {
    expect(policyProblems(MEMORY_POLICY)).toEqual([])
    // Crossed thresholds, a threshold off the scale, and a top threshold no weight can reach are the configurations the loader
    // must refuse: one of them makes a rung unreachable, and the others make the order ambiguous.
    expect(policyProblems(withPolicy({ thresholds: { detail: 40, summary: 70, forgotten: 15 } }))).toContain('thresholdOrder')
    expect(policyProblems(withPolicy({ thresholds: { detail: 70, summary: 40, forgotten: 40 } }))).toContain('thresholdOrder')
    expect(policyProblems(withPolicy({ thresholds: { detail: 140, summary: 40, forgotten: 15 } }))).toContain('thresholdOutsideScale')
    expect(policyProblems(withPolicy({ thresholds: { detail: 95, summary: 40, forgotten: 15 } }))).toContain('thresholdUnreachable')
    expect(policyProblems(withPolicy({ thresholds: { detail: 70, summary: 40, forgotten: Number.NaN } }))).toContain('thresholdOrder')
    // The equality rule is a boolean or it is not a policy: a truthy string could silently mean either side of a boundary.
    expect(policyProblems(withPolicy({ inclusive: 'yes' as unknown as boolean }))).toContain('inclusive')
    // A hysteresis pair is optional; when one is configured, both numbers must be on the scale and the exit below the enter, or
    // the pair would hold a decision where it is instead of letting it settle.
    expect(policyProblems(withPolicy({ hysteresis: { enter: 60, exit: 40 } }))).toEqual([])
    expect(policyProblems(withPolicy({ hysteresis: { enter: 40, exit: 60 } }))).toContain('hysteresis')
    expect(policyProblems(withPolicy({ hysteresis: { enter: 60, exit: 60 } }))).toContain('hysteresis')
    expect(policyProblems(withPolicy({ hysteresis: { enter: 140, exit: 40 } }))).toContain('hysteresis')
  })
})

/** The original of the record the ladder is walked with, and the gist a compression job committed for it. */
const ORIGINAL = 'Alice: on 2026-03-04 the settings page cache went stale and the deploy did not rebuild it, so do not raise the '
  + 'threshold before the freeze ends.'
const GIST = 'On 2026-03-04 the settings page cache went stale and the deploy did not rebuild it, so do not raise the threshold '
  + 'before the freeze ends.'

/** The gist candidate a compression job hands the service for `id`, computed from the version it read. */
const gistOf = (id: string): CompressionCandidate => ({ jobId: 'compress-1', experienceId: id, baseVersion: memory.version, text: GIST,
  sourceMap: [id], version: 'mem-compression-1', model: 'deepseek/deepseek-chat', digest: 'c'.repeat(64), at, cited: [id] })
/** What routine recall of the record's own cues returns at this instant. */
const recallOf = (cues: string[] = ['cache', 'stale']) => memory.recall({ scope: { project: 'acme/widgets' }, cues, allowanceChars: 4000 })

/** One record that is fresh, then a year old, then ten, then forty: the ladder the clock walks it down. */
function ladderRecord(): string {
  const id = publish({ text: ORIGINAL, primary: 'a' })
  expect(memory.submitScore(candidateOf(id, { semantic: 100 }))).toMatchObject({ status: 'created' })
  expect(memory.submitCandidate(gistOf(id))).toMatchObject({ status: 'created' })
  return id
}

describe('routine recall shows the rung the weight reached', () => {
  it('shows the detail while it is fresh, the gist when it is not, only its cues once it has faded, and nothing after that', () => {
    const id = ladderRecord()
    const committed = JSON.stringify(memory.record(id)), version = memory.version
    // 0.6 × 53 + 0.4 × 100 = 71.8: a fresh, important record, whose detail is what routine recall shows even though a gist exists.
    expect(memory.weight(id)).toBeCloseTo(71.8, 6)
    expect(memory.granularity(id)).toBe('detail')
    const fresh = recallOf()
    expect(fresh.items[0]).toMatchObject({ id, granularity: 'detail', summarised: false })
    expect(fresh.items[0]!.shown).toBe(ORIGINAL)
    expect(fresh.text).not.toContain('[summary]')
    // A year on, the same weight is 71.8 / (1 + 365/3650) = 65.3, and the gist is what is read instead of the original.
    at = '2027-01-01T00:00:00.000Z'
    expect(memory.weight(id)).toBeCloseTo(65.3, 1)
    const gist = recallOf()
    expect(gist.items[0]).toMatchObject({ id, granularity: 'summary', summarised: true })
    expect(gist.items[0]!.shown).toBe(GIST)
    expect(gist.text).toContain('[summary]')
    // Ten years on it is 35.9: it still matches, and what is left to show is its cues rather than what it said.
    at = '2036-01-01T00:00:00.000Z'
    expect(memory.weight(id)).toBeCloseTo(35.9, 1)
    expect(memory.granularity(id)).toBe('cues')
    const faded = recallOf()
    expect(faded.items[0]).toMatchObject({ id, granularity: 'cues', summarised: false, shown: '' })
    // What is left is the cues it is still known by, and the line says so rather than showing a body it no longer earns.
    expect(faded.text).toContain('only its retrieval cues remain: cache, stale')
    expect(faded.text).not.toContain('did not rebuild')
    // Forty years on it is 14.4, under the last threshold: routine recall no longer returns it, and says so by count. The horizon is
    // the policy's, not this test's: ten years halves a weight, so a fact of importance 71.8 stays a candidate for four decades.
    at = '2066-01-01T00:00:00.000Z'
    expect(memory.weight(id)).toBeCloseTo(14.4, 1)
    expect(memory.weight(id)).toBeLessThan(MEMORY_POLICY.thresholds.forgotten)
    expect(memory.granularity(id)).toBe('forgotten')
    const gone = recallOf()
    expect(gone).toMatchObject({ items: [], text: '', forgotten: 1 })
    // Forgetting is not deletion: the original is still there, still expandable, still listed, and the record never changed.
    expect(memory.expand({ id, allowanceChars: 4000 })).toMatchObject({ status: 'available', text: ORIGINAL })
    expect(memory.list({ scope: { project: 'acme/widgets' }, offset: 0, limit: 10 }).items.map(item => item.id)).toEqual([id])
    expect(JSON.stringify(memory.record(id))).toBe(committed)
    expect(memory.version).toBe(version)
  })

  it('states how many matches left routine recall rather than dropping them silently', () => {
    const faded = publish({ text: 'the export button is broken for every viewer since the deploy, and the retry loop never terminates',
      occurredAt: '1996-01-01T00:00:00.000Z', recordedAt: '1996-01-01T00:00:00.000Z', primary: 'old' })
    const recent = publish({ text: 'the export button is broken for every viewer since the deploy', primary: 'new' })
    // Thirty years on, the older copy is under the last threshold: a candidate routine recall may not show, and it says so.
    const recalled = memory.recall({ scope: { project: 'acme/widgets' }, cues: ['export', 'button'], allowanceChars: 4000 })
    expect(recalled.items.map(item => item.id)).toEqual([recent])
    expect(recalled.forgotten).toBe(1)
    expect(recalled.text).toContain('left routine recall')
    expect(recalled.text).not.toContain('retry loop')
    // A strong cue is the other door: what routine recall let go is still reachable, and it is what proves it was kept.
    expect(memory.reactivate({ scope: { project: 'acme/widgets' }, cues: ['export', 'button'], allowanceChars: 4000 }).items
      .map(item => item.id)).toContain(faded)
  })
})

describe('a strong cue wakes what routine recall let go', () => {
  it('brings a forgotten experience back as its gist, for this query alone, and writes nothing', () => {
    const id = ladderRecord()
    const committed = JSON.stringify(memory.record(id)), version = memory.version
    // Forty years on: under the last threshold, so routine recall no longer returns it.
    at = '2066-01-01T00:00:00.000Z'
    expect(memory.granularity(id)).toBe('forgotten')
    expect(recallOf().items).toEqual([])
    // One shared cue is not a correlation: with nothing strong enough to tie it to this situation it stays forgotten.
    expect(memory.reactivate({ scope: { project: 'acme/widgets' }, cues: ['cache'], allowanceChars: 4000 }).items).toEqual([])
    // Two cues at once meet the policy's own reactivation threshold: the experience is a candidate for this query, read short.
    const woken = memory.reactivate({ scope: { project: 'acme/widgets' }, cues: ['cache', 'stale'], allowanceChars: 4000 })
    expect(woken.items[0]).toMatchObject({ id, granularity: 'summary', summarised: true })
    expect(woken.items[0]!.shown).toBe(GIST)
    expect(woken.text).toContain('[summary]')
    // The raise lasts for this answer and nothing else: no weight, age, confidence or retention changed, and no version moved.
    expect(memory.weight(id)).toBeCloseTo(14.35, 1)
    expect(memory.granularity(id)).toBe('forgotten')
    expect(JSON.stringify(memory.record(id))).toBe(committed)
    expect(memory.version).toBe(version)
    // The scope filter runs before the correlation on this door as well: another project's query cannot wake it.
    expect(memory.reactivate({ scope: { project: 'other/widgets' }, cues: ['cache', 'stale'], allowanceChars: 4000 }).items).toEqual([])
    // And the request budget still caps what comes back, exactly as it does on the routine path.
    expect(memory.reactivate({ scope: { project: 'acme/widgets' }, cues: ['cache', 'stale'], allowanceChars: 10 }))
      .toMatchObject({ text: '', chars: 0, items: [] })
  })

  it('never shows a woken match above the rung its own weight reached', () => {
    const id = ladderRecord()
    // Still fresh: the same door returns it at the detail rung, so waking one raises nothing above what its weight earned.
    const woken = memory.reactivate({ scope: { project: 'acme/widgets' }, cues: ['cache', 'stale'], allowanceChars: 4000 })
    expect(woken.items[0]).toMatchObject({ id, granularity: 'detail', summarised: false, shown: ORIGINAL })
  })
})

/** Every byte of the memory's own journal, which is the only proof that a read wrote nothing. */
const journal = (): string => join(dir, 'journal')
const journalBytes = (): number => readdirSync(journal()).filter(name => name.endsWith('.ndjson'))
  .reduce((total, name) => total + statSync(join(journal(), name)).size, 0)

describe('a read is not evidence and a clock is not a job', () => {
  it('keeps the same weight and the same version when the same experience is recalled twice', () => {
    const id = ladderRecord()
    const scored = memory.importance(id), version = memory.version, bytes = journalBytes()
    at = '2027-01-01T00:00:00.000Z'
    const first = recallOf(), again = recallOf()
    // The second read is the first read: same items, same weight, same block. Nothing about being recalled made it weigh more.
    expect(again).toEqual(first)
    expect(first.items[0]!.weight).toBeCloseTo(memory.weight(id)!, 9)
    // The clock moving and the memory being read start no job and write no byte: the journal is exactly what the commits left.
    expect(memory.weight(id)).toBeCloseTo(65.3, 1)
    expect(memory.version).toBe(version)
    expect(journalBytes()).toBe(bytes)
    // What it weighed, when it happened and which representation recall returns are all where the commits put them.
    expect(memory.importance(id)).toEqual(scored)
    expect(memory.record(id)!.experience.occurredAt).toBe('2026-01-01T00:00:00.000Z')
    expect(memory.record(id)!.representation.revision).toBe(2)
    // Reactivating it changes as little: the door is this query's candidacy, never a second importance.
    at = '2031-01-01T00:00:00.000Z'
    expect(memory.reactivate({ scope: { project: 'acme/widgets' }, cues: ['cache', 'stale'], allowanceChars: 4000 }).items)
      .toHaveLength(1)
    expect(memory.importance(id)).toEqual(scored)
    expect(memory.version).toBe(version)
    expect(journalBytes()).toBe(bytes)
  })
})
