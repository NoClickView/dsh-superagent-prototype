/**
 * Signals that an effect cannot run right now, such as when processing is paused or all worker slots are full.
 * Effects reschedules the row after the initial retry delay without incrementing its failure count, and DshExecutor throws it from launch and delivery handlers.
 */
export class Later extends Error {}
/** Consecutive failures before an effect kind reports an error, matching the Sources poll failure threshold. */
export const FAILURES_BEFORE_ERROR = 3
import type { HealthBoard, HealthEntry } from '../infra/health.ts'
import type { ExperienceInput } from '../memory/model.ts'
import type { Store } from './store.ts'

export interface EffectPayloads {
  /** Build an Eval's candidate card and relay it to the main Session; the key is the Eval ID. */
  assessment: { triggerId: string }
  /** Launch a pending Assignment; the key is the Assignment ID. */
  launch: { ticketId: string; assignmentId: string }
  /** Hand a ticket's waiting Inputs to its running Assignment; the key is the Ticket ID. */
  delivery: { ticketId: string }
  /** Steer a report or a candidate into the main Session; the key is the request ID. */
  relay: { text: string }
  /** Inject a notice into the main Session without waking it; the key names what it reports, such as `prompts`. */
  notice: { value: Record<string, unknown>; summary: string }
  /** Send a message for a Channel through its Source; the key is the message ID, whose receipt the Outbox keeps. */
  reply: Record<string, never>
  /**
   * Record one captured experience in the long-term memory; the key is the experience ID, so a redelivery coalesces. Its payload is
   * the largest this queue carries — one capture, with original text already clipped by `CAPTURE_MAX_CHARS` — and it is the material
   * that waits when the memory store cannot take a commit yet. Its total cost is bounded by the capture's own admission, which
   * measures this kind's occupancy through `occupancy` before it writes here.
   */
  memory: ExperienceInput
}
export type EffectKind = keyof EffectPayloads
interface Handler<K extends EffectKind> {
  run: (payload: EffectPayloads[K], key: string) => Promise<void>
  /** How many may run at once now; 0 holds the kind, such as while processing is paused. */
  limit: () => number
  /** Initial and maximum retry backoff delays, in milliseconds. */
  retry: readonly [number, number]
  /** Effects run one at a time in queue order, and a failed one holds back later rows of the same kind. */
  ordered: boolean
  /** When true, repeated failures do not mark the effect kind's health entry as `error` (used when failures are already surfaced on a ticket). */
  quiet: boolean
}
type Options<K extends EffectKind> = Partial<Pick<Handler<K>, 'limit' | 'retry' | 'ordered' | 'quiet'>>
/** `seq` preserves the row's queue position; `generation` increments on payload updates so a running attempt does not delete a newer payload. */
interface Row { key: string; value: string; seq: number; generation: number; attempts: number; due: number }
type Task = { kind: EffectKind; key: string; done: Promise<void> }
/**
 * What one kind of effect holds in the durable queue: the rows waiting, the payload bytes they take, and whether one key already
 * waits. It is read from the queue itself, so a caller that has to decide whether one more row fits measures what is really stored
 * rather than a count it kept in memory, which a restart would lose and a second writer would not see.
 */
export interface QueueOccupancy {
  readonly items: number
  /** Bytes of the stored payloads, which is what waiting material really costs the database. */
  readonly bytes: number
  /** Whether the key asked about already waits, in which case one more row would replace it rather than add to the queue. */
  readonly held: boolean
}
/**
 * Told that one row of a kind is really gone, after the queue deleted it; `key` is the row's own key. It is the notification a caller
 * acts on when it has material to offer into the place that row held, because nothing earlier is a release.
 */
export type ReleaseListener = (key: string) => void

/**
 * Durable SQLite-backed queue that persists side effects inside command transactions and dispatches them after commit.
 * Coordinates per-kind handlers, concurrency limits, exponential backoff, the release notification a caller offers waiting material
 * into, and health reporting for MasterAssessor, DshExecutor, Sessions, and Outbox.
 */
export class Effects {
  private readonly handlers = new Map<EffectKind, Handler<never>>()
  private readonly health = new Map<EffectKind, HealthEntry>()
  private readonly tasks = new Set<Task>()
  /** Kinds whose last dispatch failed; the next dispatch that succeeds refreshes their health. */
  private readonly broken = new Set<EffectKind>()
  /** Who to tell when a row of one kind is really gone, per kind: the callers that may offer material into the place it held. */
  private readonly releases = new Map<EffectKind, Set<ReleaseListener>>()
  private seq: number
  private scheduled = false
  /** Effects run only between `start` and `drain`; rows queued before `start` wait, such as while setup is incomplete. */
  private started = false
  private stopped = false
  constructor(private readonly store: Store, private readonly board: Pick<HealthBoard, 'claim'>, private readonly now = () => Date.now()) {
    this.seq = Number(store.db.prepare('SELECT IFNULL(MAX(seq), 0) AS seq FROM effect').get()?.seq ?? 0)
  }
  /** Upserts an effect in the caller's transaction, coalescing with any waiting row of the same kind and key while keeping its queue position. */
  enqueue<K extends EffectKind>(kind: K, key: string, payload: EffectPayloads[K]): void {
    this.store.db.prepare(`INSERT INTO effect (kind, key, value, seq, due, since) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(kind, key) DO UPDATE
      SET value = excluded.value, generation = generation + 1, attempts = 0, error = '', due = excluded.due`)
      .run(kind, key, JSON.stringify(payload), ++this.seq, this.now(), new Date(this.now()).toISOString())
    this.kick()
  }
  handle<K extends EffectKind>(kind: K, run: Handler<K>['run'], options: Options<K> = {}): void {
    if (this.handlers.has(kind)) throw new Error(`The ${kind} effects already have a handler`)
    this.health.set(kind, this.board.claim(kind))
    const { limit = () => 1, retry = [2000, 60_000], ordered = false, quiet = false } = options
    this.handlers.set(kind, { run, limit: ordered ? () => Math.min(1, limit()) : limit, retry, ordered, quiet } as unknown as Handler<never>)
    this.report(kind)
    this.kick()
  }
  pending(kind: EffectKind, key?: string): boolean {
    return key === undefined ? !!this.store.db.prepare('SELECT 1 FROM effect WHERE kind = ? LIMIT 1').get(kind) : !!this.store.db.prepare('SELECT 1 FROM effect WHERE kind = ? AND key = ?').get(kind, key)
  }
  /**
   * What one kind's waiting rows hold now: the rows, the payload bytes they take, and whether `key` already waits. One statement, so
   * a caller that decides whether one more row fits reads a single consistent answer, and reads it from the queue rather than from a
   * counter of its own — a restart changes nothing about what it reports. The bytes are the UTF-8 bytes of the stored payloads
   * (`LENGTH(CAST(value AS BLOB))`), which is the unit admission charges a payload in; SQLite's `LENGTH` over a text value counts
   * characters, and a ceiling stated in bytes and read that way holds three times its stated size for text that is not ASCII. The key
   * that is asked about is bound as NULL rather than as an empty string, so a row whose key is empty is not held by a question that
   * named no key.
   */
  occupancy(kind: EffectKind, key?: string): QueueOccupancy {
    const row = this.store.db.prepare(`SELECT COUNT(*) AS items, IFNULL(SUM(LENGTH(CAST(value AS BLOB))), 0) AS bytes,
      EXISTS(SELECT 1 FROM effect WHERE kind = ? AND key IS ?) AS held FROM effect WHERE kind = ?`).get(kind, key === undefined ? null : key, kind)
    return { items: Number(row?.items ?? 0), bytes: Number(row?.bytes ?? 0), held: Number(row?.held ?? 0) === 1 }
  }
  /**
   * Subscribe to one kind's rows being really gone, and get back the function that stops the subscription. The listener is told after
   * `attempt` deleted the row, which is the first moment the queue position and the payload bytes the row held are free; a delivery's
   * own return is not that moment, because the row is deleted only once the handler resolves, and a handler that fails, throws `Later`
   * or is cut short by a shutdown keeps it queued. A caller that offers waiting material into the room a delivery is giving up must
   * therefore act here, from the queue's own reading, rather than subtract a row it assumes is gone.
   */
  released(kind: EffectKind, listener: ReleaseListener): () => void {
    const listeners = this.releases.get(kind) ?? new Set<ReleaseListener>()
    listeners.add(listener)
    this.releases.set(kind, listeners)
    return () => { listeners.delete(listener) }
  }
  /** Drops a queued row by kind and key; if it is already running, that attempt finishes normally. */
  cancel(kind: EffectKind, key: string): void {
    this.store.db.prepare('DELETE FROM effect WHERE kind = ? AND key = ?').run(kind, key)
    this.store.afterCommit(() => { this.report(kind) })
  }
  start(): void { this.started = true; this.kick() }
  kick(): void {
    if (this.scheduled) return
    this.scheduled = true
    queueMicrotask(() => { this.scheduled = false; this.dispatch() })
  }
  /** Resolves once no effect of `kind` (or of any kind) is running and none can start because none is due or `limit()` has no room. */
  async idle(kind?: EffectKind): Promise<void> {
    for (;;) {
      this.dispatch()
      const running = [...this.tasks].filter(task => kind === undefined || task.kind === kind).map(task => task.done)
      if (!running.length) return
      await Promise.allSettled(running)
    }
  }
  /** Stops starting new effects and waits for running ones; waiting rows remain in SQLite for the next start. */
  async drain(): Promise<void> {
    this.stopped = true
    await Promise.allSettled([...this.tasks].map(task => task.done))
  }
  private dispatch(): void {
    if (!this.started || this.stopped) return
    for (const [kind, handler] of this.handlers) {
      try {
        const running = new Set([...this.tasks].filter(task => task.kind === kind).map(task => task.key))
        // Ordered kinds block behind their oldest row even when it is not yet due; limit() is queried only after ready rows exist.
        const rows = (handler.ordered
          ? this.store.db.prepare('SELECT key, value, seq, generation, attempts, due FROM effect WHERE kind = ? ORDER BY seq LIMIT 1').all(kind)
          : this.store.db.prepare('SELECT key, value, seq, generation, attempts, due FROM effect WHERE kind = ? AND due <= ? ORDER BY seq LIMIT ?')
            .all(kind, this.now(), 16 + running.size)) as unknown as Row[]
        const ready = handler.ordered && running.size ? [] : rows.filter(row => row.due <= this.now() && !running.has(row.key))
        let room = ready.length ? handler.limit() - running.size : 0
        for (const row of ready) {
          if (room-- <= 0) break
          this.run(kind, handler, row)
        }
        if (this.broken.delete(kind)) this.report(kind)
      } catch (error) { this.failed(kind, error) }
    }
  }
  private run(kind: EffectKind, handler: Handler<never>, row: Row): void {
    const task: Task = { kind, key: row.key, done: Promise.resolve() }
    task.done = this.attempt(kind, handler, row)
      .catch((error: unknown) => { this.failed(kind, error) })
      .finally(() => { this.tasks.delete(task); this.kick() })
    this.tasks.add(task)
  }
  private async attempt(kind: EffectKind, handler: Handler<never>, row: Row): Promise<void> {
    let failure: { error: unknown } | undefined
    try { await handler.run(JSON.parse(row.value) as never, row.key) } catch (error) { failure = { error } }
    // Match seq and generation so a row replaced or re-queued while running is not overwritten.
    const own = 'kind = ? AND key = ? AND seq = ? AND generation = ?', ownRow = [kind, row.key, row.seq, row.generation] as const
    if (!failure) {
      // The row is gone at this statement and not before it: what the attempt freed is what a listener may offer other material into.
      const gone = this.store.db.prepare(`DELETE FROM effect WHERE ${own}`).run(...ownRow).changes > 0
      if (gone) this.release(kind, row.key)
    }
    // Leave running rows untouched on shutdown so they retry on the next start.
    else if (this.stopped) return
    else if (failure.error instanceof Later) {
      this.store.db.prepare(`UPDATE effect SET due = ? WHERE ${own}`).run(this.now() + handler.retry[0], ...ownRow)
    } else {
      const delay = Math.min(handler.retry[1], handler.retry[0] * 2 ** Math.min(row.attempts, 16))
      this.store.db.prepare(`UPDATE effect SET attempts = attempts + 1, error = ?, due = ? WHERE ${own}`)
        .run(String(failure.error).slice(0, 1000), this.now() + delay, ...ownRow)
    }
    if (!this.stopped) this.report(kind)
  }
  /** Tells one kind's subscribers that `key` really left the queue; a subscriber's failure is reported, never allowed to disturb the queue. */
  private release(kind: EffectKind, key: string): void {
    for (const listener of this.releases.get(kind) ?? []) {
      try { listener(key) } catch (error) { this.failed(kind, error) }
    }
  }
  private failed(kind: EffectKind, error: unknown): void {
    this.broken.add(kind)
    this.health.get(kind)?.set({ state: 'error', detail: `The effect queue failed: ${String(error)}`, at: new Date(this.now()).toISOString() })
  }
  private report(kind: EffectKind): void {
    const row = this.store.db.prepare(`SELECT COUNT(*) AS waiting, MIN(since) AS since, MAX(attempts) AS attempts,
      (SELECT error FROM effect WHERE kind = ? AND attempts > 0 ORDER BY seq DESC LIMIT 1) AS error FROM effect WHERE kind = ?`).get(kind, kind)
    const waiting = Number(row?.waiting ?? 0)
    const failing = Number(row?.attempts ?? 0) >= FAILURES_BEFORE_ERROR && !this.handlers.get(kind)?.quiet
    const detail = waiting ? `${waiting} waiting since ${String(row?.since)}` : 'Nothing waiting'
    this.health.get(kind)?.set(failing
      ? { state: 'error', detail: `${detail}; the last failure: ${String(row?.error)}`, at: new Date(this.now()).toISOString() }
      : { state: 'ready', detail, at: new Date(this.now()).toISOString() })
  }
}
