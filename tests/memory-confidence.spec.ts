/**
 * The confidence of one record, as the service stores it: what kind of evidence it is and which independent Sources the same claim
 * reached from, computed once when the record is written and recomputed only by a write. The point of the tests is what it is not:
 * repeated recall, a model's own restatement of the record and a second report from the same Source all leave it exactly where it
 * was, while the same claim from another Source raises it — and it stays a different quantity from the weight the record carries,
 * the correlation one query scored and the state its claim stands in.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MemoryService } from '../src/memory/service.ts'
import { MEMORY_POLICY, ruleScoreOf } from '../src/memory/score.ts'
import type { CompressionCandidate, MemoryRecord, ScoreCandidate } from '../src/memory/model.ts'
import { memoryInput, testLimits } from './fixtures/memory.ts'

/** The claim every record of this file states, word for word: corroboration is about the same fact, not a related one. */
const CLAIM = 'the settings page cache is stale in the release build'
let home: string, dir: string, memory: MemoryService
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'memory-confidence-'))
  dir = join(home, 'memory')
  memory = MemoryService.open({ dir, limits: testLimits(), now: () => '2026-11-06T09:10:00.000Z' })
})
afterEach(() => { memory.close(); rmSync(home, { recursive: true, force: true }) })

/** The published ops of the journal, which is where a stored quantity can be read back from rather than recomputed. */
const journal = (): string => readdirSync(join(dir, 'journal')).filter(name => name.endsWith('.ndjson')).sort()
  .map(name => readFileSync(join(dir, 'journal', name), 'utf8')).join('')
/** One capture, identified by its own event and recorded time, as a Source would deliver it. */
const publish = (primary: string, parts: Parameters<typeof memoryInput>[0] = {}): MemoryRecord => {
  const input = memoryInput({ primary, text: CLAIM, ...parts })
  expect(memory.submit(input)).toMatchObject({ status: 'created' })
  return memory.record(input.id)!
}
/** The gist a compression job would hand the service for `record`, computed from the version it read. */
const gistOf = (record: MemoryRecord, parts: Partial<CompressionCandidate> = {}): CompressionCandidate => ({ jobId: `job-gist-${record.experience.id}`,
  experienceId: record.experience.id, baseVersion: memory.version, text: 'the settings page cache is stale', sourceMap: [record.experience.id],
  version: 'mem-compression-1', model: 'deepseek/deepseek-chat', digest: 'e'.repeat(64), at: '2026-11-06T09:10:00.000Z',
  cited: [record.experience.id], ...parts })
/** The score a background job would hand the service for `record`, computed from the version it read. */
const scoreOf = (record: MemoryRecord, parts: Partial<ScoreCandidate> = {}): ScoreCandidate => {
  const rule = ruleScoreOf(record.experience, MEMORY_POLICY)
  return { jobId: `job-score-${record.experience.id}`, experienceId: record.experience.id, baseVersion: memory.version, semantic: 60,
    rule: rule.score, ruleParts: rule.parts, policy: MEMORY_POLICY.version, principles: 'mem-principles-1', model: 'deepseek/deepseek-chat',
    digest: 'd'.repeat(64), rationale: 'a person reported the defect this record is about', cited: [record.experience.id], uncertain: [],
    at: '2026-11-06T09:10:00.000Z', ...parts }
}

describe('the confidence of one record', () => {
  it('is stored with the record, from the kind of evidence and the one Source it came from', () => {
    const record = publish('feishu:oc_team:om_1')
    expect(record.confidence).toEqual({ score: 0.6, kind: 'observation', origins: ['feishu:oc_team'] })
    expect(memory.confidence(record.experience.id)).toEqual(record.confidence)
    // It is a stored quantity of the record, so the journal op that published it carries it.
    expect(JSON.parse(journal().split('\n').filter(line => line !== '')[0]!) as { record: MemoryRecord })
      .toMatchObject({ record: { confidence: { score: 0.6, kind: 'observation', origins: ['feishu:oc_team'] } } })
    // An inference is evidence about its author's reasoning, not about the world: it supports less than what was observed.
    expect(publish('feishu:oc_team:om_2', { kind: 'inference' }).confidence!.score).toBe(0.3)
  })

  it('stays exactly where it was through any number of reads', () => {
    const record = publish('feishu:oc_team:om_1')
    const before = journal(), version = memory.version
    for (let read = 0; read < 3; read++) {
      expect(memory.recall({ scope: { project: 'acme/widgets' }, cues: ['cache', 'stale'], allowanceChars: 4000 }).items).toHaveLength(1)
      memory.list({ scope: { project: 'acme/widgets' }, offset: 0, limit: 10 })
      memory.expand({ id: record.experience.id, allowanceChars: 4000 })
      memory.status()
    }
    // Reading is not evidence of anything, so no read writes a byte and the stored confidence is the same object value.
    expect(journal()).toBe(before)
    expect(memory.version).toBe(version)
    expect(memory.confidence(record.experience.id)).toEqual({ score: 0.6, kind: 'observation', origins: ['feishu:oc_team'] })
  })

  it('does not move for a model\'s own restatement of the record, or for another report from the same Source', () => {
    const record = publish('feishu:oc_team:om_1')
    // A compression job's gist is the model's own words about the record, committed through the one entry point.
    expect(memory.submitCandidate(gistOf(record))).toMatchObject({ status: 'created' })
    expect(memory.confidence(record.experience.id)).toMatchObject({ score: 0.6, kind: 'observation', origins: ['feishu:oc_team'] })
    // The same words from the same Source are one origin however often they arrive: a second message from the same chat.
    const repeated = publish('feishu:oc_team:om_3')
    expect(repeated.confidence).toMatchObject({ score: 0.6, origins: ['feishu:oc_team'] })
    expect(memory.confidence(record.experience.id)!.score).toBe(0.6)
  })

  it('rises one step when the same claim reaches it from another Source, and counts a Source once', () => {
    const fromFeishu = publish('feishu:oc_team:om_1')
    const fromGithub = publish('github:acme/widgets#issue-7', { source: 'github:acme/widgets', subject: 'the release build' })
    // 0.6 for what was observed, plus one step for a second, independent Source: 0.75.
    expect(fromGithub.confidence).toMatchObject({ score: 0.75, origins: ['feishu:oc_team', 'github:acme/widgets'] })
    // A further report from either Source corroborates anew: the count is of Sources, not of records.
    expect(publish('github:acme/widgets#issue-8', { source: 'github:acme/widgets', subject: 'the release build' }).confidence!.score).toBe(0.75)
    expect(publish('github:acme/widgets#issue-9', { source: 'github:acme/widgets', subject: 'the release build' }).confidence!.origins)
      .toEqual(['feishu:oc_team', 'github:acme/widgets'])
    // A different claim, even from another Source, corroborates nothing: related is not the same fact.
    expect(publish('feishu:oc_team:om_5', { text: 'the export button is broken for every viewer' }).confidence!.score).toBe(0.6)
    // The record written before the second Source is not rewritten by it, and a read still answers what it says.
    expect(memory.confidence(fromFeishu.experience.id)!.origins).toEqual(['feishu:oc_team'])
  })

  it('stays a separate quantity from the weight, the query correlation and the revision state', () => {
    const record = publish('feishu:oc_team:om_1')
    expect(memory.submitScore(scoreOf(record))).toMatchObject({ status: 'created' })
    // The weight the job committed is a judgement about importance; the confidence is what the evidence supports.
    expect(memory.importance(record.experience.id)!.score).toBeGreaterThan(0)
    expect(memory.confidence(record.experience.id)).toMatchObject({ score: 0.6 })
    // The correlation one query scored is this query's own, and reading it changes nothing either.
    const [match] = memory.recall({ scope: { project: 'acme/widgets' }, cues: ['cache', 'stale'], allowanceChars: 4000 }).items
    expect(match!.score).toBeCloseTo(1.05, 6)
    expect(memory.confidence(record.experience.id)!.score).toBe(0.6)
    // A later fact about the same thing moves where the claim stands, and not how well its evidence was supported.
    const successor = memoryInput({ primary: 'feishu:oc_team:om_2', text: 'the settings page cache is now fresh in the release build',
      occurredAt: '2026-11-06T10:00:00.000Z', recordedAt: '2026-11-06T10:00:00.000Z' })
    expect(memory.submit(successor)).toMatchObject({ status: 'created' })
    expect(memory.revision(record.experience.id)).toMatchObject({ status: 'superseded' })
    expect(memory.confidence(record.experience.id)!.score).toBe(0.6)
  })
})
