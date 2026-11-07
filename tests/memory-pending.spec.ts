/**
 * The material a business fact made that the memory store has not accepted yet, at the composition the runtime builds: a capture
 * waits in the durable `memory` effect queue, so that queue is part of the memory's finite capacity and not a second buffer growing
 * without end — and a capture the receiving boundary refused waits at its redelivery position, so it is offered again once the queue
 * has room instead of disappearing with the count this process kept. The case the implementation review reproduced is here — a
 * 65,536-byte store fed 320 events of about 32 KB each — and what these tests measure is every byte the memory keeps: the files under
 * `<stateDir>/memory`, the payloads still waiting in `orchestrator.sqlite`, and the position those payloads could not enter. The
 * Runtime's own boundary is `memory-runtime.spec.ts`; the store's capacity is `memory-capacity.spec.ts`.
 */
import { mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createMemory, type Memory } from '../src/app/memory.ts'
import { Effects } from '../src/app/effects.ts'
import { Store } from '../src/app/store.ts'
import { HealthBoard } from '../src/infra/health.ts'
import { KV } from '../src/kv.ts'
import type { Machine } from '../src/deployment.ts'
import type { Trigger } from '../src/core/index.ts'
import type { ExperienceInput } from '../src/memory/model.ts'
import type { RedeliveryRecord } from '../src/app/redelivery.ts'
import { reference, testMachine } from './fixtures/deployment.ts'
import { memoryInput } from './fixtures/memory.ts'

/** Bytes of every file under one directory, walked: what a memory root really occupies rather than its top level alone. */
const bytesUnder = (dir: string): number => readdirSync(dir, { withFileTypes: true })
  .reduce((sum, entry) => sum + (entry.isDirectory() ? bytesUnder(join(dir, entry.name)) : statSync(join(dir, entry.name)).size), 0)
/** The pieces of the runtime this file composes, and how a test reads what they persisted without reaching into them. */
interface Composed {
  readonly memory: Memory
  readonly effects: Effects
  readonly store: Store
  readonly board: HealthBoard
  /** Let `ms` pass for the effect queue, which is the only way a back-pressured row falls due again. */
  readonly tick: (ms: number) => void
  /** The payloads waiting to be accepted, as the queue itself holds them. */
  readonly queue: () => { items: number; bytes: number }
  /** The redelivery position as it is persisted, which is where a capture the boundary refused waits. */
  readonly held: () => RedeliveryRecord | undefined
  /** The clock this composition's queue runs on, which a restart begins again. */
  readonly now: () => number
  /** Every byte this memory keeps: its files under the root, the payloads waiting for it, and the position it refused captures at. */
  readonly persisted: () => number
  readonly close: () => void
}
/**
 * Build the parts the runtime wires together, on a real store and a real temporary directory: the memory, the durable queue its
 * captures are written to, and the handler that publishes one. The clock is the queue's own, so a test decides when a refused
 * write is retried instead of waiting two seconds.
 */
function compose(stateDir: string, overrides: Partial<Machine> = {}): Composed {
  const board = new HealthBoard(), store = new Store(join(stateDir, 'orchestrator.sqlite')), machine = testMachine({ stateDir, ...overrides })
  let clock = Date.parse('2026-11-07T00:00:00.000Z')
  const effects = new Effects(store, board, () => clock)
  const memory = createMemory({ machine, effects, records: store, position: store, masterId: 'master', room: () => 4000,
    health: board.claim('memory-store'), deliver: async () => {}, project: () => 'acme/widgets',
    now: () => new Date(clock).toISOString() })
  effects.handle('memory', (input, key) => memory.store(input, key), { limit: () => 1, retry: [2_000, 60_000] })
  effects.start()
  const queue = (): { items: number; bytes: number } => {
    // The bytes the queue really occupies: SQLite's `LENGTH` over a text value counts characters, so the payload is measured as the
    // blob it is stored as, which is the unit the memory's own bound is stated in.
    const row = store.db.prepare("SELECT COUNT(*) AS items, IFNULL(SUM(LENGTH(CAST(value AS BLOB))), 0) AS bytes FROM effect WHERE kind = 'memory'").get()
    return { items: Number(row?.items ?? 0), bytes: Number(row?.bytes ?? 0) }
  }
  /** The bytes the redelivery position occupies, measured the same way the queue's payloads are. */
  const heldBytes = (): number => Number(store.db.prepare('SELECT IFNULL(LENGTH(CAST(value AS BLOB)), 0) AS bytes FROM kv WHERE key = ?')
    .get(KV.memory.redelivery)?.bytes ?? 0)
  return { memory, effects, store, board, queue, tick: ms => { clock += ms }, held: () => store.get(KV.memory.redelivery),
    now: () => clock, persisted: () => bytesUnder(join(stateDir, 'memory')) + queue().bytes + heldBytes(),
    close: () => { memory.close(); store.close() } }
}
/** One trigger of the size the review used: about 32 KB of text, which a capture hands the store as one original. */
const largeTrigger = (index: number, at: string): Trigger => ({ id: `trg-${index}`, source: 'feishu:oc_team', threads: [],
  actor: { source: 'feishu', id: 'ou_alice' }, human: true, at, text: `trigger ${index}: ${'data '.repeat(6_500)}`, meta: {} })
/**
 * One business fact and the capture it makes, in the order the Engine writes them: the source record first, then the capture the
 * transaction carries, so the memory reads a trigger the business already holds.
 */
const receive = (composed: Composed, index: number): void => {
  const at = `2026-11-07T00:${String(Math.floor(index / 60) % 60).padStart(2, '0')}:${String(index % 60).padStart(2, '0')}.000Z`
  const trigger = largeTrigger(index, at)
  composed.store.triggers.save(trigger)
  composed.memory.capture({ type: 'trigger.received', at: trigger.at, data: { triggerId: trigger.id, threads: [] } })
}

/** One batch's measurement: what waited in the queue, and every byte the memory kept at that point. */
interface Measured { items: number; bytes: number; persisted: number }
/**
 * Let every waiting row come due again and run, however far the backoff of an earlier run pushed it: the queue is retried on its own
 * clock, and a restart begins that clock again, so the moment a row falls due has to be read from the row rather than assumed.
 */
const settle = async (composed: Composed): Promise<void> => {
  for (let round = 0; round < 4; round++) {
    const due = Number(composed.store.db.prepare("SELECT IFNULL(MAX(due), 0) AS due FROM effect WHERE kind = 'memory'").get()?.due ?? 0)
    if (due >= composed.now()) composed.tick(due - composed.now() + 1_000)
    composed.effects.kick()
    await composed.effects.idle('memory')
  }
}

describe('material the memory store has not accepted yet', () => {
  it('stops growing at a bound instead of moving unlimited growth into the business database', async () => {
    const home = mkdtempSync(join(tmpdir(), 'memory-pending-')), stateDir = join(home, 'state')
    const composed = compose(stateDir, { memoryBudgetBytes: reference(65_536) })
    try {
      const budget = 65_536, batches: Measured[] = []
      // The review's own scenario: more than 320 facts of about 32 KB each, offered to a store that may hold 65,536 bytes. Each
      // batch is measured after the queue has run what it can, which is when the store has taken everything it is going to.
      for (let batch = 0; batch < 5; batch++) {
        for (let index = batch * 80; index < (batch + 1) * 80; index++) receive(composed, index)
        await composed.effects.idle('memory')
        batches.push({ ...composed.queue(), persisted: composed.persisted() })
      }
      const [last, settled] = batches.slice(-2) as [Measured, Measured]
      expect(composed.memory.status().experiences).toBeGreaterThan(0)
      // The queue never holds more than the store itself may hold, and the memory's whole persisted footprint stays inside the
      // contract its three areas state: the budget for the files, the same again for what waits to be accepted, and the same again
      // for the position a refused capture waits at — which is what keeps the growth the review measured finite.
      for (const batch of batches) {
        expect(batch.bytes).toBeLessThanOrEqual(budget)
        expect(batch.persisted).toBeLessThanOrEqual(3 * budget)
      }
      expect(composed.memory.pending().redelivery).toMatchObject({ maxBytes: budget, maxItems: 64 })
      expect(composed.memory.pending().redelivery.bytes).toBeLessThanOrEqual(budget)
      // The bound is reached rather than merely approached: another 80 events add nothing to what the memory keeps, and what the
      // store cannot take is counted at the boundary rather than stored.
      expect(settled).toEqual(last)
      expect(last.items).toBeGreaterThan(0)
      expect(composed.memory.pending()).toMatchObject({ state: 'full', maxBytes: budget })
      expect(composed.memory.pending().refused).toBeGreaterThan(0)
      // What the store could not take is not a number this process kept: the position holds the newest of it, and what its own bound
      // could not hold is counted as permanently lost rather than dropped in silence.
      expect(composed.memory.pending().redelivery.items).toBeGreaterThan(0)
      expect(composed.memory.pending().redelivery.lost).toBeGreaterThan(0)
    } finally { composed.close(); rmSync(home, { recursive: true, force: true }) }
  })

  it('charges a waiting capture the bytes it occupies, so a bound stated in bytes holds for text a character count under-measures', async () => {
    const home = mkdtempSync(join(tmpdir(), 'memory-pending-')), stateDir = join(home, 'state')
    // The deployment proves no boundary and requires one, so nothing is published and every capture that fits waits in the queue:
    // what is measured here is the queue's own occupancy against the byte ceiling, with no write of any size beside it.
    const composed = compose(stateDir, { memoryBudgetBytes: reference(65_536), memoryPendingMaxItems: reference(64),
      memoryWriteMode: reference('require') })
    /** One capture of 6,000 CJK characters: 18,000 bytes of UTF-8, three times the characters such a text counts as. */
    const cjk = (index: number): Trigger => ({ id: `cjk-${index}`, source: 'feishu:oc_team', threads: [],
      actor: { source: 'feishu', id: 'ou_alice' }, human: true, at: `2026-11-07T00:00:${String(index).padStart(2, '0')}.000Z`,
      text: `事件 ${index}: ${'错误'.repeat(3_000)}`, meta: {} })
    try {
      for (let index = 0; index < 8; index++) {
        const trigger = cjk(index)
        composed.store.triggers.save(trigger)
        composed.memory.capture({ type: 'trigger.received', at: trigger.at, data: { triggerId: trigger.id, threads: [] } })
      }
      const pending = composed.memory.pending()
      // Three of these payloads fit the 65,536-byte bound and a fourth does not. Counted in characters ten would have fitted, and the
      // queue would have held three times the bytes its bound states while reporting itself inside it.
      expect(pending.items).toBe(3)
      expect(pending.refused).toBe(5)
      expect(pending.state).toBe('full')
      // Every waiting payload is charged what its text really occupies — over 15,000 bytes for a text that is about 6,400 characters —
      // and each of the three areas stays inside the bound it states: the queue, the position the refusals wait at, and their sum.
      expect(pending.bytes / pending.items).toBeGreaterThan(15_000)
      expect(pending.bytes).toBeLessThanOrEqual(65_536)
      expect(pending.redelivery.bytes).toBeLessThanOrEqual(65_536)
      expect(pending.redelivery.items).toBeGreaterThan(0)
      expect(pending.notYetAccepted).toBe(pending.items + pending.redelivery.items)
      expect(composed.persisted()).toBeLessThanOrEqual(3 * 65_536)
      // The five refused captures are in the position, except the ones its own bound could not hold: those are counted as lost.
      expect(pending.refused).toBe(pending.redelivery.items + pending.redelivery.lost)
    } finally { composed.close(); rmSync(home, { recursive: true, force: true }) }
  })

  it('refuses at the item bound before the byte one, and reports every state an operator has to tell apart', async () => {
    const home = mkdtempSync(join(tmpdir(), 'memory-pending-')), stateDir = join(home, 'state')
    const composed = compose(stateDir, { memoryBudgetBytes: reference(65_536), memoryPendingMaxItems: reference(3) })
    /** One small capture: about 40 bytes, so the byte bound is far away and the count of waiting captures is what stops the queue. */
    const small = (index: number): Trigger => ({ id: `small-${index}`, source: 'feishu:oc_team', threads: [],
      actor: { source: 'feishu', id: 'ou_alice' }, human: true, at: `2026-11-07T00:00:0${index}.000Z`,
      text: `note ${index}: the export button is broken`, meta: {} })
    const offer = (index: number): void => {
      const trigger = small(index)
      composed.store.triggers.save(trigger)
      composed.memory.capture({ type: 'trigger.received', at: trigger.at, data: { triggerId: trigger.id, threads: [] } })
    }
    try {
      // Eight events offered before the queue has run anything, of which three fit and five are refused rather than stored.
      for (let index = 0; index < 8; index++) offer(index)
      expect(composed.queue().items).toBe(3)
      const pending = composed.memory.pending()
      expect(pending).toMatchObject({ items: 3, maxItems: 3, state: 'full', refused: 5 })
      expect(pending.reason).toBeDefined()
      expect(pending.maxBytes).toBe(65_536)
      // The queue's capacity, its occupancy, the reason for the back-pressure and the count refused, all on the health entry an
      // operator reads instead of querying the business database.
      const health = composed.board.all['memory-store']!
      expect(health.detail).toContain('3 of 3 captures')
      expect(health.detail).toContain('waiting to be accepted')
      // The two are said apart and both are named: what waits is offered again as the store takes it, and what the boundary refused
      // waits at a redelivery position with its own bound, so an operator can see material that will be offered again rather than
      // read a count that means nothing will.
      expect(health.detail).toContain('offered again as the store takes them')
      expect(health.detail).toContain('5 refused at the receiving boundary since this runtime opened')
      expect(health.detail).toContain('5 of 64 held at a redelivery position')
      expect(health.detail).toContain('offered again one at a time as the queue has room')
      expect(health.detail).toContain(pending.reason!)
      expect(pending.notYetAccepted).toBe(8)
      // A second offer of a fact that already waits replaces its own row instead of counting twice or being refused: what the queue
      // holds is the facts waiting, not the number of times a Source re-announced them.
      offer(0)
      expect(composed.queue().items).toBe(3)
      expect(composed.memory.pending().refused).toBe(5)
    } finally { composed.close(); rmSync(home, { recursive: true, force: true }) }
  })

  it('keeps the queue bounded when a refused isolation gate stops the store writing at all', async () => {
    const home = mkdtempSync(join(tmpdir(), 'memory-pending-')), stateDir = join(home, 'state')
    // The deployment proves no boundary and the machine requires one, so no commit may run: every capture waits rather than being
    // published, and the bound is what keeps that wait finite instead of letting a refused gate grow a queue for ever.
    const composed = compose(stateDir, { memoryBudgetBytes: reference(65_536), memoryPendingMaxItems: reference(4),
      memoryWriteMode: reference('require') })
    try {
      for (let index = 0; index < 12; index++) {
        const trigger = { id: `gated-${index}`, source: 'feishu:oc_team', threads: [], actor: { source: 'feishu', id: 'ou_alice' },
          human: true, at: `2026-11-07T00:00:${String(index).padStart(2, '0')}.000Z`, text: `note ${index}: the export is broken`, meta: {} }
        composed.store.triggers.save(trigger)
        composed.memory.capture({ type: 'trigger.received', at: trigger.at, data: { triggerId: trigger.id, threads: [] } })
      }
      expect(composed.memory.status().writable).toBe(false)
      expect(composed.memory.status().experiences).toBe(0)
      expect(composed.queue().items).toBe(4)
      expect(composed.memory.pending().refused).toBe(8)
      // What stopped the store is on the entry an operator reads, and the queue's occupancy is beside it rather than instead of it.
      const health = composed.board.all['memory-store']!
      expect(health.detail).toContain('memoryWriteMode requires a boundary')
      expect(health.detail).toContain('4 of 4 captures')
    } finally { composed.close(); rmSync(home, { recursive: true, force: true }) }
  })

  it('drains the bounded queue after a restart with room, applying each waiting fact exactly once', async () => {
    const home = mkdtempSync(join(tmpdir(), 'memory-pending-')), stateDir = join(home, 'state')
    let composed = compose(stateDir, { memoryBudgetBytes: reference(65_536), memoryPendingMaxItems: reference(16) })
    try {
      // One fact at a time, each offered to a store that fills: the moment one cannot be accepted it waits, and the queue is what
      // says so. A capture the store had no room for is not counted as accepted until the store really commits it.
      let sent = 0
      while (composed.memory.pending().items === 0 && sent < 60) {
        receive(composed, sent); sent += 1
        await composed.effects.idle('memory')
      }
      const accepted = composed.memory.status().experiences
      expect(composed.memory.pending().items).toBeGreaterThan(0)
      expect(accepted).toBeLessThan(sent)
      // Still full: the retry a `Later` schedules falls due, runs, and changes nothing about what waits.
      const waiting = composed.memory.pending().items
      composed.tick(2_000); composed.effects.kick()
      await composed.effects.idle('memory')
      expect(composed.memory.pending().items).toBe(waiting)
      // A restart with room for it — the queue is durable in SQLite, so it is the same rows rather than a fresh capture — and the
      // handler drains them one attempt per due row through the one commit path.
      composed.close()
      composed = compose(stateDir, { memoryBudgetBytes: reference(4 << 20), memoryPendingMaxItems: reference(16) })
      await composed.effects.idle('memory')
      // The backoff the row was left with is due again, and this time the store has room for it.
      composed.tick(10_000); composed.effects.kick()
      await composed.effects.idle('memory')
      expect(composed.memory.pending()).toMatchObject({ items: 0, bytes: 0, state: 'ready' })
      expect(composed.memory.status().experiences).toBe(sent)
      // A repeated delivery of what the queue already published changes nothing: the experience id is the same key, so the store
      // answers duplicate instead of applying the fact a second time.
      receive(composed, sent - 1)
      await composed.effects.idle('memory')
      expect(composed.memory.status().experiences).toBe(sent)
      expect(composed.queue().items).toBe(0)
    } finally { composed.close(); rmSync(home, { recursive: true, force: true }) }
  })

  it('offers the captures the boundary refused again once space is freed, and keeps what its own bound could not hold as a loss', async () => {
    const home = mkdtempSync(join(tmpdir(), 'memory-pending-')), stateDir = join(home, 'state')
    let composed = compose(stateDir, { memoryBudgetBytes: reference(65_536), memoryPendingMaxItems: reference(16) })
    try {
      // Facts offered one at a time to a store that fills: what cannot be published waits in the durable queue, and once the queue
      // holds all it may, the boundary refuses and keeps what it refused at the redelivery position rather than counting it away.
      const offered: string[] = []
      for (let index = 0; index < 40; index++) {
        receive(composed, index)
        offered.push(`trg-${index}`)
        await composed.effects.idle('memory')
      }
      const published = composed.memory.status().experiences
      const pending = composed.memory.pending()
      const waiting = pending.items, held = pending.redelivery
      expect(waiting).toBeGreaterThan(0)
      expect(pending.refused).toBeGreaterThan(0)
      expect(held.items).toBeGreaterThan(0)
      // Every fact the runtime received is published, still waiting, held for a later delivery, or lost to the position's own bound:
      // four states, no fifth, and the business keeps every one of its own records whichever of them the memory answered.
      expect(published + waiting + held.items + held.lost).toBe(offered.length)
      expect(offered.every(id => composed.store.triggers.get(id) !== undefined)).toBe(true)
      // What is held is the payload itself, so it survives the restart that takes this process's counters with it.
      const stored = composed.held()!
      expect(stored.items).toHaveLength(held.items)
      expect(stored.lost).toBe(held.lost)
      composed.close()
      // Room comes back. Before anything is delivered, the figure an operator reads is the durable one, queue plus position, and the
      // first of the held captures has already been offered back because this restart's queue has room.
      composed = compose(stateDir, { memoryBudgetBytes: reference(4 << 20), memoryPendingMaxItems: reference(16) })
      const restarted = composed.memory.pending()
      expect(restarted.notYetAccepted).toBe(waiting + held.items)
      expect(restarted.items).toBe(waiting + 1)
      expect(restarted.redelivery).toMatchObject({ items: held.items - 1, lost: held.lost })
      await settle(composed)
      // Space is freed: the queue drains, and each delivery offers one capture back through the same commit path, so the material
      // that was refused is accepted rather than dropped. What the position's own bound could not hold stays a counted loss.
      expect(composed.memory.pending()).toMatchObject({ items: 0, bytes: 0, state: 'ready',
        redelivery: { items: 0, bytes: 0, lost: held.lost } })
      expect(composed.memory.status().experiences).toBe(published + waiting + held.items)
      expect(composed.memory.status().experiences).toBe(offered.length - held.lost)
      // Every one of them is one experience rather than a fact applied twice: the read path returns distinct ids.
      const listed = composed.memory.list(undefined, 0, 200).items
      expect(listed).toHaveLength(published + waiting + held.items)
      expect(new Set(listed.map(item => item.id)).size).toBe(listed.length)
    } finally { composed.close(); rmSync(home, { recursive: true, force: true }) }
  })

  it('bounds the position the boundary refuses into, and reports the oldest it had to lose as permanently lost', async () => {
    const home = mkdtempSync(join(tmpdir(), 'memory-pending-')), stateDir = join(home, 'state')
    // The queue may hold one capture and the store may not write, so every capture after the first is refused. The position may hold
    // two of them: the two oldest are evicted to keep it inside that bound, and the entry an operator reads says so.
    const composed = compose(stateDir, { memoryBudgetBytes: reference(65_536), memoryPendingMaxItems: reference(1),
      memoryRedeliveryMaxItems: reference(2), memoryWriteMode: reference('require') })
    const note = (index: number): Trigger => ({ id: `noted-${index}`, source: 'feishu:oc_team', threads: [],
      actor: { source: 'feishu', id: 'ou_alice' }, human: true, at: `2026-11-07T00:00:0${index}.000Z`,
      text: `note ${index}: the export button is broken`, meta: {} })
    const offer = (index: number): void => {
      const trigger = note(index)
      composed.store.triggers.save(trigger)
      composed.memory.capture({ type: 'trigger.received', at: trigger.at, data: { triggerId: trigger.id, threads: [] } })
    }
    try {
      for (let index = 0; index < 5; index++) offer(index)
      const pending = composed.memory.pending()
      expect(pending).toMatchObject({ items: 1, refused: 4, notYetAccepted: 3, state: 'full' })
      // Four were refused; the position holds two and reports the other two as what its bound cost, never as silence.
      expect(pending.redelivery).toMatchObject({ items: 2, maxItems: 2, maxBytes: 65_536, lost: 2, state: 'full' })
      expect(pending.redelivery.bytes).toBeLessThanOrEqual(pending.redelivery.maxBytes)
      // The oldest are the ones evicted: what is still held is the newest two, which is the order a bounded list recovers in.
      expect(composed.held()!.items.map(item => item.input.material.text))
        .toEqual(['note 3: the export button is broken', 'note 4: the export button is broken'])
      // All of it on the health entry, named apart from what waits: the two bounds, the permanent loss and why it happened, and a
      // position at its bound said before it costs anything rather than only afterwards.
      const health = composed.board.all['memory-store']!
      expect(health.detail).toContain('4 refused at the receiving boundary since this runtime opened')
      expect(health.detail).toContain('2 of 2 held at a redelivery position')
      expect(health.detail).toContain('permanently lost: the oldest were evicted when that position reached its 2 captures or 65536 bytes')
      expect(health.detail).toContain('that position is at its bound, so the next refusal it can hold evicts the oldest')
      // Three areas, three bounds: the queue's payloads, the position's payloads and the files stay inside the budget each, and the
      // memory's whole persisted footprint inside their sum.
      expect(pending.bytes).toBeLessThanOrEqual(65_536)
      expect(pending.redelivery.bytes).toBeLessThanOrEqual(65_536)
      expect(composed.persisted()).toBeLessThanOrEqual(3 * 65_536)
    } finally { composed.close(); rmSync(home, { recursive: true, force: true }) }
  })

  it('loses the capture that cannot fit the byte bound by itself, and keeps every capture the position already held', async () => {
    const home = mkdtempSync(join(tmpdir(), 'memory-pending-')), stateDir = join(home, 'state')
    // The queue may hold one capture and the store may not write, so the next three wait at the position. The fourth is larger than
    // the position's whole byte bound: no room can be made for it, and making room must not cost the three already waiting.
    const composed = compose(stateDir, { memoryBudgetBytes: reference(65_536), memoryPendingMaxItems: reference(1),
      memoryWriteMode: reference('require') })
    const note = (id: string, at: string, text: string): Trigger => ({ id, source: 'feishu:oc_team', threads: [],
      actor: { source: 'feishu', id: 'ou_alice' }, human: true, at, text, meta: {} })
    const offer = (trigger: Trigger): void => {
      composed.store.triggers.save(trigger)
      composed.memory.capture({ type: 'trigger.received', at: trigger.at, data: { triggerId: trigger.id, threads: [] } })
    }
    try {
      offer(note('queued', '2026-11-07T00:00:00.000Z', 'note 0: the export button is broken'))
      for (const index of [1, 2, 3]) offer(note(`held-${index}`, `2026-11-07T00:00:0${index}.000Z`, `note ${index}: the export button is broken`))
      expect(composed.memory.pending()).toMatchObject({ items: 1, refused: 3, redelivery: { items: 3, lost: 0 } })
      // About 90,000 UTF-8 bytes of payload against a 65,536-byte bound: the shape production reaches, because a capture is clipped at
      // 32,768 characters and three bytes of UTF-8 per character is what a text that is not ASCII costs.
      offer(note('oversized', '2026-11-07T00:00:09.000Z', `huge: ${'错误'.repeat(15_000)}`))
      const pending = composed.memory.pending()
      expect(pending.redelivery).toMatchObject({ items: 3, lost: 1 })
      expect(pending.redelivery.bytes).toBeLessThanOrEqual(pending.redelivery.maxBytes)
      // What waited still waits: one refusal that cannot fit costs its own loss and nothing that was already held.
      expect(composed.held()!.items.map(item => item.input.material.text))
        .toEqual(['note 1: the export button is broken', 'note 2: the export button is broken', 'note 3: the export button is broken'])
      // The invariant the fourth state rests on: everything the boundary refused is either still held or counted as lost.
      expect(pending.redelivery.items + pending.redelivery.lost).toBe(pending.refused)
    } finally { composed.close(); rmSync(home, { recursive: true, force: true }) }
  })

  it('counts one fact once when it is refused on two triggers, and keeps the newest material it was refused with', async () => {
    const home = mkdtempSync(join(tmpdir(), 'memory-pending-')), stateDir = join(home, 'state')
    const composed = compose(stateDir, { memoryBudgetBytes: reference(65_536), memoryPendingMaxItems: reference(1),
      memoryWriteMode: reference('require') })
    /** One trigger a Source stores again with the text it read later: the same fact, and so the same experience id. */
    const note = (id: string, text: string): Trigger => ({ id, source: 'feishu:oc_team', threads: [],
      actor: { source: 'feishu', id: 'ou_alice' }, human: true, at: '2026-11-07T00:00:05.000Z', text, meta: {} })
    const offer = (trigger: Trigger): void => {
      composed.store.triggers.save(trigger)
      composed.memory.capture({ type: 'trigger.received', at: trigger.at, data: { triggerId: trigger.id, threads: [] } })
    }
    try {
      offer(note('queued', 'note 0: the export button is broken'))
      // The same fact refused twice, because the Source saved its Trigger again and both readings reached a full queue.
      offer(note('revised', 'note 1: the export button is broken'))
      offer(note('revised', 'note 1: the export button is broken for every viewer'))
      const pending = composed.memory.pending()
      // One experience id is one capture waiting, as the queue coalesces on that same key: a later refusal replaces the material
      // rather than adding a second copy of the same fact to what an operator reads as outstanding.
      expect(pending.redelivery.items).toBe(1)
      expect(pending.notYetAccepted).toBe(2)
      // The operational count is still two refusals, which is what it reports: this is a fact the boundary refused twice, not two facts.
      expect(pending.refused).toBe(2)
      expect(composed.held()!.items.map(item => item.input.material.text))
        .toEqual(['note 1: the export button is broken for every viewer'])
    } finally { composed.close(); rmSync(home, { recursive: true, force: true }) }
  })

  it('keeps the position and the figure an operator reads across a restart, and offers one capture back per trigger', async () => {
    const home = mkdtempSync(join(tmpdir(), 'memory-pending-')), stateDir = join(home, 'state')
    const note = (index: number): Trigger => ({ id: `kept-${index}`, source: 'feishu:oc_team', threads: [],
      actor: { source: 'feishu', id: 'ou_alice' }, human: true, at: `2026-11-07T00:00:0${index}.000Z`,
      text: `note ${index}: the export button is broken`, meta: {} })
    const offer = (composed: Composed, index: number): void => {
      const trigger = note(index)
      composed.store.triggers.save(trigger)
      composed.memory.capture({ type: 'trigger.received', at: trigger.at, data: { triggerId: trigger.id, threads: [] } })
    }
    let composed = compose(stateDir, { memoryBudgetBytes: reference(65_536), memoryPendingMaxItems: reference(1),
      memoryWriteMode: reference('require') })
    try {
      // One capture waits in the queue and two are refused: nothing can be published while the gate is shut, so nothing moves.
      for (let index = 0; index < 3; index++) offer(composed, index)
      expect(composed.memory.pending()).toMatchObject({ items: 1, notYetAccepted: 3, redelivery: { items: 2 } })
      composed.close()
      // A restart with the queue still full offers nothing back, and the figure does not reset to zero while the material is
      // outstanding: it is read from the durable record, which is what the second review round measured as broken.
      composed = compose(stateDir, { memoryBudgetBytes: reference(65_536), memoryPendingMaxItems: reference(1),
        memoryWriteMode: reference('require') })
      expect(composed.memory.pending()).toMatchObject({ items: 1, refused: 0, notYetAccepted: 3, redelivery: { items: 2, lost: 0 } })
      await settle(composed)
      expect(composed.memory.pending()).toMatchObject({ items: 1, notYetAccepted: 3, redelivery: { items: 2 } })
      composed.close()
      // Room in the queue, and still no way to write: startup offers exactly one capture back, and no more. A retry that publishes
      // nothing offers nothing more either, so recovery is a step per trigger rather than one burst or a spin.
      composed = compose(stateDir, { memoryBudgetBytes: reference(65_536), memoryPendingMaxItems: reference(8),
        memoryWriteMode: reference('require') })
      expect(composed.memory.pending()).toMatchObject({ items: 2, notYetAccepted: 3, redelivery: { items: 1, lost: 0 } })
      await settle(composed)
      expect(composed.memory.pending()).toMatchObject({ items: 2, notYetAccepted: 3, redelivery: { items: 1, lost: 0 } })
      composed.close()
      // The capacity both were waiting for comes back: the queue drains, the position is offered again as each delivery makes room,
      // and every fact the runtime received is published exactly once.
      composed = compose(stateDir, { memoryBudgetBytes: reference(4 << 20), memoryPendingMaxItems: reference(8) })
      await settle(composed)
      expect(composed.memory.pending()).toMatchObject({ items: 0, notYetAccepted: 0, redelivery: { items: 0, lost: 0 } })
      expect(composed.memory.status()).toMatchObject({ experiences: 3, version: 3 })
    } finally { composed.close(); rmSync(home, { recursive: true, force: true }) }
  })

  it('offers a refused capture back when reclamation frees room, without waiting for another fact', async () => {
    const home = mkdtempSync(join(tmpdir(), 'memory-pending-')), stateDir = join(home, 'state')
    const composed = compose(stateDir, { memoryBudgetBytes: reference(128 * 1024), memoryPendingMaxItems: reference(1) })
    /** Fill the store through its one commit path, which is the path the queue's handler calls; a full store answers `Later`. */
    const feed = async (input: ExperienceInput): Promise<void> => {
      try { await composed.memory.store(input) } catch { /* The store is full; what pressure it is under is read from its status. */ }
    }
    /** An original large enough to be a reclamation candidate once the store is under pressure. */
    const large = (topic: string, minute: number): ExperienceInput => memoryInput({ primary: `feishu:oc_team:${topic}`,
      occurredAt: '2026-11-01T09:00:00.000Z', recordedAt: `2026-11-06T09:${String(minute).padStart(2, '0')}:03.742Z`,
      text: `${topic}: ${'detail '.repeat(4_600)} end-of-body` })
    try {
      // The store is filled until its own status says it is under pressure — over the high watermark, with originals a pass could
      // release — which is the state the archive's one door frees room in.
      await feed(large('release-a', 1))
      await feed(large('release-b', 2))
      for (let index = 0; index < 60 && composed.memory.status().capacity.state === 'ready'; index++) {
        await feed(memoryInput({ primary: `feishu:oc_team:release-filler-${index}`, text: `the cache note ${index}: ${'entry '.repeat(640)}`,
          recordedAt: `2026-11-06T09:${String(index).padStart(2, '0')}:08.742Z` }))
      }
      expect(composed.memory.status().capacity.state).not.toBe('ready')
      expect(composed.memory.status().capacity.candidates).toBeGreaterThan(0)
      // A row the queue is asked to drop fills the queue and then leaves it without a delivery: the capture the boundary refuses
      // while it waits stays at the position, and no release offers it back — only the room reclamation frees below does.
      composed.effects.enqueue('memory', 'corrupt', { not: 'a capture' } as never)
      receive(composed, 900)
      expect(composed.memory.pending()).toMatchObject({ items: 1, redelivery: { items: 1, lost: 0 } })
      composed.effects.cancel('memory', 'corrupt')
      expect(composed.memory.pending()).toMatchObject({ items: 0, redelivery: { items: 1 } })
      // Room the archive's one door frees is the third entrance the position is offered back through — the released-capacity wake
      // itself, so a capture refused while the store was full moves again without a new fact having to arrive.
      const reclaimed = composed.memory.reclaim()
      expect(reclaimed.freed).toBeGreaterThan(0)
      expect(composed.memory.pending()).toMatchObject({ items: 1, redelivery: { items: 0, lost: 0 } })
      await settle(composed)
      expect(composed.memory.pending()).toMatchObject({ items: 0, redelivery: { items: 0 } })
      expect(composed.memory.status().experiences).toBeGreaterThan(0)
    } finally { composed.close(); rmSync(home, { recursive: true, force: true }) }
  })

  it('counts a queue row the store refuses outright as failed, rather than losing it in silence', async () => {
    const home = mkdtempSync(join(tmpdir(), 'memory-pending-')), stateDir = join(home, 'state')
    const composed = compose(stateDir, { memoryBudgetBytes: reference(65_536) })
    try {
      // A payload a crash left unreadable: the service refuses it as invalid, no retry can change that, and the row is settled.
      composed.effects.enqueue('memory', 'corrupt', { not: 'a capture' } as never)
      await composed.effects.idle('memory')
      expect(composed.queue().items).toBe(0)
      expect(composed.memory.pending().items).toBe(0)
      expect(composed.board.all['memory-store']!.detail).toContain('1 failed')
      // The queue coalesces by key, so a row whose key is not the fact it carries would merge two experiences on the next delivery:
      // it is refused as corrupt too, and counted on the same entry instead of being published under a key that is not its own.
      composed.effects.enqueue('memory', 'someone-else', memoryInput({ primary: 'feishu:oc_team:key-mismatch' }))
      await composed.effects.idle('memory')
      expect(composed.memory.status().experiences).toBe(0)
      expect(composed.queue().items).toBe(0)
      expect(composed.board.all['memory-store']!.detail).toContain('2 failed')
    } finally { composed.close(); rmSync(home, { recursive: true, force: true }) }
  })
})
