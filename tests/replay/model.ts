/**
 * The controlled model the replay makes every call to, in all three shapes the run asks for. It is a fixed function of what a request
 * carries and nothing else: no clock, no randomness, no state between calls. That is what makes the replay reproducible, and it is also
 * what makes the run's cost figures comparable — every strategy's background call is dispatched through the same `llm/stream` waterfall
 * and answered by this one function.
 *
 * Three kinds of request arrive here. A scoring request answers with the importance the scenario assigned to the experience it is about,
 * so the rungs the weights land on are the replay's own choice rather than whatever a provider happened to return. A compression
 * request answers with a gist made of the original's first sentence, repaired with exactly the features the compression principles say a
 * gist may not drop — every clause it adds restates a marker the original itself carries, so it never invents a fact, and everything
 * after the first sentence is what it loses. A rolling request answers with the running digest one of the baselines keeps. Nothing here
 * reads the memory, the scenario's question keys or the other strategies: a model that graded itself would make the whole report
 * circular.
 */
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'

/** The three kinds of request the replay makes. */
export type CallKind = 'importance' | 'compression' | 'rolling'

/** Markers a gist must keep, read from the original exactly as the compression principles state them. */
const NEGATION = /\b(?:not|never|no|none|nobody|nothing|cannot|nor|without)\b|n't/i
const PROHIBITION = /\b(?:do not|don't|does not|doesn't|must not|mustn't|shall not|should not|shouldn't|cannot|can't|may not|never)\b/i
const DATE = /\b\d{4}-\d{2}-\d{2}\b/g

/** Characters of one digest the rolling baseline keeps per experience, which is deliberately far shorter than any original. */
export const ROLLING_ITEM_CHARS = 80
/** Characters of the whole rolling summary, which is the bound that makes it a rolling summary rather than a transcript. */
export const ROLLING_MAX_CHARS = 900
/** The importance a scoring request is answered with when the request's evidence matches no experience the scenario knows. */
const UNKNOWN_SCORE = 40

/** The one message a hand-built background request carries. */
export const textOf = (options: GenerateOptions): string =>
  (options.messages[0]?.content as readonly { type: string; text?: string }[] | undefined)?.map(block => block.text ?? '').join('') ?? ''

/** Which of the three kinds a request is, read from the task its body declares. */
export function kindOf(text: string): CallKind {
  if (text.includes('"task":"rolling"')) return 'rolling'
  if (text.includes('"task":"compression"')) return 'compression'
  return 'importance'
}

/** The first sentence of `text`, which is what the controlled summariser keeps and what a lossy gist stands on. */
export const firstSentence = (text: string): string => {
  const end = text.indexOf('. ')
  return (end < 0 ? text : text.slice(0, end + 1)).trim()
}

/**
 * The gist the controlled compressor writes: the original's first sentence, plus one clause per feature of the original the gist would
 * otherwise have dropped. It keeps what the principles require and nothing more, so what it loses is exactly the tail of the original.
 */
export function gistOf(original: string): string {
  const first = firstSentence(original)
  const added: string[] = []
  if (NEGATION.test(original) && !NEGATION.test(first)) added.push('The step it describes is not reversible.')
  if (PROHIBITION.test(original) && !PROHIBITION.test(first)) added.push('Do not skip it.')
  for (const date of new Set(original.match(DATE) ?? [])) if (!first.includes(date)) added.push(`It was recorded on ${date}.`)
  return [first, ...added].join(' ')
}

/** One evidence entry of a background request, as the memory's own request builders write it. */
interface Evidence { readonly id?: string; readonly at?: string; readonly text?: string }
/** A rolling window: the experiences added since the last digest. */
interface Window { readonly at: string; readonly text: string }
/** A background request, read as far as this model needs it. */
interface Requested {
  readonly job_id?: string
  readonly task?: string
  readonly evidence?: readonly Evidence[]
  readonly previous?: string
  readonly window?: readonly Window[]
}

/** The importance the scenario assigned to the experience a scoring request is about, matched by the text the request carries. */
const scoreOf = (evidence: readonly Evidence[], scores: ReadonlyMap<string, number>): number => {
  const text = evidence[0]?.text ?? ''
  for (const [opening, score] of scores) if (text.startsWith(opening)) return score
  return UNKNOWN_SCORE
}

/**
 * The rolling summary after one window: the previous digest plus one short line per experience, cut to its own bound from the oldest
 * end. A rolling summary keeps the most recent entries and lets the oldest fall off the end, which is exactly the loss a rolling
 * summary imposes and exactly what the replay measures it on.
 */
function rolled(previous: string, window: readonly Window[]): string {
  const entries = [...(previous === '' ? [] : previous.split('\n')), ...window.map(item =>
    `${item.at.slice(0, 7)}: ${firstSentence(item.text).slice(0, ROLLING_ITEM_CHARS)}`)]
  const kept: string[] = []
  let used = 0
  for (const entry of [...entries].reverse()) {
    if (used + entry.length + 1 > ROLLING_MAX_CHARS) break
    kept.unshift(entry)
    used += entry.length + 1
  }
  return kept.join('\n')
}

/**
 * The one reply the controlled model gives: a JSON object for a scoring or compression job, and a plain summary for a rolling request.
 * `scores` maps each experience's own text to the importance the scenario gave it, which is how a scoring request is answered without
 * the model being told which episode it is looking at.
 */
export function replyTo(text: string, scores: ReadonlyMap<string, number>): string {
  const kind = kindOf(text)
  let said: Requested = {}
  try { said = JSON.parse(text) as Requested } catch { said = {} }
  if (kind === 'rolling') return rolled(said.previous ?? '', said.window ?? [])
  const evidence = said.evidence ?? []
  if (kind === 'compression') {
    const sources = evidence.flatMap(item => item.id === undefined ? [] : [item.id])
    return JSON.stringify({ job_id: said.job_id, summary: gistOf(evidence[0]?.text ?? ''), sources })
  }
  const cited = evidence.flatMap(item => item.id === undefined ? [] : [item.id])
  return JSON.stringify({ job_id: said.job_id, score: scoreOf(evidence, scores),
    rationale: 'a controlled assessment of how long this will matter to the same project', cited: cited.slice(0, 1), uncertain: [] })
}

/** Characters a hand-built request took: its one-shot system text, its message and its tool definitions, which is what a budget counts. */
export const charsOf = (options: GenerateOptions): number => {
  const system = options.system === undefined ? '' : typeof options.system === 'string' ? options.system : textOf(options)
  return system.length + textOf(options).length + (options.tools === undefined ? 0 : JSON.stringify(options.tools).length)
}
