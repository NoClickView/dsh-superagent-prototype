/**
 * The versioned numeric policy as a program meets it: one scale, a non-negative linear combination of the rule score and the
 * semantic score, one deterministic time term, and the validation that refuses a policy the behaviour cannot be explained from.
 * Every expectation is a fixed input and a fixed answer, worked by hand from the numbers the policy declares — no model, no clock
 * of its own — because the point of the policy is that two runs of the same record agree. The score then reaches the only entry
 * point that writes: a candidate is committed with the version it was computed from, or it changes nothing at all.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { MemoryPolicy, MemoryRecord, ScoreCandidate } from '../src/memory/model.ts'
import { MemoryService } from '../src/memory/service.ts'
import { MEMORY_POLICY, importanceOf, policyProblems, ruleScoreOf, timeFactorOf, weightOf } from '../src/memory/score.ts'
import { memoryInput, testLimits } from './fixtures/memory.ts'

/** The policy with one field replaced, for the configs the loader must refuse. */
const withPolicy = (overrides: Partial<MemoryPolicy>): MemoryPolicy => ({ ...MEMORY_POLICY, ...overrides })

let home: string, dir: string, memory: MemoryService
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'memory-score-'))
  dir = join(home, 'memory')
  memory = MemoryService.open({ dir, limits: testLimits(), now: () => '2026-11-06T09:10:00.000Z' })
})
afterEach(() => { memory.close(); rmSync(home, { recursive: true, force: true }) })

/** Publish one experience as a capture does, and return its id. */
const publish = (parts: Parameters<typeof memoryInput>[0] = {}): string => {
  const input = memoryInput(parts)
  expect(memory.submit(input)).toMatchObject({ status: 'created' })
  return input.id
}
/** The record of one published experience, which is what the rule half is computed from. */
const recordOf = (parts: Parameters<typeof memoryInput>[0] = {}): MemoryRecord => {
  const id = publish(parts)
  return memory.record(id)!
}

describe('the numeric policy', () => {
  it('combines a rule score and a semantic score linearly on its own scale', () => {
    // 0.6 × 80 + 0.4 × 60 = 72, worked from the declared coefficients rather than recomputed from the code.
    expect([MEMORY_POLICY.ruleWeight, MEMORY_POLICY.semanticWeight]).toEqual([0.6, 0.4])
    expect(importanceOf(80, 60, MEMORY_POLICY)).toBe(72)
    expect(importanceOf(0, 0, MEMORY_POLICY)).toBe(0)
    expect(importanceOf(100, 100, MEMORY_POLICY)).toBe(100)
    // A continuous score: no rounding to a low/middle/high label, and the bounds hold on either side.
    expect(importanceOf(63.5, 41.25, MEMORY_POLICY)).toBeCloseTo(54.6, 6)
    expect(importanceOf(150, 60, MEMORY_POLICY)).toBe(100)
    expect(importanceOf(-40, 0, MEMORY_POLICY)).toBe(0)
  })

  it('applies one deterministic time term, once, and leaves a record with no age alone', () => {
    const at = '2026-01-01T00:00:00.000Z'
    // No age, no decay; the unit is a day, and the term is calibrated to the years an experience spans rather than to a season:
    // ten years halves the weight that survives, and one year takes a tenth of it away.
    expect(timeFactorOf(at, at, MEMORY_POLICY)).toBe(1)
    expect(MEMORY_POLICY.time.unit).toBe('day')
    expect(timeFactorOf(at, '2036-01-01T00:00:00.000Z', MEMORY_POLICY)).toBeCloseTo(0.5, 2)
    expect(timeFactorOf(at, '2027-01-01T00:00:00.000Z', MEMORY_POLICY)).toBeCloseTo(1 / 1.1, 2)
    // The term only ever lowers a weight, and a timestamp ahead of the clock is not an age.
    expect(timeFactorOf(at, '2026-01-31T00:00:00.000Z', MEMORY_POLICY)).toBeLessThan(1)
    expect(timeFactorOf('2026-06-01T00:00:00.000Z', at, MEMORY_POLICY)).toBe(1)
    // The effective weight is the importance with that one term applied: 72 at ten years is 36.
    expect(weightOf(72, at, at, MEMORY_POLICY)).toBe(72)
    expect(weightOf(72, at, '2036-01-01T00:00:00.000Z', MEMORY_POLICY)).toBeCloseTo(36, 1)
  })

  it('refuses a policy whose coefficients, thresholds, time base or scale cannot explain a score', () => {
    expect(policyProblems(MEMORY_POLICY)).toEqual([])
    expect(policyProblems(withPolicy({ ruleWeight: -0.6, semanticWeight: 1.6 }))).toContain('coefficientNegative')
    expect(policyProblems(withPolicy({ ruleWeight: 0.6, semanticWeight: 0.6 }))).toContain('coefficientNotNormalised')
    expect(policyProblems(withPolicy({ ruleWeight: 0, semanticWeight: 0 }))).toContain('coefficientNotNormalised')
    expect(policyProblems(withPolicy({ version: '' }))).toContain('version')
    expect(policyProblems(withPolicy({ scale: { min: 100, max: 0 } }))).toContain('scale')
    // Thresholds are ordered, inside the scale, and the top one is reachable by the combination itself.
    expect(policyProblems(withPolicy({ thresholds: { detail: 30, summary: 70, forgotten: 10 } }))).toContain('thresholdOrder')
    expect(policyProblems(withPolicy({ thresholds: { detail: 140, summary: 40, forgotten: 10 } }))).toContain('thresholdOutsideScale')
    expect(policyProblems(withPolicy({ thresholds: { detail: 95, summary: 40, forgotten: 10 } }))).toContain('thresholdUnreachable')
    // The time term needs a unit it knows, a real timestamp, and a decay that can only lower a weight.
    expect(policyProblems(withPolicy({ time: { unit: 'fortnight' as 'day', base: MEMORY_POLICY.time.base, decay: 0.01 } }))).toContain('timeUnit')
    expect(policyProblems(withPolicy({ time: { ...MEMORY_POLICY.time, base: 'yesterday' } }))).toContain('timeBase')
    expect(policyProblems(withPolicy({ time: { ...MEMORY_POLICY.time, decay: -0.01 } }))).toContain('timeDecay')
    // A correlation is a ratio between 0 and 1, never a weight on the importance scale.
    expect(policyProblems(withPolicy({ recallThreshold: 40 }))).toContain('recallThreshold')
  })

  it('scores the rule half deterministically from what kind of fact an experience is, and never from repetition', () => {
    const observed = recordOf({ subject: 'Alice', kind: 'observation', primary: 'a' }).experience
    const observation = ruleScoreOf(observed, MEMORY_POLICY)
    // The same fact, read twice, is the same score: the rule half never looks at how often it was recalled or restated.
    expect(ruleScoreOf(observed, MEMORY_POLICY)).toEqual(observation)
    // A model's own conclusion is weaker evidence than what was observed, and accepted work is stronger.
    expect(ruleScoreOf(recordOf({ subject: 'Alice', kind: 'inference', primary: 'b' }).experience, MEMORY_POLICY).score)
      .toBeLessThan(observation.score)
    expect(ruleScoreOf(recordOf({ subject: 'Fix the cache', event: 'ticket.created', kind: 'statement', primary: 'c' }).experience,
      MEMORY_POLICY).score).toBeGreaterThan(observation.score)
    // Naming what it is about, linking somewhere checkable, and belonging to an accepted task each add to it.
    expect(ruleScoreOf({ ...observed, subject: undefined }, MEMORY_POLICY).score).toBeLessThan(observation.score)
    expect(ruleScoreOf({ ...observed, origin: { ...observed.origin, url: 'https://example.test/issues/7' } }, MEMORY_POLICY).score)
      .toBeGreaterThan(observation.score)
    expect(ruleScoreOf({ ...observed, scope: { ...observed.scope, task: 'ticket-a' } }, MEMORY_POLICY).score).toBeGreaterThan(observation.score)
    // The parts name why, and the score stays on the scale.
    expect(observation.parts.join(' ')).toContain('observation')
    for (const value of [observation, ruleScoreOf(recordOf({ event: 'policy.changed', primary: 'd' }).experience, MEMORY_POLICY)]) {
      expect(value.score).toBeGreaterThanOrEqual(MEMORY_POLICY.scale.min)
      expect(value.score).toBeLessThanOrEqual(MEMORY_POLICY.scale.max)
    }
  })
})

/** The candidate a background job would hand the service for `id`, computed from the version it read. */
const candidateOf = (id: string, parts: Partial<ScoreCandidate> = {}): ScoreCandidate => {
  const record = memory.record(id)
  const rule = record ? ruleScoreOf(record.experience, MEMORY_POLICY) : { score: 0, parts: [] }
  return { jobId: `job-${id}`, experienceId: id, baseVersion: memory.version, semantic: 60, rule: rule.score, ruleParts: rule.parts,
    policy: MEMORY_POLICY.version, principles: 'mem-principles-1', model: 'deepseek/deepseek-chat', digest: 'd'.repeat(64),
    rationale: 'a person reported a defect that still blocks the work', cited: [id], uncertain: [], at: '2026-11-06T09:10:00.000Z', ...parts }
}

describe('a score candidate committed through the one entry point', () => {
  it('keeps the semantic and rule score as the weight of the record, and names the version it committed to', () => {
    const id = publish()
    const before = memory.version
    expect(memory.submitScore(candidateOf(id))).toEqual({ status: 'created', id, version: before + 1 })
    const stored = memory.importance(id)!
    expect(stored).toMatchObject({ semantic: 60, policy: MEMORY_POLICY.version, principles: 'mem-principles-1', model: 'deepseek/deepseek-chat',
      rationale: expect.stringContaining('person reported'), cited: [id], jobId: `job-${id}` })
    // 0.6 × the rule score + 0.4 × 60, on the policy's scale; the version it committed to is the one the record now has.
    expect(stored.score).toBeCloseTo(0.6 * stored.rule + 24, 6)
    expect(memory.record(id)!.version).toBe(before + 1)
    expect(stored.ruleParts.length).toBeGreaterThan(0)
  })

  it('refuses a stale, repeated, mis-cited, out-of-range or foreign-policy candidate, and changes nothing', () => {
    const id = publish(), other = publish({ primary: 'feishu:oc_team:om_2', text: 'the export button is broken' })
    expect(memory.submitScore(candidateOf(id))).toMatchObject({ status: 'created' })
    const committed = JSON.stringify(memory.record(id)), version = memory.version
    // The same job again: it already applied, so the version it names is no longer current and nothing is written twice.
    expect(memory.submitScore(candidateOf(id))).toMatchObject({ status: 'rejected', reason: 'stale' })
    expect(memory.submitScore(candidateOf(id, { jobId: 'job-2', baseVersion: version - 1 }))).toMatchObject({ status: 'rejected', reason: 'stale' })
    // A semantic score outside the scale, a missing citation, or a citation of something the job never read is not a score.
    expect(memory.submitScore(candidateOf(id, { jobId: 'job-3', semantic: 140 }))).toMatchObject({ status: 'rejected', reason: 'invalidInput' })
    expect(memory.submitScore(candidateOf(id, { jobId: 'job-4', cited: [] }))).toMatchObject({ status: 'rejected', reason: 'invalidInput' })
    expect(memory.submitScore(candidateOf(id, { jobId: 'job-5', cited: [other] }))).toMatchObject({ status: 'rejected', reason: 'invalidInput' })
    // A rule score the service did not compute itself is refused rather than trusted.
    expect(memory.submitScore(candidateOf(id, { jobId: 'job-6', rule: 99 }))).toMatchObject({ status: 'rejected', reason: 'invalidInput' })
    // A candidate computed under a policy this service does not use commits nothing either.
    expect(memory.submitScore(candidateOf(id, { jobId: 'job-7', policy: 'mem-policy-0' }))).toMatchObject({ status: 'rejected', reason: 'unsupported' })
    expect(memory.submitScore(candidateOf('f'.repeat(32), { jobId: 'job-8' }))).toMatchObject({ status: 'rejected', reason: 'unknown' })
    expect(JSON.stringify(memory.record(id))).toBe(committed)
    expect(memory.version).toBe(version)
  })

  it('keeps the committed weight across a restart, and a failed job leaves the previous one in place', () => {
    const id = publish()
    expect(memory.submitScore(candidateOf(id))).toMatchObject({ status: 'created' })
    const first = memory.importance(id)!
    memory.close()
    memory = MemoryService.open({ dir, limits: testLimits(), now: () => '2026-11-06T09:10:00.000Z' })
    expect(memory.importance(id)).toEqual(first)
    // A later evaluation that never produced a candidate leaves the weight the record already has.
    expect(memory.submitScore(candidateOf(id, { jobId: 'job-9', baseVersion: memory.version - 5 }))).toMatchObject({ status: 'rejected' })
    expect(memory.importance(id)).toEqual(first)
  })
})
