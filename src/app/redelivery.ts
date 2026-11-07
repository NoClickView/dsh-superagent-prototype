/**
 * The redelivery position: the durable place a capture waits when the receiving boundary refused it, so it can be offered again once
 * the queue has room instead of being dropped and counted. It is a bounded, persisted list of the captures that were not accepted, the
 * two numbers that bound it and the count the bound has cost, and it is the third area of one capacity contract — the store's files,
 * the queue, and this — so every byte the memory keeps stays finite.
 *
 * It keeps the material, not a reference. `inputOf` (`src/app/memory.ts`) assembles a capture from rows a later write changes: a
 * ticket's title, its mandate and the report it ended with, the trigger row a Source may store again, and the disposition its fanout
 * was read from. Re-deriving one at dispatch time would therefore produce a different capture under the same experience id — a
 * different fact, not the one that was refused — and `policy.changed` is not stored anywhere else at all. The payload kept here is
 * exactly the one that would have been enqueued, already clipped by `CAPTURE_MAX_CHARS`, and it carries the stable `experienceId`
 * the queue coalesces on and the store deduplicates by, which is what makes a redelivery and an original unable to both apply.
 */
import { KV, type Key } from '../kv.ts'
import type { ExperienceInput } from '../memory/model.ts'

/** The two bounds one redelivery position is kept inside, read from the machine settings on each use. */
export interface RedeliveryLimits { readonly maxItems: number; readonly maxBytes: number }
/**
 * Where the position is persisted: the one typed key-value record it owns, and the transaction it is written in. It is deliberately
 * not the Store's whole key-value surface — a refusal reads that record and writes it atomically with the business fact whose capture
 * it refused, and needs nothing else of the business.
 */
export interface RedeliveryStore {
  get<V>(name: Key<V>): V | undefined
  set<V>(name: Key<V>, value: V): void
  atomic<T>(operation: () => T): T
}
/** One capture kept for a later delivery: the payload exactly as it would have been queued, its bytes, and when it was refused. */
export interface RefusedCapture { readonly input: ExperienceInput; readonly bytes: number; readonly at: string }
/** The record as it is persisted: the captures kept, oldest first, and how many the bound has cost before them. */
export interface RedeliveryRecord { readonly lost: number; readonly items: readonly RefusedCapture[] }
/**
 * What the position holds, and what its bound has cost: the captures waiting to be offered again, the payload bytes they take, the
 * two numbers that bound them, and how many were evicted as permanently lost. `items` and `bytes` are read from the record itself, so
 * a restart reports the material that really waits rather than a figure this process kept; `full` means the next refusal evicts.
 */
export interface RedeliveryState extends RedeliveryLimits {
  readonly items: number
  readonly bytes: number
  /** Captures evicted to stay inside the bound, since the record was first written: a loss that is counted, never silent. */
  readonly lost: number
  readonly state: 'ready' | 'full'
}
/** Nothing has been refused yet: no captures, and nothing lost. Written once the first refusal needs a place to wait. */
const EMPTY: RedeliveryRecord = Object.freeze({ lost: 0, items: [] as readonly RefusedCapture[] })
/** The payload bytes a list of kept captures takes, which is the unit both bounds are stated in. */
const bytesOf = (items: readonly RefusedCapture[]): number => items.reduce((sum, item) => sum + item.bytes, 0)

/**
 * The bounded, persisted list of captures the receiving boundary refused, and the only door they come back through.
 * `refuse` is called from inside the Engine's transaction, so the intent to remember what was not accepted commits or rolls back with
 * the business fact; `handOver` enqueues the oldest capture and stops holding it in one transaction, so a crash can neither lose it
 * between the two nor keep it in both. Both read and write the one KV record, so nothing here can disagree with what is stored.
 */
export class Redelivery {
  constructor(private readonly store: RedeliveryStore, private readonly limits: () => RedeliveryLimits) {}
  /** What the position holds now, and what its bound has cost so far. */
  state(): RedeliveryState {
    const record = this.read(), limits = this.limits(), bytes = bytesOf(record.items)
    const full = record.items.length >= limits.maxItems || bytes >= limits.maxBytes
    return { items: record.items.length, bytes, ...limits, lost: record.lost, state: full ? 'full' : 'ready' }
  }
  /** The oldest capture still kept, which is the next one a re-offer hands back; absent while none waits. */
  oldest(): RefusedCapture | undefined { return this.read().items[0] }
  /**
   * Keep one capture the boundary refused. A capture larger than the whole byte bound is lost at once and costs the position nothing
   * it already holds: no room can be made for it, and evicting the waiting captures would buy a place it could never take, turning one
   * oversized refusal into a wipe of everything before it. One experience id is one capture waiting, as the queue's own row is, so a
   * later refusal replaces that material in the place it already holds instead of counting the fact a second time. Past either bound
   * the oldest are evicted while the list is over it, and every eviction is counted into `lost`: what a bound costs is permanently
   * gone, so it is reported as a loss rather than dropped in silence.
   */
  refuse(input: ExperienceInput, bytes: number, at: string): number {
    const record = this.read(), limits = this.limits()
    if (bytes > limits.maxBytes) {
      this.store.set(KV.memory.redelivery, { lost: record.lost + 1, items: record.items })
      return 1
    }
    const waiting = record.items.findIndex(item => item.input.id === input.id)
    const kept = waiting < 0 ? record.items
      : record.items.map((item, index) => index === waiting ? { input, bytes, at } : item)
    const items = waiting < 0 ? [...kept, { input, bytes, at }] : [...kept]
    let total = bytesOf(items), lost = 0
    while (items.length > limits.maxItems || total > limits.maxBytes) {
      const evicted = items.shift()
      if (evicted === undefined) break
      total -= evicted.bytes
      lost += 1
    }
    this.store.set(KV.memory.redelivery, { lost: record.lost + lost, items })
    return lost
  }
  /**
   * Hand the oldest capture to `enqueue` and stop holding it, in one transaction: the durable queue row and the record that no longer
   * carries it commit together. Answers whether one was handed over, which is false while nothing waits.
   */
  handOver(enqueue: (input: ExperienceInput) => void): boolean {
    const record = this.read(), [next, ...rest] = record.items
    if (next === undefined) return false
    this.store.atomic(() => {
      enqueue(next.input)
      this.store.set(KV.memory.redelivery, { lost: record.lost, items: rest })
    })
    return true
  }
  /** The record as stored, or the empty one before the first refusal. */
  private read(): RedeliveryRecord { return this.store.get(KV.memory.redelivery) ?? EMPTY }
}
