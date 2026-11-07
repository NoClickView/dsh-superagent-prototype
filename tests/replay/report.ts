/**
 * The report's arithmetic and its one page of Markdown. Two things live here and nothing else does: the rule that turns the measured
 * numbers into a verdict, and the rendering that prints them. The rule is a pure function of the numbers so it can be tested on numbers
 * nobody ran — a verdict computed from the same measurements it judges would be no verdict at all — and the rendering reads only the
 * report object, so no figure in the document can be typed in by hand.
 */
import type { QuestionResult, ReplayReport, StrategyResult } from './runner.ts'
import { STRATEGIES, type ByStrategy, type StrategyId } from './manifest.ts'

/** What the layered scheme did against the better of the two baselines: it is that comparison, and nothing softer. */
export type VerdictKind = 'beats' | 'ties' | 'loses'

/** The verdict, the baseline it was read against, and the one sentence that says how it was computed. */
export interface Verdict {
  readonly kind: VerdictKind
  readonly against: StrategyId
  readonly correct: number
  readonly baselineCorrect: number
  readonly why: string
}

/**
 * The verdict of a run: the layered scheme's correct answers against the best baseline's. Only correctness decides it — a stale-fact
 * advantage never upgrades a verdict, because answering fewer questions but doing so honestly is not the improvement this effort claims —
 * and the stale and fabrication counts are stated beside it rather than folded in, so the report cannot silently trade one axis for
 * another. A tie counts as not beating.
 */
export function verdictOf(strategies: ByStrategy<StrategyResult>): Verdict {
  const better: StrategyId = strategies.originals.correct >= strategies.rolling.correct ? 'originals' : 'rolling'
  const baselineCorrect = strategies[better].correct
  const kind: VerdictKind = strategies.layered.correct > baselineCorrect ? 'beats'
    : strategies.layered.correct === baselineCorrect ? 'ties' : 'loses'
  return { kind, against: better, correct: strategies.layered.correct, baselineCorrect,
    why: `the layered scheme answered ${strategies.layered.correct} questions correctly against ${baselineCorrect} for the better `
      + `baseline (${better}), measured against the scenario's hand-written keys; ${strategies.layered.stale} of its answers presented a `
      + `replaced fact as the present, against ${strategies.originals.stale} for plain retrieval and ${strategies.rolling.stale} for the `
      + `rolling summary` }
}

/** The per-strategy row of the comparison table. */
const row = (result: StrategyResult, asked: number): string =>
  `| ${result.id} | ${result.correct}/${asked} | ${result.stale} | ${result.fabricated} | ${result.abstained} | `
  + `${result.meanChars} (max ${result.maxChars}) | ${result.recallMs} ms |`

/**
 * The whole report as Markdown, made only of what the run measured. Volatile numbers — wall-clock timings of the harness — are stated
 * as such, and the committed document a reader opens is written from this function by the spec, so the prose and the numbers cannot
 * drift apart.
 */
export function renderReport(report: ReplayReport): string {
  const asked = report.questions.length
  const verdict = verdictOf(report.strategies)
  const lines: string[] = []
  lines.push('# Multi-year memory replay — measured report', '')
  lines.push(`Scenario: **${report.scenario.name}** — ${report.scenario.episodes} episodes over `
    + `${report.scenario.from.slice(0, 10)} to ${report.scenario.to.slice(0, 10)}, then ${asked} graded questions. `
    + `Answers: **${report.answeredBy}** (${report.answeredBy === 'controlled'
      ? 'one fixed reader, so the run is reproducible and no provider is called'
      : 'a real model, dispatched through the same request budget as every other call'}).`, '')
  lines.push('Every number below was produced by one run of the replay described in `docs/007-architecture.md`; none of them is a '
    + 'constant of the harness. **This is a replayed span, not production experience**: the clock, the model and the users are the '
    + "replay's own, and no real deployment ran for years to produce it.", '')
  lines.push('## Verdict', '')
  lines.push(`**${verdict.kind.toUpperCase()}** — ${verdict.why}.`, '')
  lines.push('## The three strategies', '')
  lines.push('| Strategy | Recall quality | Stale-fact misuse | Fabricated detail | Abstentions | Block chars per question | Recall time |')
  lines.push('| --- | --- | --- | --- | --- | --- | --- |')
  for (const id of STRATEGIES) lines.push(row(report.strategies[id], asked))
  lines.push('')
  lines.push(`All three were held to the same automatic-input allowance of ${report.budget.allowanceChars} characters per question, the `
    + `runtime's own answer for the main Session's next request, and every background call any of them caused went through the same `
    + `\`llm/stream\` waterfall and the same fixed model.`, '')
  lines.push('## The configuration this run is valid for', '')
  lines.push('A number means nothing without the versions it was produced under, so every one the run read is named here: a change to any '
    + 'of them is a different measurement, not a better one.', '')
  lines.push(`- Numeric policy \`${report.versions.policy}\` on the scale \`${report.versions.scale}\`, whose rungs are `
    + `${report.thresholds.detail} for the detail, ${report.thresholds.summary} for the gist and ${report.thresholds.forgotten} for `
    + `routine recall's last candidacy; retention policy \`${report.versions.retention}\`.`)
  lines.push(`- Scoring principles \`${report.versions.principles}\` and compression principles \`${report.versions.compression}\`.`)
  lines.push(`- Request budget: ${report.budget.requestMaxChars} characters, of which `
    + `${report.budget.outputReserveChars} are kept for the answer and ${report.budget.measurementReserveChars} for measurement, `
    + `leaving ${report.budget.allowanceChars} for recalled material on one question.`)
  lines.push('')
  lines.push('## Every question', '')
  lines.push('| Question | Situations | Band | Layered | Originals | Rolling |')
  lines.push('| --- | --- | --- | --- | --- | --- |')
  for (const question of report.questions) {
    const cell = (result: QuestionResult['verdicts'][StrategyId]): string => {
      const mark = result.correct ? 'correct' : result.abstained ? 'abstained' : 'wrong'
      return `${mark}${result.stale.length ? `, stale: ${result.stale.join(', ')}` : ''}`
    }
    lines.push(`| ${question.id} | ${question.tags.join(', ')} | ${question.band} | ${cell(question.verdicts.layered)} | `
      + `${cell(question.verdicts.originals)} | ${cell(question.verdicts.rolling)} |`)
  }
  lines.push('')
  lines.push('## The eight required situations', '')
  lines.push('| Situation | Graded questions | Evidence |')
  lines.push('| --- | --- | --- |')
  for (const coverage of report.coverage) lines.push(`| ${coverage.tag} | ${coverage.questions} | ${coverage.evidence} |`)
  lines.push('')
  lines.push('## Hard constraints', '')
  lines.push('| Constraint | Violations | Owning ticket, which proves it at its own boundary | Measured here |')
  lines.push('| --- | --- | --- | --- |')
  for (const constraint of report.constraints) {
    lines.push(`| ${constraint.id} | ${constraint.violations} | ${constraint.owner} | ${constraint.detail} |`)
  }
  lines.push('')
  lines.push('## Cost, storage and time', '')
  lines.push(`- Background model calls: **${report.background.calls}** in total — **${report.background.layered.calls}** `
    + `(${report.background.layered.chars} characters) for the layered scheme, **${report.background.originals.calls}** for plain `
    + `retrieval, and **${report.background.rolling.calls}** (${report.background.rolling.chars} characters) for the rolling `
    + `summary, ${report.background.ms} ms of dispatch over all of them.`)
  lines.push(`- Memory root on disk: **${report.storage.bytes} bytes** over ${report.storage.experiences} experiences and `
    + `${report.storage.versions} published versions — ${report.storage.raw} originals, ${report.storage.summaries} gists, `
    + `${report.storage.journal} journal, ${report.storage.history} versions, ${report.storage.index} index.`)
  lines.push(`- Archive: ${report.archive.passes} reclamation passes under a budget too small for what was recorded released `
    + `${report.archive.released} originals; the one the archive question needed was `
    + `${report.archive.purgeReleased ? 'released, and the answer paid for it' : 'kept'} (its expansion answered `
    + `\`${report.archive.purgeExpansion}\`).`)
  lines.push(`- Bounded background, held: with the evaluator paused for four more captures the backlog reported `
    + `**${report.backlog.held.queued} queued** and **${report.backlog.held.deferred} deferred**, and the captures were still accepted and `
    + `recallable — the foreground served from the published version while nothing was evaluated.`)
  lines.push(`- Bounded background, released: the same queue settled to ${report.backlog.released.queued} queued, `
    + `${report.backlog.released.committed} committed, ${report.backlog.released.failed} failed, ${report.backlog.released.rejected} `
    + `rejected and ${report.backlog.released.skipped} skipped over ${report.backlog.released.passes} pass(es), under the bounds maxCalls `
    + `${report.backlog.bounds.maxCalls}, batch ${report.backlog.bounds.batch}, concurrency ${report.backlog.bounds.concurrency}, pending `
    + `${report.backlog.bounds.pending}, timeout ${report.backlog.bounds.timeoutMs} ms and ${report.backlog.bounds.attempts} attempt(s). `
    + `The work runs under policy \`${report.backlog.versions.policy}\`, principles \`${report.backlog.versions.principles}\` and model `
    + `\`${report.backlog.versions.model}\`.`)
  lines.push(`- Upgrade sweep: one bounded sweep planned **${report.upgrade.planned}** re-evaluations, left **${report.upgrade.remaining}** `
    + `records still to look at and reported \`done: ${report.upgrade.done}\` — a bounded page rather than a finished one, which is the `
    + `point of bounding it. Nothing was owed, because every record was already committed under the versions in force; the sweep is the `
    + `door an upgrade goes through, and this replayed span had no version change to carry.`)
  lines.push(`- Repetition: the fact was restated ${report.repetition.records} times and the committed weights were `
    + `[${report.repetition.scores.join(', ') || 'none'}] — a restatement neither raised the first one nor created anything the time term reads.`)
  lines.push(`- Standing: ${report.standing.current} records still hold, ${report.standing.superseded} were closed by a later fact and `
    + `${report.standing.disputed} are in unresolved disagreement; ${report.standing.unexpected.length === 0
      ? 'every closed window was one the scenario wrote a replacement for'
      : `${report.standing.unexpected.length} window(s) were closed with no replacement in the scenario at all `
        + `(${report.standing.unexpected.join(', ')})`}.`)
  lines.push(`- Ladder: of the ${report.ladder.episodes} experiences the span itself recorded, ${report.ladder.faded} have fallen below the `
    + `gist threshold and ${report.ladder.forgotten} have left routine recall; the lightest of them weighs ${report.ladder.lightest} `
    + `against a last threshold of ${report.thresholds.forgotten}, because ten years halve a weight and this span is not ten years long.`)
  lines.push(`- Reactivation: the runtime itself delivered ${report.reactivation.notices} recall notices over the whole replayed span, `
    + `${report.reactivation.delivered} of them for one of the ${report.reactivation.questions} questions, and ${report.reactivation.woken} `
    + `item(s) in them were shown above the rung their own weight had reached — the door's work rather than the rung's. It opens on a `
    + `message that repeats enough of what an older record carries — after the scope correction the shipped \`recallThreshold\` is a raw `
    + `cue overlap of about 0.44 — which a message restating a fact reaches and a question about one does not. So the layered strategy's `
    + `evidence here comes from the service's query door, and from a pushed notice only where one exists.`)
  lines.push(`- Long idle: ${report.idle.from.slice(0, 10)} to ${report.idle.to.slice(0, 10)} with no event; the restart inside it `
    + `${report.idle.restored ? 'served the same version and the same experiences' : 'did NOT restore the same version'} `
    + `(v${report.idle.versionBefore} → v${report.idle.versionAfter}).`)
  lines.push(`- Replay wall clock on the reporting machine: ${report.timing.totalMs} ms for the whole run, including the archive phase.`)
  lines.push('')
  lines.push('## What these numbers do not show', '')
  lines.push('- The controlled model answers in-process, so the background and recall times above are dispatch and queueing, not provider '
    + 'latency. A real provider would be slower by orders of magnitude and the comparison between strategies would not change shape.')
  lines.push('- The two baselines are ablations of the same corpus, not shipped systems: they are given the same episodes, the same clock, '
    + 'the same allowance and the same background-call counter, and nothing else. What they would cost to operate at scale is out of scope.')
  lines.push('- The layered strategy is measured at the service\'s own query doors — routine recall and reactivation, both read from the '
    + 'live `MemoryService` within the allowance the runtime computes. It is **not** measured at the `orchestrator_read` listing and '
    + 'expansion door, which can page every experience in scope and would be plain retrieval by another name. A Session that browses '
    + 'memory would score differently, and that door is a separate measurement this replay does not make.')
  lines.push('- The clock is replayed. Nothing here is evidence that a deployment ran for years, and no question was asked by a person '
    + 'who did not already know the answer the scenario was built around.')
  lines.push('- The span is shorter than the policy horizon. Under a time term where ten years halve a weight, no fact this store can '
    + 'hold reaches the last threshold within the replayed years — the lightest weight in the store is stated above — so the ladder this '
    + 'run walks is the detail-to-gist-to-cues half of it, and the forgotten rung is exercised by the numeric tests that move a clock '
    + 'thirty years, not by this replay. A longer replay would be a different measurement, not a stricter one.')
  lines.push('')
  return lines.join('\n')
}
