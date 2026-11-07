/**
 * The multi-year replay at the Runtime boundary, and the report it produces: years of experience fed through the real runtime, three
 * strategies held to the same input allowance, ten questions graded against hand-written keys, and the four hard constraints measured on
 * the same run. The replay is slow by the standards of this suite — it feeds a whole scenario through SQLite and the effect queue — so it
 * is deliberately not part of any watchlist; it is run on demand, and the document it is reported in is checked for agreement with the
 * versions this build ships.
 *
 * The pure tests beside the run are what make the run evidence rather than ceremony: the grader is shown to disagree with a wrong answer,
 * and the verdict rule is shown to flip when the numbers it reads are swapped. A verdict computed from the same measurements it judges,
 * by a rule nobody tested, would be no verdict at all.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { RequestRecord } from '../src/app/budget.ts'
import { COMPRESSION_VERSION } from '../src/memory/summary.ts'
import { PRINCIPLES_VERSION } from '../src/memory/background.ts'
import { POLICY_VERSION } from '../src/memory/model.ts'
import { RETENTION } from '../src/memory/archive.ts'
import { ABSTAIN, SCENARIO, TAGS, type Question } from './replay/scenario.ts'
import { answerOf, grade } from './replay/readers.ts'
import { fit, STRATEGIES, type RecalledItem } from './replay/manifest.ts'
import { renderReport, verdictOf } from './replay/report.ts'
import { budgetAuditOf, runReplay, type ReplayReport, type StrategyResult } from './replay/runner.ts'

/** The document the run is reported in. The replay is run on demand; this file names what it must still be true of. */
const REPORT = 'docs/research/multi-year-memory-replay.md'

/** One run, shared by every test in this file: the replay costs seconds, and a second run would measure nothing new. */
const replay: Promise<ReplayReport> = runReplay()

/** One synthetic per-strategy result, so the verdict rule can be exercised on numbers no run produced. */
const synthetic = (overrides: Partial<StrategyResult> & { id: StrategyResult['id'] }): StrategyResult =>
  ({ name: overrides.id, correct: 0, stale: 0, fabricated: 0, abstained: 0, chars: 0, meanChars: 0, maxChars: 0, recallMs: 0, ...overrides })

describe('the replay harness, on its own', () => {
  it('grades an answer against the scenario key rather than against anything the answering side says', () => {
    const question = SCENARIO.questions.find(item => item.id === 'ci-now')!
    expect(grade('the deploy pipeline runs on github actions', question, SCENARIO))
      .toMatchObject({ correct: true, stale: [], fabricated: [], abstained: false })
    // The same answer with the replaced claim in it is what the spec calls stale-fact misuse, and it is not correct however well it reads.
    expect(grade('github actions replaced what runs on jenkins', question, SCENARIO))
      .toMatchObject({ correct: false, stale: ['runs on jenkins'] })
    // Saying nothing is a wrong answer here and the only right one where the memory cannot support an answer.
    expect(grade(ABSTAIN, question, SCENARIO)).toMatchObject({ correct: false, abstained: true })
    const unknown = SCENARIO.questions.find(item => item.id === 'vendor')!
    expect(grade(ABSTAIN, unknown, SCENARIO)).toMatchObject({ correct: true })
    expect(grade('the review terminated the vendor contract at a discount', unknown, SCENARIO).correct).toBe(false)
  })

  it('catches a fabricated version number no episode stated', () => {
    const question = SCENARIO.questions.find(item => item.id === 'threshold')!
    expect(grade('the alert threshold is 70', question, SCENARIO).fabricated).toEqual([])
    expect(grade('the alert threshold is 70 since v2.31.0', question, SCENARIO)).toMatchObject({ correct: false, fabricated: ['v2.31.0'] })
  })

  it('reads the most current evidence first, and quotes every item that ties it', () => {
    const item = (id: string, standing: RecalledItem['standing'], text: string): RecalledItem => ({ id, at: '2026-01-01T00:00:00.000Z', standing, text })
    const question = { id: 'probe', tags: [], at: '2026-11-06T09:00:00.000Z', ask: 'is the nightly job safe to skip on weekends?',
      expect: { kind: 'answer', must: [] } } as unknown as Question
    const block = fit([item('old', 'superseded', 'the nightly job is safe to skip on weekends'),
      item('new', 'current', 'the nightly job is not safe to skip on weekends')], 4000)
    // The replaced claim matches the question's words just as well, and is still not what a reader is given.
    expect(answerOf(block, question)).toBe('the nightly job is not safe to skip on weekends')
    expect(answerOf(fit([], 4000), question)).toBe(ABSTAIN)
  })

  it('never renders a block larger than the allowance it was given, in any of the three strategies', () => {
    const items: RecalledItem[] = [{ id: 'a', at: '2026-01-01T00:00:00.000Z', standing: 'current', text: 'x'.repeat(400) }]
    expect(fit(items, 100).chars).toBeLessThanOrEqual(100)
    expect(fit(items, 100).items).toEqual([])
    expect(fit(items, 4000).chars).toBeLessThanOrEqual(4000)
  })

  it('derives every stale-fact trap from the one declared list of replaced facts', () => {
    // A question may not declare its own opinion about what used to be true: the phrases come from the scenario, so a trap cannot be
    // added that the replayed world never stated.
    for (const question of SCENARIO.questions) {
      for (const phrase of question.stale ?? []) expect(SCENARIO.staleClaims).toContain(phrase)
    }
    expect(SCENARIO.replaced.length).toBeGreaterThan(0)
  })

  it('decides the verdict from the numbers it is given, and flips when they are swapped', () => {
    const loses = verdictOf({ layered: synthetic({ id: 'layered', correct: 2 }),
      originals: synthetic({ id: 'originals', correct: 7 }), rolling: synthetic({ id: 'rolling', correct: 4 }) })
    expect(loses).toMatchObject({ kind: 'loses', against: 'originals', correct: 2, baselineCorrect: 7 })
    const wins = verdictOf({ layered: synthetic({ id: 'layered', correct: 8 }),
      originals: synthetic({ id: 'originals', correct: 7 }), rolling: synthetic({ id: 'rolling', correct: 4 }) })
    expect(wins).toMatchObject({ kind: 'beats', against: 'originals' })
    // A tie is not beating, and a stale-fact advantage never upgrades a verdict that correctness did not earn.
    expect(verdictOf({ layered: synthetic({ id: 'layered', correct: 4, stale: 0 }),
      originals: synthetic({ id: 'originals', correct: 4, stale: 9 }), rolling: synthetic({ id: 'rolling', correct: 1 }) }).kind).toBe('ties')
  })

  it('counts a request the budget refused apart from a request that reached the model over budget', () => {
    // A ledger of the three things the budget can record, on numbers no run produced. The invariant is about what reached the model:
    // a suspension is the budget refusing the request, which is the budget working, so it can never be the violation the constraint
    // counts — the shipped harness counted it as one, which is the definition this test holds the report to. A housekeeping call is
    // in the same two populations: the exemption that used to let one through oversized is gone.
    const record = (action: RequestRecord['action'], total: number, budget = 1000, purpose?: RequestRecord['purpose']): RequestRecord =>
      ({ at: '2026-01-01T00:00:00.000Z', parts: { system: 0, tools: 0, state: 0, history: 0, toolResults: 0, recall: 0 }, reserve: 0, budget,
        total, action, cut: { recall: 0, toolResults: 0, history: 0 }, ...(purpose === undefined ? {} : { purpose }) })
    const audit = budgetAuditOf([record('send', 900), record('send', 1000), record('suspend', 4200), record('suspend', 6100, 1000, 'compaction')])
    expect(audit).toEqual({ requests: 4, sent: 2, violations: 0, suspended: 2, housekeeping: 1 })
    // A send that did reach the model over its budget is the only thing that is a violation, and it is counted with its own population.
    expect(budgetAuditOf([record('send', 1200)])).toMatchObject({ sent: 1, violations: 1 })
    // The exemption is gone, not silent: an oversized housekeeping call counts as the suspension it is, never as a send.
    expect(budgetAuditOf([record('suspend', 3000, 1000, 'session-title')])).toEqual(
      { requests: 1, sent: 0, violations: 0, suspended: 1, housekeeping: 1 })
    expect(budgetAuditOf([])).toEqual({ requests: 0, sent: 0, violations: 0, suspended: 0, housekeeping: 0 })
  })
})

describe('the multi-year replay through the runtime', () => {
  it('runs three strategies over the same years and holds each to the same allowance', async () => {
    const report = await replay
    // The committed document's figures come from the controlled reader: no provider was called to produce them.
    expect(report.answeredBy).toBe('controlled')
    expect(Object.keys(report.strategies).sort()).toEqual([...STRATEGIES].sort())
    // The allowance is the runtime's own answer for the main Session's next request, and no strategy exceeded it anywhere.
    expect(report.budget.allowanceChars).toBeGreaterThan(0)
    for (const id of STRATEGIES) expect(report.strategies[id].maxChars).toBeLessThanOrEqual(report.budget.allowanceChars)
    expect(report.questions).toHaveLength(SCENARIO.questions.length)
    // Every strategy was asked every question, so a missing answer is a failure rather than a smaller denominator.
    for (const question of report.questions) for (const id of STRATEGIES) expect(question.verdicts[id]).toBeDefined()
  }, 180_000)

  it('exercises all eight situations the ticket requires, each with a graded question behind it', async () => {
    const report = await replay
    expect(report.coverage.map(entry => entry.tag)).toEqual([...TAGS])
    for (const entry of report.coverage) {
      expect(entry.questions, `${entry.tag} has no graded question`).toBeGreaterThan(0)
      expect(entry.evidence.length).toBeGreaterThan(0)
    }
  }, 180_000)

  it('holds every hard constraint, and names the ticket whose own spec proves each one', async () => {
    const report = await replay
    const owners: Record<string, string> = { 'over-budget-requests': 'tests/budget.spec.ts', 'write-bypasses': 'tests/memory-isolation.spec.ts',
      'duplicate-applications': 'tests/memory-store.spec.ts', 'interrupted-publication': 'tests/memory-crash.spec.ts' }
    expect(report.constraints).toHaveLength(Object.keys(owners).length)
    for (const constraint of report.constraints) {
      expect(constraint.violations, `${constraint.id}: ${constraint.detail}`).toBe(0)
      // The owning spec has to exist: a claim that another ticket's tests already prove something is checked, not asserted.
      expect(owners[constraint.id]).toBeDefined()
      expect(readFileSync(owners[constraint.id]!, 'utf8').length).toBeGreaterThan(0)
    }
  }, 180_000)

  it('keeps serving while the background is held, and reports the backlog an operator would read', async () => {
    const report = await replay
    // Accepted but not yet accepted-by-the-evaluator: material received while nothing was evaluated is waiting, never dropped.
    expect(report.backlog.held.queued + report.backlog.held.deferred).toBeGreaterThan(0)
    expect(report.backlog.released.queued).toBe(0)
    expect(report.backlog.released.committed).toBeGreaterThan(0)
    expect(report.backlog.released.passes).toBeGreaterThan(0)
    // The bounds are the machine settings the run used, not constants of the harness.
    expect(report.backlog.bounds.maxCalls).toBeGreaterThan(0)
    expect(report.backlog.bounds.concurrency).toBeGreaterThan(0)
    expect(report.backlog.versions.policy).toBe(POLICY_VERSION)
    expect(report.backlog.versions.principles).toContain(PRINCIPLES_VERSION)
    // An upgrade sweep with nothing owed plans nothing; being bounded is why it may still have records to look at.
    expect(report.upgrade.planned).toBe(0)
    expect(report.upgrade.remaining).toBeGreaterThanOrEqual(0)
  }, 180_000)

  it('raises no weight for a fact six messages only restate, and restores one version after the idle stretch', async () => {
    const report = await replay
    expect(report.repetition.records).toBe(7)
    expect(report.repetition.scores).toHaveLength(7)
    // The same fact restated is the same weight every time: a repetition is a delivery, never new evidence about importance.
    expect(new Set(report.repetition.scores).size).toBe(1)
    expect(report.idle.restored).toBe(true)
    expect(report.idle.versionAfter).toBe(report.idle.versionBefore)
    // Eight months with nothing captured is a real gap in the replayed years, not a synonym for "a while".
    const months = (Date.parse(report.idle.to) - Date.parse(report.idle.from)) / (30 * 86_400_000)
    expect(months).toBeGreaterThanOrEqual(7)
  }, 180_000)

  it('renders a report made only of what it measured, and one the committed document agrees with', async () => {
    const report = await replay
    const rendered = renderReport(report)
    // The document is regenerated by the run rather than typed: `REPLAY_WRITE=1` is the only way it is ever written, so a figure in it
    // is always a figure some run produced. Running the replay without it reads the document and writes nothing.
    if (process.env.REPLAY_WRITE === '1') writeFileSync(REPORT, rendered)
    expect(rendered).toContain('| layered |')
    expect(rendered).toContain('| originals |')
    expect(rendered).toContain('| rolling |')
    expect(rendered).toMatch(/\*\*(BEATS|TIES|LOSES)\*\*/)
    expect(rendered).not.toMatch(/<<<<<<<|>>>>>>>/)
    // The document in the repository is written from a run, so what it must still agree with is the build that ships today.
    const document = readFileSync(REPORT, 'utf8')
    for (const version of [POLICY_VERSION, RETENTION.version, PRINCIPLES_VERSION, COMPRESSION_VERSION]) {
      expect(document, `${REPORT} does not name ${version}`).toContain(version)
    }
    for (const id of STRATEGIES) expect(document).toContain(id)
    expect(document).toMatch(/replayed span, not production experience/i)
  }, 180_000)
})
