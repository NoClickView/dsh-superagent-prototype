/**
 * The three shapes every strategy is measured through, so the comparison is about what each one put in front of a reader and never
 * about how it stores what it knows. A `Block` is deliberately small: the evidence items, whether each of them is what currently
 * holds, and the characters the whole thing would take in a model request. Nothing in it names a strategy, a file or a model.
 */

/** Where a claim stands: what the memory knows about whether it still holds. A strategy that tracks no revision reports `unknown`. */
export type Standing = 'current' | 'disputed' | 'unknown' | 'superseded'

/** The order a reader prefers standings in, highest first: what holds now beats what is disputed, which beats what held before. */
export const STANDING_RANK: Readonly<Record<Standing, number>> = { current: 3, disputed: 2, unknown: 2, superseded: 1 }

/** One piece of evidence a strategy offers for one question. */
export interface RecalledItem {
  /** The experience it is evidence of, so two strategies offering the same record can be compared directly. */
  readonly id: string
  /** When the experience happened. */
  readonly at: string
  readonly standing: Standing
  /** What the reader may see: the original, the gist, or the cue line a faded record is left as. */
  readonly text: string
}

/** Everything one strategy puts in front of the reader for one question, and what it would cost the request. */
export interface Block {
  readonly items: readonly RecalledItem[]
  /** Characters of `rendered`, which is the number the request budget would count. */
  readonly chars: number
  readonly rendered: string
}

/** The three strategies the replay compares, named once so a report can never quote a name no run produced. */
export type StrategyId = 'layered' | 'originals' | 'rolling'

/** Every strategy, in the order the report lists them. */
export const STRATEGIES: readonly StrategyId[] = ['layered', 'originals', 'rolling']

/** One value per strategy, as a total record: the report reads these by name rather than by index, so a missing strategy is a compile error. */
export interface ByStrategy<T> {
  readonly layered: T
  readonly originals: T
  readonly rolling: T
}

/** Build one value per strategy, in the order `STRATEGIES` names them. */
export const byStrategy = <T>(make: (id: StrategyId) => T): ByStrategy<T> =>
  ({ layered: make('layered'), originals: make('originals'), rolling: make('rolling') })

/** What one strategy is, in one clause, so a number can always be traced to the policy that produced it. */
export const STRATEGY_NAMES: Readonly<Record<StrategyId, string>> = {
  layered: 'the layered scheme this effort built: versioned weights, a rung ladder, revision standing, gists and a bounded archive',
  originals: 'plain original-text retrieval: every original kept, matched by cue, cut to the same allowance',
  rolling: 'a rolling summary: one text rewritten over the whole history, answered from as it stands',
}

/** Cut `items` so that the rendered block never exceeds `allowance`, keeping the order the strategy offered them in. */
export function fit(items: readonly RecalledItem[], allowance: number): Block {
  const kept: RecalledItem[] = []
  let rendered = ''
  for (const item of items) {
    const next = kept.length === 0 ? render(item) : `${rendered}\n${render(item)}`
    if (next.length > allowance) break
    kept.push(item)
    rendered = next
  }
  return { items: kept, chars: rendered.length, rendered }
}

/** One item as the reader meets it: where and when it came from, whether it still holds, then what it says. */
export const render = (item: RecalledItem): string => `[${item.id}] ${item.at.slice(0, 10)} ${item.standing} · ${item.text}`
