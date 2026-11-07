/**
 * The controlled model on both sides of the measurement. As a reader it answers a question from one block of evidence, by a rule that
 * is fixed before any run and identical for all three strategies; as a grader it compares that answer with the hand-written key in
 * `scenario.ts`. Neither half consults the memory, the strategy or any model's description of itself, which is what makes the numbers
 * in the report evidence about behaviour rather than a system's opinion of itself (spec Testing Decision 10).
 *
 * The reader is intentionally as simple as a reader can be: it takes the most current evidence that actually matches the question, up
 * to three items, and recites what that evidence says; it says it does not know when nothing matches. It is not clever, and that is the
 * point — it cannot know what the strategy left out, so the score is a fact about what the strategy offered.
 */
import { cuesOf } from '../../src/memory/retrieval.ts'
import { STANDING_RANK, type Block, type RecalledItem } from './manifest.ts'
import { ABSTAIN, type Question, type ReplayScenario } from './scenario.ts'

/** How many distinct cues a piece of evidence must share with a question before a reader may treat it as evidence about it. */
export const MATCH_MIN_CUES = 2
/** Most items a reader will recite, so one wide block cannot answer a question by sheer volume. */
export const READER_MAX_ITEMS = 3

/** Distinct cues `text` shares with the question's own words, which is the whole of the reader's relevance. */
export const relevanceOf = (question: string, text: string): number => {
  const asked = new Set(cuesOf([question]))
  return cuesOf([text]).filter(cue => asked.has(cue)).length
}

/** What one answer turned out to be, measured against the hand-written key rather than against anything the strategy claims. */
export interface Verdict {
  readonly answer: string
  /** Whether the reader said it did not know, whatever the key expected. */
  readonly abstained: boolean
  /** Whether the answer is what the key asked for: every required string and none of the traps. */
  readonly correct: boolean
  /** The stale facts the answer presented as the present, which is the misuse the spec measures separately from correctness. */
  readonly stale: readonly string[]
  /** The details the answer invented, from the question's traps and from version-shaped tokens no episode ever stated. */
  readonly fabricated: readonly string[]
}

/** The answer the controlled reader would give from one block, before it is graded. */
export function answerOf(block: Block, question: Question): string {
  const scored = block.items.map(item => ({ item, relevance: relevanceOf(question.ask, item.text) }))
    .filter(entry => entry.relevance >= MATCH_MIN_CUES)
  if (!scored.length) return ABSTAIN
  // What holds now first: a reader that preferred the best word-match alone would quote what a fact replaced, which is the whole
  // misuse metric — so standing is compared before relevance, exactly as a careful reader compares "is this still true" first.
  const best = Math.max(...scored.map(entry => STANDING_RANK[entry.item.standing]))
  return scored.filter(entry => STANDING_RANK[entry.item.standing] === best)
    .sort((left, right) => right.relevance - left.relevance || right.item.at.localeCompare(left.item.at)
      || left.item.id.localeCompare(right.item.id))
    .slice(0, READER_MAX_ITEMS).map(entry => entry.item.text).join(' ')
}

/** Every version-shaped token an answer names, which is how a fabricated detail is caught without asking a model for its confidence. */
const VERSIONS = /\bv?\d+\.\d+\.\d+\b/g
/** Whether `answer` states `phrase`, ignoring case and collapsing whitespace so a line break is not a different claim. */
const says = (answer: string, phrase: string): boolean =>
  answer.toLowerCase().replace(/\s+/g, ' ').includes(phrase.toLowerCase().replace(/\s+/g, ' '))

/**
 * Grade one answer against the key the scenario holds for its question. The traps are read from the scenario rather than from the
 * answer, so a strategy cannot make itself correct by declining to mention something: the question, not the reply, decides what would
 * have been wrong to say.
 */
export function grade(answer: string, question: Question, scenario: ReplayScenario): Verdict {
  const text = answer.trim()
  const abstained = text === ABSTAIN
  const stated = question.forbidden?.filter(phrase => says(text, phrase)) ?? []
  // A detail is fabricated when it is a version-shaped token no episode stated: that catches an invented release number without asking
  // any model how sure it was.
  const known = new Set(scenario.episodes.flatMap(episode => episode.text.match(VERSIONS) ?? []))
  const invented = [...text.match(VERSIONS) ?? []].filter(token => !known.has(token))
  const fabricated = [...new Set([...stated, ...invented])]
  // A question about now is the only one a replaced claim can be misused in: asking what held in March is asking for the old claim.
  // The phrases are the question's own, drawn from the scenario's declared list of replaced facts, so an answer is not called stale for
  // naming a fact it was never asked about.
  const stale = question.about !== undefined ? [] : [...new Set(question.stale ?? [])].filter(phrase => says(text, phrase))
  const correct = question.expect.kind === 'abstain'
    ? abstained && fabricated.length === 0
    : !abstained && question.expect.must.every(phrase => says(text, phrase)) && fabricated.length === 0 && stale.length === 0
  return { answer: text, abstained, correct, stale, fabricated }
}
