/**
 * The allowance automatic reactivation runs under: how many notices one Session may receive inside a moving window, and which
 * experiences it has already been shown. A window rather than another counter because the nuisance it bounds is measured in time —
 * what a model reads as background context in one stretch of work — so the quota comes back on its own as the window passes, and
 * getting it back requires neither a restart nor anything the agent does. The state belongs to one process: a restart begins a fresh
 * window, and the delivery layer's own message ids are what make that safe, because a notice a crash redelivers lands no second copy.
 */

/** What became of one cue, which is how a non-wake is told from another: the allowance, a duplicate, too little correlation, no room. */
export type WakeOutcome = 'delivered' | 'no-cue' | 'quota' | 'no-room' | 'weak' | 'duplicate' | 'failed'

/** The limits one allowance runs under, read on each use so a lowered bound applies to the next cue rather than to the next restart. */
export interface WakeLimits {
  /** Notices one window holds. */
  readonly wakes: number
  /** How long one notice keeps counting, in milliseconds. */
  readonly windowMs: number
}

/** One experience a notice carried, at the version its record held when the notice landed: the pair the dedupe is keyed by. */
export interface WakeItem {
  readonly id: string
  readonly version: number
}

/** What the newest cue became, and the instant it was read, so a non-wake is explained rather than left as silence. */
export interface WakeEvent {
  readonly at: string
  readonly outcome: WakeOutcome
  /** One sentence naming the reason, with the numbers behind it where the allowance changed the answer. */
  readonly detail: string
}

/** The allowance as the memory reports it: what still counts, when it comes back, and what the newest cue became. */
export interface WakeState {
  /** Notices that landed inside the window and have not yet aged out of it. */
  readonly notices: number
  /** Notices one whole window holds. */
  readonly capacity: number
  readonly windowMs: number
  /** The instant the oldest notice that still counts stops counting, so the next one may land; absent while the quota has room. */
  readonly nextAt?: string
  readonly last?: WakeEvent
}

/**
 * Most experiences the dedupe holds at once, so years of operation cannot grow it: past this the least recently shown is let go,
 * which is one of the two ways an unchanged experience becomes wakeable again.
 */
export const WAKE_DEDUPE_MAX = 256
/**
 * How many windows the dedupe remembers an experience for, which is the other bound on that state and its own "may be shown again"
 * rule: shown once, an unchanged record stays shown for this long and may be pushed again afterwards, without anything having changed
 * but the passage of time the allowance itself is measured in.
 */
export const WAKE_DEDUPE_WINDOWS = 8

/**
 * The allowance, the dedupe it keeps, and the record of what the newest cue became. `held` is asked before anything is matched, so an
 * exhausted window costs no retrieval; `record` is called only once a notice reached the delivery door, so a cue whose delivery failed
 * consumes nothing, remembers nothing, and stays owed to the retry the queue makes.
 */
export class WakeAllowance {
  /** The instants the notices landed at, oldest first; one older than the window has stopped counting and is let go. */
  private readonly landed: number[] = []
  /** What this Session was shown, by experience: the version it was shown at and when, in the order it was shown. */
  private readonly seen = new Map<string, { readonly version: number; readonly at: number }>()
  private last: WakeEvent | undefined
  constructor(private readonly limits: () => WakeLimits) {}

  /**
   * The notices that still count at `instant`, keeping the state bounded as it goes: a notice stops counting exactly one window after
   * it landed, so the allowance refills notice by notice instead of in one burst at a boundary.
   */
  private counting(instant: number): readonly number[] {
    const window = this.limits().windowMs
    let stale = 0
    while (stale < this.landed.length && this.landed[stale]! <= instant - window) stale += 1
    if (stale) this.landed.splice(0, stale)
    return this.landed
  }
  /**
   * The instant one more notice may land, from the notices that count: the capacity is spent when they fill it, and the notice that has
   * to age out is the oldest one over the capacity rather than simply the oldest — a capacity lowered while notices still count does not
   * make the allowance wait for the whole window.
   */
  private boundary(counting: readonly number[], wakes: number, windowMs: number): number | undefined {
    const over = counting.length - wakes
    return over < 0 ? undefined : counting[Math.max(0, over)]! + windowMs
  }
  /** Let go of what the dedupe no longer remembers: one older than its retention, then the least recently shown over its capacity. */
  private forget(instant: number): void {
    const oldest = instant - WAKE_DEDUPE_WINDOWS * this.limits().windowMs
    for (const [id, entry] of this.seen) if (entry.at <= oldest) this.seen.delete(id)
    for (const id of this.seen.keys()) {
      if (this.seen.size <= WAKE_DEDUPE_MAX) return
      this.seen.delete(id)
    }
  }
  /**
   * Whether a notice may land at `at`, and, when it may not, the sentence saying so: the allowance is what holds it, and when the
   * next notice may land. It is a sentence rather than a flag because the only reason the allowance ever gives is the one an operator
   * needs the number for.
   */
  held(at: string): string | undefined {
    const instant = Date.parse(at), counting = this.counting(instant), { wakes, windowMs } = this.limits()
    const boundary = this.boundary(counting, wakes, windowMs)
    if (boundary === undefined) return undefined
    const next = new Date(boundary).toISOString()
    return `it was held back: the allowance is spent, and the next notice may land at ${next}`
  }
  /**
   * Whether this Session was already shown this experience at this version, which is what keeps an unchanged record from being pushed
   * twice. The answer depends on what the dedupe still remembers, so showing it again is a matter of a record that changed or of a
   * memory that the retention or the capacity let go — never of a cue being repeated.
   */
  shown(id: string, version: number, at: string): boolean {
    this.forget(Date.parse(at))
    return this.seen.get(id)?.version === version
  }
  /**
   * One notice landed at `at` and carried these experiences. Only what reached the delivery door is counted, so an attempt that threw
   * leaves the allowance as it was and the retry spends the one notice it would have spent.
   */
  record(at: string, items: readonly WakeItem[]): void {
    const instant = Date.parse(at), { wakes } = this.limits()
    this.landed.push(instant)
    this.counting(instant)
    // What still counts is at most the capacity, a lowered one included: anything older than that can no longer change the answer.
    if (this.landed.length > wakes) this.landed.splice(0, this.landed.length - wakes)
    for (const item of items) {
      // Re-inserted, so the order the capacity lets go by is the order things were last shown.
      this.seen.delete(item.id)
      this.seen.set(item.id, { version: item.version, at: instant })
    }
    this.forget(instant)
    this.last = { at, outcome: 'delivered', detail: `it woke ${items.length} ${items.length === 1 ? 'experience' : 'experiences'}` }
  }
  /** What became of the newest cue, for the count and the sentence: the memory's one record of why a cue did or did not wake anything. */
  note(at: string, outcome: WakeOutcome, detail: string): void {
    this.last = { at, outcome, detail }
  }
  /** The allowance and the dedupe as an operator reads them, with what the window has already let go of left out. */
  state(at: string): WakeState {
    const instant = Date.parse(at), counting = this.counting(instant), { wakes, windowMs } = this.limits()
    const boundary = this.boundary(counting, wakes, windowMs)
    this.forget(instant)
    return { notices: counting.length, capacity: wakes, windowMs,
      ...(boundary === undefined ? {} : { nextAt: new Date(boundary).toISOString() }),
      ...(this.last === undefined ? {} : { last: this.last }) }
  }
}
