/**
 * The model-request input budget: the pure plan over the parts of one request, the measurement of a request and of a Session
 * log, the records the runtime keeps of every request it sent, paged or refused, and the boundary on a running Runtime where a
 * complete model request is measured, charged and, when it cannot fit, refused.
 */
import { describe, expect, it } from 'vitest'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import { budgetOf, measuredRequest, measureRequest, measureSurfaceEvents, planRequest, refusalMessage, RequestBudget, totalOf, validPolicy }
  from '../src/app/budget.ts'
import type { RequestParts, RequestPolicy } from '../src/app/budget.ts'
import { feishu, startRuntime } from './fixtures/host.ts'
import type { Host } from './fixtures/host.ts'

const policy = (overrides: Partial<RequestPolicy> = {}): RequestPolicy =>
  ({ maxInputChars: 1000, outputReserveChars: 100, measurementReserveChars: 50, ...overrides })
const parts = (overrides: Partial<RequestParts> = {}): RequestParts =>
  ({ system: 100, tools: 200, state: 0, history: 100, toolResults: 0, recall: 0, ...overrides })
/** Parts written out, so the arithmetic of each case is on the page. */
const only = (overrides: Partial<RequestParts> = {}): RequestParts =>
  ({ system: 0, tools: 0, state: 0, history: 0, toolResults: 0, recall: 0, ...overrides })

it('holds a request to its policy without the reserves, and sends it when it fits', () => {
  expect(budgetOf(policy())).toBe(850)
  const plan = planRequest(parts(), policy())
  expect(plan).toMatchObject({ action: 'send', total: 400, over: 0, reserve: 150, budget: 850 })
  expect(plan.cut).toEqual({ recall: 0, toolResults: 0, history: 0 })
  // Exactly at the budget is still a send: the reserves are what is kept free, not part of the room.
  expect(planRequest(parts({ history: 550 }), policy()).action).toBe('send')
})

it('gives up recalled material, then tool results, then the conversation, and suspends when required parts alone are over', () => {
  // 100 characters over: recalled material covers it first.
  expect(planRequest(only({ system: 100, tools: 200, history: 350, recall: 300 }), policy()))
    .toMatchObject({ action: 'shrink', over: 100, cut: { recall: 100, toolResults: 0, history: 0 } })
  // Recalled material alone is not enough, so tool results give up the rest.
  expect(planRequest(only({ system: 100, tools: 200, history: 400, recall: 50, toolResults: 300 }), policy()))
    .toMatchObject({ action: 'shrink', over: 200, cut: { recall: 50, toolResults: 150, history: 0 } })
  // Only the conversation is left to give.
  expect(planRequest(only({ system: 100, tools: 200, history: 950 }), policy()))
    .toMatchObject({ action: 'shrink', over: 400, cut: { recall: 0, toolResults: 0, history: 400 } })
  // The system prompt, the tool definitions and the state are required: once they alone are over, nothing is cut and the
  // request is suspended instead.
  expect(planRequest(only({ system: 900, tools: 300, history: 100 }), policy()))
    .toMatchObject({ action: 'suspend', reason: 'requiredOverBudget', cut: { recall: 0, toolResults: 0, history: 100 } })
})

it('refuses a policy it cannot use instead of clamping it to something nobody set', () => {
  expect(validPolicy(policy())).toBe(true)
  for (const unusable of [policy({ outputReserveChars: 1000, measurementReserveChars: 0 }), policy({ maxInputChars: 0 }),
    policy({ maxInputChars: 1000, outputReserveChars: 900, measurementReserveChars: 100 }), policy({ maxInputChars: -1 }),
    policy({ maxInputChars: 1000.5 })]) {
    expect(validPolicy(unusable), JSON.stringify(unusable)).toBe(false)
    expect(planRequest(parts(), unusable)).toMatchObject({ action: 'suspend', reason: 'invalidConfig', budget: 0 })
  }
})

it('measures a request by the part each message belongs to, and the tool definitions it declares', () => {
  const measured = measureRequest({
    system: 'sys',
    tools: [{ name: 'read', description: '', parameters: {} }],
    messages: [
      { role: 'user', content: [{ type: 'text', text: '12345' }] },
      { role: 'user', content: [{ type: 'text', text: 'abc' }], source: { kind: 'dsh-superagent', form: 'snapshot' } },
      { role: 'user', content: [{ type: 'text', text: 'xy' }], source: { kind: 'dsh-superagent', form: 'recall' } },
      { role: 'tool', content: [{ type: 'text', text: 'result' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'said' }] },
    ],
  } as never)
  expect(measured).toEqual({ system: 3, tools: 50, state: 3, history: 9, toolResults: 6, recall: 2 })
})

it('measures the parts the model-visible events it is given take, in the way it reads the same messages', () => {
  const message = (text: string, extra: Record<string, unknown> = {}) => ({ content: [{ type: 'text', text }], ...extra })
  const measured = measureSurfaceEvents([
    { type: 'system/message', data: { message: message('prompt') } },
    { type: 'user/message', data: message('hello') },
    { type: 'assistant/message', data: { message: message('answer') } },
    { type: 'tool/result', data: { message: message('output') } },
    { type: 'turn/start', data: { turn: 1 } },
  ])
  expect(measured).toEqual({ system: 6, tools: 0, state: 0, history: 11, toolResults: 6, recall: 0 })
})

it('pages material to the room it has, states what it withheld, and records both', () => {
  const budget = new RequestBudget(() => policy())
  const text = 'x'.repeat(2000)
  // What the Session's own request declared is part of what its next request carries: here, 200 characters of tool definitions.
  budget.record('s1', measuredRequest(only({ tools: 200 })))
  expect(budget.room(only({ history: 400 }), 's1')).toBe(250)
  // A caller that names no Session is measured against what this process has already seen declared.
  expect(budget.room(only({ history: 400 }))).toBe(250)
  const kept = budget.page('s1', 'message', text, budget.room(only({ history: 400 }), 's1'), 'trigger/t1')
  expect(kept.length).toBeLessThanOrEqual(250)
  expect(kept).toContain('2000 characters withheld')
  expect(kept).toContain('read trigger/t1')
  expect(budget.pagesOf('s1')).toEqual([expect.objectContaining({ sessionId: 's1', kind: 'message', offered: 2000, room: 250,
    action: 'shrink' })])
  // Text that fits is left alone and records nothing.
  expect(budget.page('s1', 'message', 'short', 250)).toBe('short')
  expect(budget.pagesOf('s1')).toHaveLength(1)
  // No room at all is recorded as a suspension of that material, and the message still says why.
  expect(budget.page('s2', 'tool-result', text, 0)).toContain('no room in the request budget')
  expect(budget.pagesOf('s2')).toEqual([expect.objectContaining({ kind: 'tool-result', room: 0, action: 'suspend' })])
})

it('records every request it is shown, per Session, with the plan that decided it', () => {
  const budget = new RequestBudget(() => policy())
  expect(budget.record('s1', measuredRequest(parts()))).toMatchObject({ sessionId: 's1', action: 'send', total: 400, budget: 850,
    cut: { recall: 0, toolResults: 0, history: 0 } })
  // The allowance is what that request left for recalled material.
  expect(budget.allowance('s1')).toBe(450)
  const refused = budget.record('s1', measuredRequest(only({ system: 900, tools: 100 })))
  expect(refused).toMatchObject({ action: 'suspend', reason: 'requiredOverBudget', total: 1000 })
  // A request outside a Session (an independent background job) is recorded the same way, without a Session id.
  expect(budget.record(undefined, measuredRequest(parts()))).toMatchObject({ action: 'send' })
  expect(budget.requestsOf('s1').map(record => record.action)).toEqual(['send', 'suspend'])
  expect(budget.requestsOf()).toHaveLength(3)
  expect(budget.last('s1')?.total).toBe(1000)
  expect(budget.allowance('s1')).toBe(0)
  expect(refusalMessage(refused)).toContain('1000 characters against a 850-character budget')
  expect(refusalMessage(refused)).toContain('required parts alone')
  expect(totalOf(parts())).toBe(400)
})

it('refuses a housekeeping call that is over the budget, as it refuses any other request', () => {
  const budget = new RequestBudget(() => policy())
  const over = only({ history: 2000 })
  expect(budget.record('s1', measuredRequest(over))).toMatchObject({ action: 'suspend' })
  // A compaction call exists to shrink an oversized conversation, but it obeys the same input limit as the turn it exists for:
  // the purpose is recorded apart from an ordinary turn, and it grants nothing.
  const compaction = budget.record('s1', measuredRequest(over), 'compaction')
  expect(compaction).toMatchObject({ action: 'suspend', purpose: 'compaction' })
  expect(compaction).not.toHaveProperty('recovery')
  expect(compaction.total).toBeGreaterThan(compaction.budget)
  // Housekeeping that fits is an ordinary send; the same call one part smaller is the same limit.
  expect(budget.record('s1', measuredRequest(parts()), 'session-title')).toMatchObject({ action: 'send', purpose: 'session-title' })
  expect(budget.record('s1', measuredRequest(over), 'session-title')).toMatchObject({ action: 'suspend', purpose: 'session-title' })
  expect(budget.requestsOf('s1').map(record => record.action)).toEqual(['suspend', 'suspend', 'send', 'suspend'])
  // Nothing this module records is a recovery: the record the exemption used has no such field or action at all.
  expect(budget.requestsOf('s1').every(record => !('recovery' in record))).toBe(true)
})

/** Set a volatile machine limit as the loader would, to reach a budget the defaults never reach. */
const limit = (machine: Host['runtime']['machine'],
  name: 'requestMaxChars' | 'requestOutputReserveChars' | 'requestMeasurementReserveChars', value: number) =>
  (machine[name] as unknown as { set(next: number): void }).set(value)

describe('the model request boundary', () => {
  it('meters and records the complete request of the main Session and of a Worker, inside the budget', async () => {
    const host = await startRuntime()
    try {
      const ticket = await host.acceptedTicket(feishu('1', '@bot fix the regression'))
      const master = host.runtime.masterId
      for (const sessionId of [master, ticket.sessionId]) {
        const asked = await host.ask(sessionId)
        expect(asked.failures).toEqual([])
        const request = host.request(sessionId)
        const record = host.runtime.sessions.requests(sessionId).at(-1)!
        expect(record).toMatchObject({ sessionId, action: 'send' })
        // The record is the whole request: the system prompt DSH assembles, the tool definitions, and the history it took.
        expect(record.parts.system).toBe((request.messages[0] as unknown as { content: { text: string }[] }).content[0]!.text.length)
        expect(record.parts.tools).toBe(JSON.stringify(request.tools).length)
        expect(record.parts.system + record.parts.tools).toBeGreaterThan(10_000)
        expect(record.total).toBeLessThanOrEqual(record.budget)
        expect(record.budget).toBe(400_000 - 32_000 - 8000)
        expect(record.parts.history).toBeGreaterThan(0)
      }
    } finally { await host.stop() }
  })

  it('refuses a request whose required parts alone are over budget, keeps the authorization text, and never calls the model', async () => {
    const host = await startRuntime()
    try {
      const master = host.runtime.masterId
      const section = host.sections.get(master)!.text({})
      expect(section).toContain('## Policy')
      const asked = host.asked.mock.calls.length
      limit(host.runtime.machine, 'requestMaxChars', Math.floor(section.length / 2))
      limit(host.runtime.machine, 'requestOutputReserveChars', 0)
      limit(host.runtime.machine, 'requestMeasurementReserveChars', 0)
      const refused = await host.ask(master)
      // The adapter never ran: the request stopped at the boundary.
      expect(host.asked.mock.calls.length).toBe(asked)
      expect(refused.failures).toEqual([expect.objectContaining({ code: 'REQUEST_OVER_BUDGET',
        message: expect.stringContaining('required parts alone are over the budget') })])
      const record = host.runtime.sessions.requests(master).at(-1)!
      expect(record).toMatchObject({ action: 'suspend', reason: 'requiredOverBudget' })
      // Nothing required was dropped to make it fit: the prompt the Session would have sent still holds its Policy and mandate.
      expect(host.sections.get(master)!.text({})).toBe(section)
      expect(record.cut).toEqual({ recall: 0, toolResults: 0, history: 0 })
    } finally { await host.stop() }
  })

  it('refuses every request when the budget cannot be used, rather than clamping it', async () => {
    const host = await startRuntime()
    try {
      const master = host.runtime.masterId
      // The reserves take the whole budget, which is a configuration the settings refuse and the boundary must not invent around.
      limit(host.runtime.machine, 'requestMaxChars', 1000)
      limit(host.runtime.machine, 'requestOutputReserveChars', 900)
      limit(host.runtime.machine, 'requestMeasurementReserveChars', 100)
      const asked = host.asked.mock.calls.length
      const refused = await host.ask(master)
      expect(host.asked.mock.calls.length).toBe(asked)
      expect(refused.failures).toEqual([expect.objectContaining({ code: 'REQUEST_OVER_BUDGET',
        message: expect.stringContaining('input budget is not configured usefully') })])
      expect(host.runtime.sessions.requests(master).at(-1)).toMatchObject({ action: 'suspend', reason: 'invalidConfig', budget: 0 })
    } finally { await host.stop() }
  })

  it('pages a tool result and a delivered message to the room left after the tool definitions, and never truncates them silently', async () => {
    const host = await startRuntime()
    try {
      const master = host.runtime.masterId, log = host.logs.get(master)!
      // The Session's own request first: the tool definitions it declares are what every later request of it also carries.
      const first = await host.ask(master)
      const tools = JSON.stringify(first.options.tools).length
      expect(host.runtime.sessions.requests(master).at(-1)!.parts.tools).toBe(tools)
      // DSH records the system prompt in the Session's log, so the budget measures the parts the request declares and this test
      // can size the budget from the same numbers: what those events take, the tool definitions, and 900 characters of room.
      log.push({ type: 'system/message', data: { message: { content: [{ type: 'text', text: host.sections.get(master)!.text({}) }] } } })
      limit(host.runtime.machine, 'requestMaxChars', totalOf(measureSurfaceEvents(log)) + tools + 900)
      limit(host.runtime.machine, 'requestOutputReserveChars', 0)
      limit(host.runtime.machine, 'requestMeasurementReserveChars', 0)
      // A tool result the model would see, rendered by the registry the Session registered.
      const tool = host.tools.get(master)!.get('orchestrator_read')!
      const result = { text: 'z'.repeat(4000) }
      const blocks = tool.output!.render({}, result) as { text: string }[]
      const offered = JSON.stringify(result).length
      expect(blocks[0]!.text.length).toBeLessThanOrEqual(900)
      expect(blocks[0]!.text).toContain(`${offered} characters withheld`)
      expect(host.runtime.sessions.pages(master).at(-1)).toMatchObject({ kind: 'tool-result', offered, room: 900, action: 'shrink' })
      // A message delivered to the same Session: 900 characters, because the tool definitions take the rest of that budget.
      await host.runtime.sessions.prompt(master, 'a-big-message', 'y'.repeat(4000), 'queue')
      const delivered = host.deliveries.mock.calls.at(-1)![0]
      expect(delivered.text.length).toBeLessThanOrEqual(900)
      expect(delivered.text).toContain('4000 characters withheld')
      expect(host.runtime.sessions.pages(master).at(-1)).toMatchObject({ kind: 'message', action: 'shrink' })
      // The constraint the estimate exists for: what was delivered, the tool definitions and the prompt are inside the budget.
      const asked = await host.ask(master)
      expect(asked.failures).toEqual([])
      const next = host.runtime.sessions.requests(master).at(-1)!
      expect(next).toMatchObject({ action: 'send' })
      expect(next.total).toBeLessThanOrEqual(next.budget)
      expect(next.parts.tools).toBe(tools)
      expect(next.parts.tools + next.parts.history + next.parts.system).toBeLessThanOrEqual(next.budget)
      expect(delivered.text.length).toBe(next.parts.history)
    } finally { await host.stop() }
  })

  it('charges a growing Session log the same way on every attempt, and suspends the one that no longer fits', async () => {
    const host = await startRuntime()
    try {
      const master = host.runtime.masterId
      const log = host.logs.get(master)!
      const grow = (chars: number) => log.push({ type: 'tool/result',
        data: { message: { content: [{ type: 'text', text: 'x'.repeat(chars) }] } } })
      // A budget that holds this Session's own prompt and tools with room for 3000 characters of log.
      const first = (await host.ask(master)).options
      const request = host.runtime.sessions.requests(master).at(-1)!
      const room = request.parts.history + 3000
      limit(host.runtime.machine, 'requestMaxChars', request.parts.system + JSON.stringify(first.tools).length + room)
      limit(host.runtime.machine, 'requestOutputReserveChars', 0)
      limit(host.runtime.machine, 'requestMeasurementReserveChars', 0)
      // Each attempt is a model request of its own — the retries of one step look the same — and each one is recorded.
      for (const chars of [1000, 1000, 1000]) {
        grow(chars)
        expect((await host.ask(master)).failures).toEqual([])
      }
      const recorded = host.runtime.sessions.requests(master)
      expect(recorded.every(record => record.action === 'send' || record.action === 'suspend')).toBe(true)
      for (const record of recorded.filter(item => item.action === 'send')) expect(record.total).toBeLessThanOrEqual(record.budget)
      expect(log.filter(event => event.type === 'tool/result')).toHaveLength(3)
      // The log alone grows past the budget: the next request is suspended and names what would have made it fit.
      grow(6000)
      const refused = await host.ask(master)
      expect(refused.failures).toEqual([expect.objectContaining({ message: expect.stringContaining('cutting toolResults by') })])
      const last = host.runtime.sessions.requests(master).at(-1)!
      expect(last).toMatchObject({ action: 'suspend', cut: { toolResults: expect.any(Number) } })
      expect(last.cut.toolResults).toBeGreaterThan(0)
      expect(host.runtime.sessions.requests(master).filter(record => record.action === 'send')
        .every(record => record.total <= record.budget)).toBe(true)
    } finally { await host.stop() }
  })

  it('refuses the compaction a Session needs to recover when that call is itself over the budget, as it refuses any other', async () => {
    const host = await startRuntime()
    try {
      const master = host.runtime.masterId
      const log = host.logs.get(master)!
      // A budget that holds this Session's own prompt and tools with 1000 characters to spare.
      const first = (await host.ask(master)).options
      const request = host.runtime.sessions.requests(master).at(-1)!
      limit(host.runtime.machine, 'requestMaxChars', request.parts.system + JSON.stringify(first.tools).length
        + request.parts.history + 1000)
      limit(host.runtime.machine, 'requestOutputReserveChars', 0)
      limit(host.runtime.machine, 'requestMeasurementReserveChars', 0)
      // A history over the budget refuses the turn that would have had to read it.
      log.push({ type: 'tool/result', data: { message: { content: [{ type: 'text', text: 'x'.repeat(2000) }] } } })
      expect((await host.ask(master)).failures).not.toEqual([])
      expect(host.runtime.sessions.requests(master).at(-1)).toMatchObject({ action: 'suspend' })
      // The housekeeping call that exists to shrink that history reads the same history: it is over the same budget, so it is
      // refused, and the record says which call it was. This is the exemption the review reproduced, gone.
      const asked = host.asked.mock.calls.length
      const compaction = await host.ask(master, { purpose: 'compaction' })
      expect(host.asked.mock.calls.length).toBe(asked)
      expect(compaction.failures).toEqual([expect.objectContaining({ code: 'REQUEST_OVER_BUDGET',
        message: expect.stringContaining("it is DSH's compaction call, held to the same limit") })])
      const refused = host.runtime.sessions.requests(master).at(-1)!
      expect(refused).toMatchObject({ action: 'suspend', purpose: 'compaction' })
      expect(refused.total).toBeGreaterThan(refused.budget)
      // No request of this Session was ever recorded as a recovery: an over-limit send is not one.
      const recorded = host.runtime.sessions.requests(master)
      expect(recorded.every(record => !('recovery' in record))).toBe(true)
      expect(recorded.every(record => record.action === 'suspend' || record.total <= record.budget)).toBe(true)
    } finally { await host.stop() }
  })

  it('publishes what the budget measured, refused and paged on the health board', async () => {
    const host = await startRuntime()
    try {
      const master = host.runtime.masterId, before = host.runtime.sessions.requests().length
      // The entry exists before this test measures anything, so an operator reading the board never meets a missing part.
      expect(host.runtime.health.budget).toBeDefined()
      expect((await host.ask(master)).failures).toEqual([])
      const record = host.runtime.sessions.requests(master).at(-1)!
      expect(host.runtime.health.budget!.detail).toContain(`${before + 1} requests: ${before + 1} sent, 0 suspended, 0 housekeeping`)
      expect(host.runtime.health.budget!.detail).toContain(`largest ${record.total} of ${record.budget} characters`)
      expect(host.runtime.health.budget!.detail).toContain(`last ${master} at ${record.total}`)
      // A refused request is published too, and a Session waiting on its budget reads as paused rather than ready.
      limit(host.runtime.machine, 'requestMaxChars', 1000)
      limit(host.runtime.machine, 'requestOutputReserveChars', 0)
      limit(host.runtime.machine, 'requestMeasurementReserveChars', 0)
      expect((await host.ask(master)).failures).not.toEqual([])
      expect(host.runtime.health.budget).toMatchObject({ state: 'paused' })
      expect(host.runtime.health.budget!.detail).toContain(`${before + 2} requests: ${before + 1} sent, 1 suspended, 0 housekeeping`)
      expect(host.runtime.health.budget!.detail).toContain('largest ')
      // The material the budget had to cut is part of the same account: what was offered and what was kept.
      await host.runtime.sessions.prompt(master, 'a-paged-message', 'y'.repeat(400), 'queue')
      const page = host.runtime.sessions.pages(master).at(-1)!
      expect(host.runtime.health.budget!.detail).toContain(`1 materials paged, ${page.kept} of ${page.offered} characters kept`)
      // A policy that cannot be used at all is an error rather than a wait, and says why.
      limit(host.runtime.machine, 'requestOutputReserveChars', 900)
      limit(host.runtime.machine, 'requestMeasurementReserveChars', 100)
      expect((await host.ask(master)).failures).not.toEqual([])
      expect(host.runtime.health.budget).toMatchObject({ state: 'error', detail: expect.stringContaining('not configured usefully') })
      // The management API publishes the same entry, which is how an operator reads the board.
      const state = await host.api('GET', 'state')
      expect((state.body.health as Record<string, { detail: string }>).budget!.detail).toContain('1 materials paged')
    } finally { await host.stop() }
  })

  it('plans a request that belongs to no Session with the same contract, for the background work that will use it', async () => {
    const host = await startRuntime()
    try {
      const budget = host.runtime.budget
      expect(budget.policy()).toMatchObject({ maxInputChars: 400_000 })
      const measured = only({ system: 100 })
      expect(budget.plan(measured)).toMatchObject({ action: 'send', budget: 360_000 })
      // A background request is recorded like any other, without a Session, and leaves its allowance on the budget.
      expect(budget.record(undefined, measuredRequest(measured))).toMatchObject({ action: 'send' })
      expect(host.runtime.sessions.requests().at(-1)).not.toHaveProperty('sessionId')
      expect(budget.allowance()).toBe(359_900)
    } finally { await host.stop() }
  })
})

describe('the request DeepSeek Harness finally hands its adapter', () => {
  /** The 9,000-character definition the review reproduced the defect with: nothing declares it now, and only the route's tool
   * history expands it back into the request. */
  const historical = { name: 'old_tool', description: 'x'.repeat(9000), parameters: { type: 'object', properties: {} } }
  /** The tool declarations the adapter receives for that history: one definition, so 2 characters of array around it. */
  const expanded = JSON.stringify([historical]).length
  /** Set a budget that leaves the request exactly `room` characters. */
  const budget = (host: Host, room: number) => {
    limit(host.runtime.machine, 'requestMaxChars', room + 200)
    limit(host.runtime.machine, 'requestOutputReserveChars', 100)
    limit(host.runtime.machine, 'requestMeasurementReserveChars', 100)
  }
  /** One request the loop could build: a five-character message and a tool history nothing declares. */
  const reproducing = (overrides: Partial<GenerateOptions> = {}) => ({ messages: [{ role: 'user' as const,
    content: [{ type: 'text' as const, text: 'hello' }] }], tools: [] as never[], toolHistory: { tools: [historical], updates: [] }, ...overrides })

  it('refuses the reviewed request the adapter would have expanded to 9,090 characters against an 800-character budget', async () => {
    const host = await startRuntime(undefined, { route: { toolUpdate: 'in-history' } })
    try {
      const master = host.runtime.masterId
      budget(host, 800)
      const asked = host.asked.mock.calls.length
      const answer = await host.ask(master, reproducing())
      // The five characters the caller declared are not the request: the adapter would have received the historical
      // definition too, so nothing is sent and the refusal names the part that is over.
      expect(host.asked.mock.calls.length).toBe(asked)
      expect(answer.failures).toEqual([expect.objectContaining({ code: 'REQUEST_OVER_BUDGET' })])
      const record = host.runtime.sessions.requests(master).at(-1)!
      expect(record).toMatchObject({ action: 'suspend', reason: 'requiredOverBudget' })
      expect(record.parts.tools).toBe(expanded)
      expect(record.total).toBe(expanded + 5)
      expect(record.total).toBeGreaterThan(record.budget)
    } finally { await host.stop() }
  })

  it('measures the request it lets through by what the adapter is handed, not by what the caller declared', async () => {
    const host = await startRuntime(undefined, { route: { toolUpdate: 'in-history' } })
    try {
      const master = host.runtime.masterId
      budget(host, expanded + 5 + 500)
      const answer = await host.ask(master, reproducing())
      expect(answer.failures).toEqual([])
      // Counted by the test from what the adapter was handed: one historical definition and one five-character message.
      const sent = host.asked.mock.calls.at(-1)![0]
      expect(JSON.stringify(sent.tools).length + 5).toBe(expanded + 5)
      const record = host.runtime.sessions.requests(master).at(-1)!
      expect(record).toMatchObject({ action: 'send' })
      expect(record.parts.tools).toBe(expanded)
      expect(record.total).toBe(expanded + 5)
      expect(record.total).toBeLessThanOrEqual(record.budget)
      // The record keeps the account: nothing was declared now, and the route's expansion is where those characters came from.
      expect(record.expansion).toMatchObject({ toolUpdate: 'in-history', declared: 0, history: expanded })
    } finally { await host.stop() }
  })

  it('measures a Worker\'s request the same way, and a background request that belongs to no Session', async () => {
    const host = await startRuntime(undefined, { route: { toolUpdate: 'in-history' } })
    try {
      const ticket = await host.acceptedTicket(feishu('1', '@bot fix the regression'))
      // The Worker's own request: the same history would have reached its adapter, so it is refused at the same boundary.
      budget(host, 800)
      const asked = host.asked.mock.calls.length
      expect((await host.ask(ticket.sessionId, reproducing())).failures).not.toEqual([])
      expect(host.asked.mock.calls.length).toBe(asked)
      expect(host.runtime.sessions.requests(ticket.sessionId).at(-1)).toMatchObject({ sessionId: ticket.sessionId, action: 'suspend' })
      // An independent background call is dispatched through the same waterfall and measured by the same contract, without a
      // Session: the system text it sends alone is over the budget.
      const background = (system: string): GenerateOptions => ({ provider: 'deepseek', model: 'deepseek-chat', system,
        messages: [{ role: 'user', content: [{ type: 'text', text: 'score it' }] }] })
      const refused = await host.streamed(background('s'.repeat(2000)))
      expect(refused.failures).not.toEqual([])
      expect(host.asked.mock.calls.length).toBe(asked)
      expect(host.runtime.sessions.requests().at(-1)).toMatchObject({ action: 'suspend' })
      expect(host.runtime.sessions.requests().at(-1)).not.toHaveProperty('sessionId')
      // The same call with what fits is sent, and recorded the same way.
      expect((await host.streamed(background('short'))).failures).toEqual([])
      const recorded = host.runtime.sessions.requests().at(-1)!
      expect(recorded).toMatchObject({ action: 'send' })
      expect(recorded).not.toHaveProperty('sessionId')
      expect(recorded.total).toBeLessThanOrEqual(recorded.budget)
    } finally { await host.stop() }
  })

  it('sends a request that is exactly at the budget and refuses the same request one character over', async () => {
    const host = await startRuntime(undefined, { route: { toolUpdate: 'in-history' } })
    try {
      const master = host.runtime.masterId
      budget(host, expanded + 5)
      expect((await host.ask(master, reproducing())).failures).toEqual([])
      expect(host.runtime.sessions.requests(master).at(-1)).toMatchObject({ action: 'send', total: expanded + 5 })
      budget(host, expanded + 5 - 1)
      expect((await host.ask(master, reproducing())).failures).not.toEqual([])
      const refused = host.runtime.sessions.requests(master).at(-1)!
      expect(refused).toMatchObject({ action: 'suspend', total: expanded + 5, budget: expanded + 4 })
      expect(refused.total - refused.budget).toBe(1)
    } finally { await host.stop() }
  })

  it('sends a compaction call that is exactly at the budget and refuses the same call one character over', async () => {
    const host = await startRuntime(undefined, { route: { toolUpdate: 'in-history' } })
    try {
      const master = host.runtime.masterId
      budget(host, expanded + 5)
      expect((await host.ask(master, reproducing({ purpose: 'compaction' }))).failures).toEqual([])
      expect(host.runtime.sessions.requests(master).at(-1)).toMatchObject({ action: 'send', purpose: 'compaction', total: expanded + 5 })
      // The same housekeeping call one character over is refused at the boundary like any other, and the adapter never sees it.
      budget(host, expanded + 5 - 1)
      const asked = host.asked.mock.calls.length
      expect((await host.ask(master, reproducing({ purpose: 'compaction' }))).failures).not.toEqual([])
      expect(host.asked.mock.calls.length).toBe(asked)
      expect(host.runtime.sessions.requests(master).at(-1)).toMatchObject({ action: 'suspend', purpose: 'compaction' })
    } finally { await host.stop() }
  })

  it('measures a retry of the same request again, and never sends the one that does not fit', async () => {
    const host = await startRuntime(undefined, { route: { toolUpdate: 'in-history' } })
    try {
      const master = host.runtime.masterId
      budget(host, 800)
      const asked = host.asked.mock.calls.length
      for (const _ of [1, 2]) expect((await host.ask(master, reproducing())).failures).not.toEqual([])
      expect(host.asked.mock.calls.length).toBe(asked)
      expect(host.runtime.sessions.requests(master).map(record => record.action)).toEqual(['suspend', 'suspend'])
      // A retry of a request that fits is measured again and sent again: every attempt is a request of its own.
      budget(host, expanded + 5 + 500)
      for (const _ of [1, 2]) expect((await host.ask(master, reproducing())).failures).toEqual([])
      const sent = host.runtime.sessions.requests(master).filter(record => record.action === 'send')
      expect(sent).toHaveLength(2)
      expect(sent.every(record => record.total <= record.budget)).toBe(true)
      expect(sent.map(record => record.total)).toEqual([expanded + 5, expanded + 5])
    } finally { await host.stop() }
  })

  it('refuses a request whose final input it cannot establish instead of reporting a budget it kept', async () => {
    const host = await startRuntime(undefined, { route: { toolUpdate: 'in-history', unresolved: true } })
    try {
      const master = host.runtime.masterId
      budget(host, 800)
      const asked = host.asked.mock.calls.length
      const answer = await host.ask(master, reproducing())
      // The route decides this request: without its metadata nobody can say what DSH would declare, so nothing is sent.
      expect(host.asked.mock.calls.length).toBe(asked)
      expect(answer.failures).toEqual([expect.objectContaining({ code: 'REQUEST_OVER_BUDGET',
        message: expect.stringContaining('the model route it would be sent on could not be resolved') })])
      expect(host.runtime.sessions.requests(master).at(-1)).toMatchObject({ action: 'suspend', reason: 'unmeasured',
        unmeasured: 'routeUnresolved' })
      expect(host.runtime.health.budget).toMatchObject({ state: 'error',
        detail: expect.stringContaining('its final size could not be measured') })
      // A request the route cannot change is measurable without one, so the same unresolvable route still carries it.
      const plain = await host.ask(master, { messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }], tools: [] as never[] })
      expect(plain.failures).toEqual([])
      expect(host.runtime.sessions.requests(master).at(-1)).toMatchObject({ action: 'send', total: 5 })
      // A file is the other input only the adapter dispatch can resolve the text of.
      const file = await host.ask(master, { messages: [{ role: 'user', content: [{ type: 'file',
        attachment: { attachmentId: 'sha256:0123456789abcdef', name: 'report.txt', bytes: 12 } }] as never[] }], tools: [] as never[] })
      expect(file.failures).toEqual([expect.objectContaining({ message: expect.stringContaining('carries a file') })])
      expect(host.runtime.sessions.requests(master).at(-1)).toMatchObject({ reason: 'unmeasured', unmeasured: 'fileProjection' })
    } finally { await host.stop() }
  })

  it('does not bill a historical definition the route ignores, and bills a declared one once', async () => {
    // A route that reads no tool history receives the complete current list: the Session's history is not in its request.
    const ignoring = await startRuntime()
    try {
      const master = ignoring.runtime.masterId
      budget(ignoring, 800)
      expect((await ignoring.ask(master, reproducing())).failures).toEqual([])
      const record = ignoring.runtime.sessions.requests(master).at(-1)!
      expect(record).toMatchObject({ action: 'send', total: 5 })
      expect(record.parts.tools).toBe(0)
      expect(ignoring.asked.mock.calls.at(-1)![0].tools).toEqual([])
      // The record still says what the history held, and that this route did not declare it.
      expect(record.expansion).toMatchObject({ declared: 0, history: expanded })
      expect(record.expansion?.toolUpdate).toBeUndefined()
    } finally { await ignoring.stop() }
    // A route that reads it declares the definition however it was reached: declared and historically expanded is one entry.
    const reads = await startRuntime(undefined, { route: { toolUpdate: 'in-history' } })
    try {
      const master = reads.runtime.masterId
      budget(reads, 800)
      const answer = await reads.ask(master, reproducing({ tools: [historical] as never[] }))
      expect(answer.failures).not.toEqual([])
      const record = reads.runtime.sessions.requests(master).at(-1)!
      expect(record.parts.tools).toBe(expanded)
      expect(record.expansion).toMatchObject({ toolUpdate: 'in-history', declared: expanded, history: expanded })
      // Twice the declarations would be twice these characters; the projected list holds the definition once.
      expect(record.parts.tools).toBeLessThan(2 * expanded)
    } finally { await reads.stop() }
  })

  it('counts a deferred definition the route declares and none it drops', async () => {
    const deferred = { name: 'later_tool', description: 'y'.repeat(3000), parameters: { type: 'object', properties: {} },
      deferLoading: true as const }
    // Without tool history DSH strips the deferral and declares the definition, so it is part of the request.
    const plain = await startRuntime()
    try {
      budget(plain, 800)
      const answer = await plain.ask(plain.runtime.masterId, { messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
        tools: [deferred] as never[] })
      expect(answer.failures).not.toEqual([])
      const sent = plain.asked.mock.calls.at(-1)?.[0]
      expect(sent).toBeUndefined()
      expect(plain.runtime.sessions.requests(plain.runtime.masterId).at(-1)!.parts.tools)
        .toBe(JSON.stringify([{ name: deferred.name, description: deferred.description, parameters: deferred.parameters }]).length)
    } finally { await plain.stop() }
    // On a route that reads tool history the declarations come from that history, so a deferred definition it never declared
    // is not in the request at all — and the same five-character request fits.
    const historyRoute = await startRuntime(undefined, { route: { toolUpdate: 'in-history' } })
    try {
      budget(historyRoute, 800)
      expect((await historyRoute.ask(historyRoute.runtime.masterId, { messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
        tools: [deferred] as never[], toolHistory: { tools: [], updates: [] } })).failures).toEqual([])
      expect(historyRoute.runtime.sessions.requests(historyRoute.runtime.masterId).at(-1)!.parts.tools).toBe(0)
      expect(historyRoute.asked.mock.calls.at(-1)![0].tools).toEqual([])
    } finally { await historyRoute.stop() }
  })

  it('pages delivered material against the definitions the route declares, not the ones the caller declared', async () => {
    const host = await startRuntime(undefined, { route: { toolUpdate: 'in-history' } })
    try {
      const master = host.runtime.masterId
      // 900 characters of room beside the request the route finally assembles: the expanded definitions are already in it.
      budget(host, expanded + 5 + 900)
      expect((await host.ask(master, reproducing())).failures).toEqual([])
      expect(host.runtime.sessions.requests(master).at(-1)!.parts.tools).toBe(expanded)
      // A message the runtime delivers after that request is paged to what the expanded definitions leave, so the next request
      // cannot grow past the budget through material this runtime added. The Session's log holds nothing yet, so the room is the
      // budget less the definitions the route declares.
      await host.runtime.sessions.prompt(master, 'after-the-expansion', 'y'.repeat(4000), 'queue')
      const page = host.runtime.sessions.pages(master).at(-1)!
      expect(page).toMatchObject({ kind: 'message', action: 'shrink', room: 905 })
      expect(page.kept).toBeLessThanOrEqual(905)
      const delivered = host.deliveries.mock.calls.at(-1)![0].text
      expect(delivered.length).toBeLessThanOrEqual(905)
      // What the runtime added and the definitions the route declares stay inside the budget the Session's request was held to.
      const record = host.runtime.sessions.requests(master).at(-1)!
      expect(record.total - 5 + delivered.length).toBeLessThanOrEqual(record.budget)
    } finally { await host.stop() }
  })

  it('bills a removed definition only on the route that keeps declaring it', async () => {
    const gone = { name: 'gone_tool', description: 'z'.repeat(4000), parameters: { type: 'object', properties: {} } }
    /** A request whose developer message removes a definition the history still holds, as DSH's loop records it. */
    const removing = { messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] },
      { role: 'developer', id: 'removal-1', content: [{ type: 'tool-removal', toolName: 'gone_tool' }] }],
    tools: [], toolHistory: { tools: [gone], updates: [{ messageId: 'removal-1', additions: [] }] } } as unknown as Partial<GenerateOptions>
    // A route that reads the removal in history keeps the definition declared and passes the removal on: it is in the request.
    const reading = await startRuntime(undefined, { route: { toolUpdate: 'in-history' } })
    try {
      budget(reading, 800)
      expect((await reading.ask(reading.runtime.masterId, removing)).failures).not.toEqual([])
      expect(reading.runtime.sessions.requests(reading.runtime.masterId).at(-1)!.parts.tools).toBe(JSON.stringify([gone]).length)
    } finally { await reading.stop() }
    // A route that only adds declarations drops the removal and no longer declares the definition: it is not billed at all.
    const adding = await startRuntime(undefined, { route: { toolUpdate: 'addition-only' } })
    try {
      budget(adding, 800)
      expect((await adding.ask(adding.runtime.masterId, removing)).failures).toEqual([])
      const record = adding.runtime.sessions.requests(adding.runtime.masterId).at(-1)!
      expect(record).toMatchObject({ action: 'send', total: 5 })
      expect(record.parts.tools).toBe(0)
      expect(adding.asked.mock.calls.at(-1)![0].tools).toEqual([])
    } finally { await adding.stop() }
  })

  it('publishes what the final measurement found, and which expansion produced a refusal', async () => {
    const host = await startRuntime(undefined, { route: { toolUpdate: 'in-history' } })
    try {
      const master = host.runtime.masterId
      budget(host, 800)
      expect((await host.ask(master, reproducing())).failures).not.toEqual([])
      const detail = host.runtime.health.budget!.detail
      expect(detail).toContain(`tool definitions ${expanded} of 0 declared and ${expanded} in the Session's tool history`)
      expect(detail).toContain('refused because its required parts alone are over the budget')
      expect(detail).toContain('1 suspended')
      // The management API publishes the same entry, which is how an operator reads the board.
      const state = await host.api('GET', 'state')
      expect((state.body.health as Record<string, { detail: string }>).budget!.detail)
        .toContain(`tool definitions ${expanded} of 0 declared`)
    } finally { await host.stop() }
  })
})
