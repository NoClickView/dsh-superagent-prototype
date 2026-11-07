/**
 * The three ways of putting remembered material in front of a reader, each cut to the same allowance and each described in one place so
 * the report can never compare a number with a policy it did not run under. All three answer the same question, in the same envelope,
 * and none of them sees the questions' keys.
 *
 * The layered strategy offers what the runtime's own automatic door offers for that question: the reactivation the runtime delivered for
 * the question's own capture, plus routine recall for the question's cues — both read from the live service, both already in the order and
 * at the rung the shipped numeric policy put them. The two baselines are ablations of exactly that corpus: plain retrieval keeps every
 * original and matches by cue with no time term, no rung ladder, no revision standing and no archive, which is the system this effort
 * exists to improve on; the rolling summary keeps one digest rewritten over the whole history. Giving the baselines their own corpus
 * rather than the layered store's is deliberate: the layered store has already forgotten, summarised and possibly released what it holds,
 * and a baseline measured on that residue would be measured on the treatment.
 */
import type { MemoryService } from '../../src/memory/service.ts'
import type { RecallItem, RecallResult } from '../../src/memory/retrieval.ts'
import { cuesOf } from '../../src/memory/retrieval.ts'
import type { Scope } from '../../src/memory/model.ts'
import { fit, type Block, type RecalledItem, type Standing } from './manifest.ts'
import { relevanceOf } from './readers.ts'
import type { Question } from './scenario.ts'

/** Characters of one original a plain-retrieval block shows, which is the same bound recall's own line has. */
export const ORIGINAL_ITEM_CHARS = 400
/** Characters of the rolling digest a reader is handed, which is the whole of what that strategy knows. */
export const ROLLING_ITEM_CHARS_SHOWN = 900

/** One experience the ablation strategies keep for themselves: the raw episode, exactly as the person said it. */
export interface CorpusItem {
  readonly id: string
  readonly at: string
  readonly scope: Scope
  readonly text: string
}

/** Where a recall result's standing sits in the reader's own vocabulary. */
const standingOf = (state: RecallItem['state']): Standing => state

/** One recalled line as an item of the common envelope: the line recall itself renders, standing and all. */
const itemOf = (item: RecallItem): RecalledItem => ({ id: item.id, at: item.occurredAt, standing: standingOf(item.state), text: item.text })

/** The items a recall result offered, in the order the policy ranked them. */
const itemsOf = (result: RecallResult): RecalledItem[] => result.items.map(itemOf)

/**
 * What the layered scheme's automatic door offers for one question: the reactivation the runtime delivered to the main Session for this
 * question's own message (read again from the same service, so the replay measures the door rather than a copy of its output), then
 * routine recall for the question's cues. The reactivation comes first because it is the door that interrupts: it is what a reader with a
 * strong cue would have been handed before it looked anything up. `asked` is the capture of the question itself, left out exactly as
 * `src/app/memory.ts` leaves it out — a question is not evidence about its own answer.
 */
export function layeredBlock(service: MemoryService, scope: Scope, question: Question, allowance: number, asked: string): Block {
  const cues = cuesOf([question.ask])
  const parts: RecalledItem[] = []
  if (cues.length) {
    const woken = service.reactivate({ scope, cues, exclude: [asked], allowanceChars: allowance })
    parts.push(...itemsOf(woken))
    const routine = service.recall({ scope, cues, exclude: [asked], allowanceChars: allowance,
      ...(question.about === undefined ? {} : { at: question.about }) })
    parts.push(...itemsOf(routine))
  }
  const seen = new Set<string>()
  return fit(parts.filter(item => seen.has(item.id) ? false : (seen.add(item.id), true)), allowance)
}

/**
 * What plain original-text retrieval offers: every original it ever saw, scored by the cues it shares with the question and nothing else,
 * newest first among equals. It has no time term, no thresholds and no standing — which is precisely the baseline the layered scheme has
 * to beat to be worth its complexity.
 */
export function originalsBlock(corpus: readonly CorpusItem[], scope: Scope, question: Question, allowance: number): Block {
  const scored = corpus.filter(item => item.scope.project === (scope.project ?? item.scope.project))
    .map(item => ({ item, relevance: relevanceOf(question.ask, item.text) }))
    .filter(entry => entry.relevance > 0)
    .sort((left, right) => right.relevance - left.relevance || right.item.at.localeCompare(left.item.at)
      || left.item.id.localeCompare(right.item.id))
  return fit(scored.map(entry => ({ id: entry.item.id, at: entry.item.at, standing: 'unknown' as const,
    text: entry.item.text.length > ORIGINAL_ITEM_CHARS ? entry.item.text.slice(0, ORIGINAL_ITEM_CHARS) : entry.item.text })), allowance)
}

/**
 * What a rolling summary offers: the one digest it keeps, which is the whole of its knowledge. It has no per-experience standing, so a
 * fact it kept from three years ago reads exactly as current as the one it kept from yesterday — which is the failure mode a rolling
 * summary has and the reason the layered scheme keeps standing apart from text.
 */
export function rollingBlock(summary: string, at: string, allowance: number): Block {
  if (summary.trim() === '') return fit([], allowance)
  const text = summary.length > ROLLING_ITEM_CHARS_SHOWN ? summary.slice(-ROLLING_ITEM_CHARS_SHOWN) : summary
  return fit([{ id: 'rolling-summary', at, standing: 'unknown', text }], allowance)
}
