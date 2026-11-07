/** The durable effect queue: coalescing, per-kind limits, retries with backoff, health and shutdown. */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { Effects, Later } from '../src/app/effects.ts'
import { Store } from '../src/app/store.ts'
import { HealthBoard } from '../src/infra/health.ts'
import { deferred } from './fixtures/async.ts'
import { memoryInput } from './fixtures/memory.ts'

let directory: string
let store: Store
let clock: number
let board: HealthBoard
let health: Readonly<Record<string, unknown>>
let effects: Effects
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'effects-'))
  store = new Store(join(directory, 'db.sqlite'))
  clock = Date.parse('2026-09-09T00:00:00Z')
  board = new HealthBoard()
  health = board.all
  effects = new Effects(store, board, () => clock)
  effects.start()
})
afterEach(() => { store.close(); rmSync(directory, { recursive: true, force: true }) })
const relay = (text: string) => ({ text })

it('runs an effect queued inside a transaction once it commits, and none from a transaction that rolled back', async () => {
  const run = vi.fn(async () => {})
  effects.handle('relay', run)
  store.atomic(() => { effects.enqueue('relay', 'kept', relay('a')) })
  expect(() => store.atomic(() => { effects.enqueue('relay', 'dropped', relay('b')); throw new Error('rolled back') })).toThrow('rolled back')
  await effects.idle()
  expect(run.mock.calls).toEqual([[relay('a'), 'kept']])
  expect(effects.pending('relay')).toBe(false)
})

it('keeps one effect per key with the latest payload, and runs it again when a new payload arrives while it runs', async () => {
  const hold = deferred()
  const run = vi.fn(async (payload: { text: string }) => { if (payload.text === 'first') await hold.promise })
  effects.handle('relay', run)
  effects.enqueue('relay', 'k', relay('first'))
  await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1))
  effects.enqueue('relay', 'k', relay('second')); effects.enqueue('relay', 'k', relay('third'))
  hold.resolve()
  await effects.idle()
  expect(run.mock.calls.map(([payload]) => payload.text)).toEqual(['first', 'third'])
})

it('runs a kind oldest first, as many at once as its limit allows, and holds it while the limit is 0', async () => {
  const holds = new Map<string, ReturnType<typeof deferred<void>>>()
  let limit = 2
  const run = vi.fn(async (_payload: unknown, key: string) => { const hold = deferred(); holds.set(key, hold); await hold.promise })
  effects.handle('launch', run, { limit: () => limit })
  for (const key of ['a', 'b', 'c']) effects.enqueue('launch', key, { ticketId: key, assignmentId: key })
  await vi.waitFor(() => expect(run.mock.calls.map(([, key]) => key)).toEqual(['a', 'b']))
  limit = 0
  holds.get('a')!.resolve()
  await vi.waitFor(() => expect(effects.pending('launch', 'a')).toBe(false))
  effects.kick(); await Promise.resolve()
  expect(run).toHaveBeenCalledTimes(2)
  limit = 2
  holds.get('b')!.resolve()
  await vi.waitFor(() => expect(run.mock.calls.map(([, key]) => key)).toEqual(['a', 'b', 'c']))
  holds.get('c')!.resolve()
  await effects.idle()
})

it('keeps an effect\'s place in its queue when it is queued again with a new payload', async () => {
  const run = vi.fn(async (_payload: { ticketId: string; assignmentId: string }, _key: string) => {})
  let room = 0
  effects.handle('launch', run, { limit: () => room })
  store.atomic(() => {
    effects.enqueue('launch', 'first', { ticketId: 't1', assignmentId: 'a1' })
    effects.enqueue('launch', 'second', { ticketId: 't2', assignmentId: 'a2' })
    effects.enqueue('launch', 'first', { ticketId: 't1', assignmentId: 'a1' })
  })
  await effects.idle()
  room = 1
  await effects.idle()
  expect(run.mock.calls.map(([, key]) => key)).toEqual(['first', 'second'])
})

it('retries a failed effect after a delay that doubles up to its maximum, and reports the kind in error after three failures', async () => {
  let fail = true
  const run = vi.fn(async () => { if (fail) throw new Error('session busy') })
  effects.handle('notice', run, { retry: [1000, 3000] })
  effects.enqueue('notice', 'prompts', { value: { prompt_config_saved: 2 }, summary: 'Prompt configuration saved' })
  await effects.idle()
  expect(health.notice).toMatchObject({ state: 'ready', detail: '1 waiting since 2026-09-09T00:00:00.000Z' })
  for (const wait of [1000, 2000, 3000, 3000]) {
    clock += wait - 1; await effects.idle()
    const calls = run.mock.calls.length
    clock += 1; await effects.idle()
    expect(run).toHaveBeenCalledTimes(calls + 1)
    if (wait === 2000) expect(health.notice).toMatchObject({ state: 'error', detail: expect.stringContaining('1 waiting since 2026-09-09T00:00:00.000Z; the last failure: Error: session busy') })
  }
  fail = false
  clock += 3000; await effects.idle()
  expect(health.notice).toMatchObject({ state: 'ready', detail: 'Nothing waiting' })
  expect(effects.pending('notice')).toBe(false)
})

it('starts nothing once drained, keeps what waits and what shutdown cut short, and runs it after the next start', async () => {
  const hold = deferred()
  effects.handle('relay', async () => { await hold.promise; throw new Error('aborted') })
  effects.enqueue('relay', 'cut', relay('a'))
  await vi.waitFor(() => expect(effects.pending('relay', 'cut')).toBe(true))
  await Promise.resolve()
  const drained = effects.drain()
  effects.enqueue('relay', 'later', relay('b'))
  hold.resolve(); await drained
  const next = new Effects(store, new HealthBoard(), () => clock)
  next.start()
  const run = vi.fn(async (_payload: { text: string }, _key: string) => {})
  next.handle('relay', run)
  await next.idle()
  expect(run.mock.calls.map(([, key]) => key)).toEqual(['cut', 'later'])
})

it('lets a handler defer an effect without a failure, until a later dispatch after its first delay', async () => {
  let later = true
  const run = vi.fn(async () => { if (later) throw new Later('paused') })
  effects.handle('launch', run, { retry: [5000, 60_000] })
  effects.enqueue('launch', 'a', { ticketId: 't', assignmentId: 'a' })
  await effects.idle()
  expect(health.launch).toMatchObject({ state: 'ready', detail: '1 waiting since 2026-09-09T00:00:00.000Z' })
  later = false
  clock += 4999; await effects.idle()
  expect(run).toHaveBeenCalledOnce()
  clock += 1; await effects.idle()
  expect(run).toHaveBeenCalledTimes(2)
  expect(effects.pending('launch')).toBe(false)
})

it('runs an ordered kind one at a time in the order queued, and holds the later effects while an earlier one fails', async () => {
  const failing = new Set(['first'])
  const run = vi.fn(async (_payload: { text: string }, key: string) => { if (failing.has(key)) throw new Error('offline') })
  effects.handle('relay', run, { ordered: true, limit: () => 4, retry: [1000, 1000] })
  effects.enqueue('relay', 'first', relay('a')); effects.enqueue('relay', 'second', relay('b'))
  await effects.idle()
  clock += 1000; await effects.idle()
  expect(run.mock.calls.map(([, key]) => key)).toEqual(['first', 'first'])
  failing.clear()
  clock += 1000; await effects.idle()
  expect(run.mock.calls.map(([, key]) => key)).toEqual(['first', 'first', 'first', 'second'])
})

it('keeps a quiet kind\'s failures out of its health, and asks no limit while nothing is due', async () => {
  const limit = vi.fn(() => 4)
  effects.handle('delivery', async () => { throw new Error('Session gone') }, { quiet: true, limit, retry: [1000, 1000] })
  effects.kick(); await effects.idle()
  expect(limit).not.toHaveBeenCalled()
  effects.enqueue('delivery', 't', { ticketId: 't' })
  for (let attempt = 0; attempt < 4; attempt++) { await effects.idle(); clock += 1000 }
  expect(health.delivery).toMatchObject({ state: 'ready', detail: '1 waiting since 2026-09-09T00:00:00.000Z' })
})

it('keeps an effect cancelled and queued again while its first run goes on, which the first run does not end', async () => {
  const hold = deferred<void>()
  const run = vi.fn(async (_payload: { text: string }, _key: string) => { if (run.mock.calls.length === 1) await hold.promise })
  effects.handle('relay', run)
  effects.enqueue('relay', 'k', relay('first'))
  await vi.waitFor(() => expect(run).toHaveBeenCalledOnce())
  effects.cancel('relay', 'k')
  effects.enqueue('relay', 'k', relay('second'))
  hold.resolve()
  await effects.idle()
  expect(run.mock.calls.map(([payload]) => payload.text)).toEqual(['first', 'second'])
  expect(effects.pending('relay')).toBe(false)
})

it('queues an effect after a restart behind the ones that waited, for a kind that keeps its order', async () => {
  const hold = deferred<void>()
  effects.handle('relay', async () => { await hold.promise; throw new Error('aborted') }, { ordered: true })
  effects.enqueue('relay', 'first', relay('a'))
  effects.enqueue('relay', 'second', relay('b'))
  await vi.waitFor(() => expect(effects.pending('relay', 'first')).toBe(true))
  const drained = effects.drain()
  hold.resolve(); await drained
  // Sequence numbers continue across restarts so newly queued effects run after existing pending ones.
  const next = new Effects(store, new HealthBoard(), () => clock)
  next.enqueue('relay', 'third', relay('c'))
  next.start()
  const run = vi.fn(async (_payload: { text: string }, _key: string) => {})
  next.handle('relay', run, { ordered: true })
  await next.idle()
  expect(run.mock.calls.map(([, key]) => key)).toEqual(['first', 'second', 'third'])
})

it('reports a failure of the queue itself under its kind, until a dispatch of that kind succeeds again', async () => {
  let broken = true
  effects.handle('relay', async () => {}, { limit: () => { if (broken) throw new Error('database is locked'); return 1 } })
  effects.enqueue('relay', 'k', relay('a'))
  await effects.idle()
  expect(health.relay).toMatchObject({ state: 'error', detail: 'The effect queue failed: Error: database is locked' })
  broken = false
  effects.kick()
  await effects.idle()
  expect(health.relay).toMatchObject({ state: 'ready', detail: 'Nothing waiting' })
})

it('refuses a second handler for a kind', () => {
  effects.handle('relay', async () => {})
  expect(() => effects.handle('relay', async () => {})).toThrow('The relay effects already have a handler')
})

it('reports what one kind holds and which key already waits, read from the queue rather than counted', () => {
  effects.handle('relay', async () => {})
  effects.handle('memory', async () => {})
  expect(effects.occupancy('relay')).toEqual({ items: 0, bytes: 0, held: false })
  effects.enqueue('relay', 'a', relay('12345'))
  effects.enqueue('relay', 'b', relay('1234567'))
  const bytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value), 'utf8')
  // The bytes are the payloads the queue stores, and the key asked about is answered by the queue itself rather than by a count this
  // process keeps, so what a caller bounds is what is really persisted.
  expect(effects.occupancy('relay')).toEqual({ items: 2, bytes: bytes(relay('12345')) + bytes(relay('1234567')), held: false })
  expect(effects.occupancy('relay', 'b')).toMatchObject({ items: 2, held: true })
  expect(effects.occupancy('relay', 'c')).toMatchObject({ items: 2, held: false })
  // One kind is measured alone: what another kind waits with is not this kind's cost.
  effects.enqueue('memory', 'a', memoryInput())
  expect(effects.occupancy('relay')).toMatchObject({ items: 2 })
  expect(effects.occupancy('memory')).toEqual({ items: 1, bytes: bytes(memoryInput()), held: false })
  expect(effects.occupancy('memory', 'a')).toEqual({ items: 1, bytes: bytes(memoryInput()), held: true })
  // What is counted is the bytes stored, not the characters they are written in: 100 CJK characters are 300 bytes, and a ceiling
  // stated in bytes has to be read in the unit the queue really occupies.
  const wide = relay('错误'.repeat(50))
  effects.enqueue('relay', 'c', wide)
  expect(effects.occupancy('relay')).toEqual({ items: 3, bytes: bytes(relay('12345')) + bytes(relay('1234567')) + bytes(wide), held: false })
})

it('tells a listener each row the queue really finished, after the delete, so the place it held is free when it is told', async () => {
  effects.handle('memory', async () => {})
  // What the listener reads when it is told: a caller that offers waiting material into the place a delivery is giving up has to see
  // that place already gone from the queue, which only the delete makes true — a handler's own return is not yet a release.
  const seen: number[] = []
  const stop = effects.released('memory', () => { seen.push(effects.occupancy('memory').items) })
  effects.enqueue('memory', 'first', memoryInput())
  await effects.idle()
  expect(seen).toEqual([0])
  expect(effects.pending('memory')).toBe(false)
  // A listener that stopped listening hears nothing of the next release, and the queue is unaffected either way.
  stop()
  effects.enqueue('memory', 'second', memoryInput({ primary: 'feishu:oc_team:second' }))
  await effects.idle()
  expect(seen).toEqual([0])
  expect(effects.pending('memory')).toBe(false)
})

it('tells no listener a row was released while it is still queued: a failure, a Later and a shutdown all keep it', async () => {
  const released = vi.fn()
  effects.released('memory', released)
  let holding: 'failure' | 'later' = 'failure'
  effects.handle('memory', async () => { if (holding === 'later') throw new Later(); throw new Error('the store is full') },
    { retry: [1000, 1000] })
  effects.enqueue('memory', 'kept', memoryInput())
  await effects.idle()
  // The attempt failed, so `attempt` keeps the row for the retry it scheduled: its place is not free, and nothing may be offered into it.
  expect(released).not.toHaveBeenCalled()
  expect(effects.pending('memory', 'kept')).toBe(true)
  holding = 'later'
  clock += 1000; await effects.idle()
  // A `Later` reschedules the same row rather than deleting it, which is not a release either.
  expect(released).not.toHaveBeenCalled()
  expect(effects.pending('memory', 'kept')).toBe(true)
  // The runtime stops mid-attempt: the row is left for the next start, so this queue released nothing it is holding.
  const entered = deferred(), stopping = new Effects(store, new HealthBoard(), () => clock), stopped = vi.fn()
  stopping.released('relay', stopped)
  let running = false
  stopping.handle('relay', async () => { running = true; await entered.promise; throw new Error('the runtime stopped') }, { retry: [1000, 1000] })
  stopping.enqueue('relay', 'cut', relay('a'))
  stopping.start()
  await vi.waitFor(() => expect(running).toBe(true))
  const drained = stopping.drain()
  entered.resolve(); await drained
  expect(stopped).not.toHaveBeenCalled()
  expect(stopping.pending('relay', 'cut')).toBe(true)
})
