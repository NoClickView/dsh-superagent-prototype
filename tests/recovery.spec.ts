/**
 * Bounded recovery of a Session whose history is over its input budget: the states it moves through, the steps each of which is a
 * model request this runtime measures and sends only when it fits, the one it refuses, what survives an interrupted step, and the
 * Session title that is deferred or skipped instead of sent over the limit.
 */
import { describe, expect, it } from 'vitest'
import { feishu, startRuntime } from './fixtures/host.ts'
import type { Host } from './fixtures/host.ts'

/** Set a volatile machine limit as the loader would, to reach a budget the defaults never reach. */
const limit = (machine: Host['runtime']['machine'],
  name: 'requestMaxChars' | 'requestOutputReserveChars' | 'requestMeasurementReserveChars', value: number) =>
  (machine[name] as unknown as { set(next: number): void }).set(value)

/** A budget of `room` characters beside what this Session's own prompt and tool declarations already take. */
const budgetOfRoom = (host: Host, room: number) => {
  const record = host.runtime.sessions.requests(host.runtime.masterId).at(-1)!
  limit(host.runtime.machine, 'requestMaxChars', record.parts.system + record.parts.tools + room)
  limit(host.runtime.machine, 'requestOutputReserveChars', 0)
  limit(host.runtime.machine, 'requestMeasurementReserveChars', 0)
}

/**
 * The system prompt at the head of the Session's log, as DSH records it when the Session starts: it is the one surface node no
 * compaction targets, so a Session whose log already holds what its first turn took gets it in front, where DSH would have put it.
 */
const recordPrompt = (host: Host, sessionId: string) =>
  host.logs.get(sessionId)!.unshift({ type: 'system/message',
    data: { message: { content: [{ type: 'text', text: host.sections.get(sessionId)!.text({}) }] } } })

/** `count` tool results of `chars` characters, as a Session log grows them. */
const recordResults = (host: Host, sessionId: string, count: number, chars: number) => {
  for (let index = 0; index < count; index++) host.logs.get(sessionId)!.push({ type: 'tool/result',
    data: { message: { content: [{ type: 'text', text: `${index}`.padEnd(chars, 'x') }] } } })
}

describe('a Session whose history is over its input budget', () => {
  it('recovers by compacting that history in bounded steps, and then continues ordinary requests', async () => {
    const host = await startRuntime()
    try {
      const master = host.runtime.masterId
      recordPrompt(host, master)
      // A first ordinary request: its record is what the budget is sized from, as an operator reads it.
      expect((await host.ask(master)).failures).toEqual([])
      const overhead = host.runtime.sessions.requests(master).at(-1)!
      // 6000 characters of tool results against a budget that leaves 1500 of them room: a turn that would read them is refused.
      recordResults(host, master, 6, 1000)
      budgetOfRoom(host, 1500)
      const asked = host.asked.mock.calls.length
      const refused = await host.ask(master)
      expect(refused.failures).not.toEqual([])
      // The turn that was over its budget reached no adapter: what the adapter was asked for after it is the compaction steps, and
      // nothing else. An over-limit request is never the one that is sent.
      const stepCalls = host.asked.mock.calls.slice(asked)
      expect(stepCalls.every(([options]) => options.purpose === 'compaction')).toBe(true)
      expect(host.runtime.sessions.requests(master).filter(record => record.action === 'suspend')).toHaveLength(1)
      // The runtime recovered the Session through DSH's own compaction, one measured step at a time.
      const report = await host.runtime.sessions.awaitRecovery(master)
      expect(report).toMatchObject({ state: 'recovered' })
      expect(stepCalls).toHaveLength(report!.steps)
      expect(report!.steps).toBeGreaterThan(0)
      expect(report!.after).toBeLessThan(report!.before)
      // Every step was a model request this runtime measured and let through only because it fitted, and the adapter saw it.
      const steps = host.runtime.sessions.requests(master).filter(record => record.purpose === 'compaction' && record.action === 'send')
      expect(steps).toHaveLength(report!.steps)
      expect(steps.every(step => step.total <= step.budget)).toBe(true)
      expect(host.dsh.compaction.runs.filter(run => run.committed)).toHaveLength(report!.steps)
      // Recovery is observably in progress while it runs, and the state it settled in is published once it is done.
      expect(host.dsh.compaction.observed).toContain('recovering')
      expect(host.runtime.sessions.recoveryNow(master)).toMatchObject({ state: 'recovered' })
      expect(host.runtime.health.budget!.detail).toContain(`the recovery of ${master} is recovered after ${report!.steps} step(s)`)
      // The next ordinary request fits, and the test cleared nothing: every original event is still in the log.
      const next = await host.ask(master)
      expect(next.failures).toEqual([])
      const sent = host.runtime.sessions.requests(master).at(-1)!
      expect(sent).toMatchObject({ action: 'send' })
      expect(sent.total).toBeLessThanOrEqual(sent.budget)
      expect(host.logs.get(master)!.filter(event => event.type === 'tool/result')).toHaveLength(6)
      // The surface the model sees is the smaller one: the committed replacements shadow what they replaced, and the prompt the
      // Session authorizes itself with is still at the head of it, untouched.
      const surface = host.surfaceOf(host.logs.get(master)!)
      expect(surface.filter(event => event.type === 'tool/result').length).toBeLessThan(6)
      expect(surface.some(event => event.type === 'user/message')).toBe(true)
      expect(surface[0]).toMatchObject({ type: 'system/message' })
      // No range was committed twice, and no request was ever recorded as a recovery that succeeded.
      const committed = host.dsh.compaction.runs.filter(run => run.committed).map(run => `${run.start}-${run.end}`)
      expect(new Set(committed).size).toBe(committed.length)
      expect(host.runtime.sessions.requests(master).every(record => !('recovery' in record))).toBe(true)
      expect(host.runtime.sessions.requests(master).filter(record => record.action === 'send')
        .every(record => record.total <= record.budget)).toBe(true)
    } finally { await host.stop() }
  })

  it('measures the room it leaves by what the model sees, so a new instruction and a recall notice still fit', async () => {
    const host = await startRuntime()
    try {
      const master = host.runtime.masterId
      recordPrompt(host, master)
      expect((await host.ask(master)).failures).toEqual([])
      recordResults(host, master, 6, 1000)
      budgetOfRoom(host, 1500)
      expect((await host.ask(master)).failures).not.toEqual([])
      expect(await host.runtime.sessions.awaitRecovery(master)).toMatchObject({ state: 'recovered' })
      // The log still holds every tool result the recovery compacted away: measuring it would count history the model no longer sees.
      expect(host.logs.get(master)!.filter(event => event.type === 'tool/result')).toHaveLength(6)
      // What the next real request leaves is the room delivered material is paged to, and it is not zero.
      expect((await host.ask(master)).failures).toEqual([])
      const sent = host.runtime.sessions.requests(master).at(-1)!
      const free = sent.budget - sent.total
      expect(free).toBeGreaterThan(200)
      // The reviewer's reproduction had characters free while the recalled-material allowance was zero, because that allowance was
      // measured against the replaced log. It is the room the real request leaves, so a notice earns it.
      expect(host.runtime.memory.allowance(master)).toBeGreaterThan(200)
      // A new instruction of 25 characters reaches the model whole rather than being paged away against history it cannot see.
      const instruction = 'rebase onto the current tip'
      expect(instruction.length).toBeLessThan(80)
      await host.runtime.sessions.prompt(master, 'trigger/after-recovery', instruction, 'steer')
      expect(host.deliveries.mock.calls.at(-1)![0]).toMatchObject({ sessionId: master, mode: 'steer', text: instruction })
      // A recalled-memory notice inside that room lands whole as well, which is the other half of the same measurement: recall joins
      // the history as injected context, and nothing was withheld from it.
      const notice = JSON.stringify({ kind: 'recall', items: [{ id: 'f'.repeat(32), text: 'a remembered report '.repeat(9) }] })
      expect(notice.length).toBeLessThanOrEqual(host.runtime.memory.allowance(master))
      const pages = host.runtime.sessions.pages(master).length
      await host.runtime.sessions.prompt(master, 'recall/after-recovery', notice, 'recall')
      expect(host.agents.get(master)!.inject.mock.calls.at(-1)![0].content).toMatchObject([{ type: 'text', text: notice }])
      expect(host.runtime.sessions.pages(master)).toHaveLength(pages)
    } finally { await host.stop() }
  })

  it('settles recovered when the last step the budget allows is the one that made the Session fit', async () => {
    const host = await startRuntime()
    try {
      const master = host.runtime.masterId
      recordPrompt(host, master)
      expect((await host.ask(master)).failures).toEqual([])
      // Nine results of 1000 characters against 1500 of room: every step replaces one of them, so the eighth is the one that fits.
      recordResults(host, master, 9, 1000)
      budgetOfRoom(host, 1500)
      // A title the budget cannot carry yet is deferred, and it is waiting for exactly this recovery.
      expect((await host.ask(master, { purpose: 'session-title' })).failures).not.toEqual([])
      expect(host.runtime.sessions.title(master)).toMatchObject({ state: 'deferred' })
      expect((await host.ask(master)).failures).not.toEqual([])
      // The step budget ran out on a step that succeeded, so the state is the one the measurement gives, not the count.
      const report = await host.runtime.sessions.awaitRecovery(master)
      expect(report).toMatchObject({ state: 'recovered', steps: 8 })
      expect(host.dsh.compaction.runs.filter(run => run.committed)).toHaveLength(8)
      expect(host.runtime.sessions.recoveryNow(master)).toMatchObject({ state: 'recovered' })
      // And the title it deferred is retried, because the Session really does fit now: nothing waits for work already done.
      await host.runtime.sessions.settled()
      expect(host.dsh.title.refreshes).toContain(master)
      expect(host.runtime.sessions.title(master)).toMatchObject({ state: 'sent' })
      expect((await host.ask(master)).failures).toEqual([])
    } finally { await host.stop() }
  })

  it('pauses after the last step the budget allows only when the Session genuinely still does not fit', async () => {
    const host = await startRuntime()
    try {
      const master = host.runtime.masterId
      recordPrompt(host, master)
      expect((await host.ask(master)).failures).toEqual([])
      // Twenty results of 1000 characters: eight steps take 8,000 of them and leave the Session over the budget it is held to.
      recordResults(host, master, 20, 1000)
      budgetOfRoom(host, 1500)
      expect((await host.ask(master)).failures).not.toEqual([])
      const report = await host.runtime.sessions.awaitRecovery(master)
      expect(report).toMatchObject({ state: 'paused', steps: 8 })
      expect(report!.reason).toContain('8 compaction steps')
      expect(report!.reason).toContain('still over its budget')
      expect(host.dsh.compaction.runs.filter(run => run.committed)).toHaveLength(8)
      // The pause is the truth of the surface, not the step count: what is left of the history is still above the budget.
      expect(report!.after).toBeGreaterThan(report!.before - 9000)
      expect(host.runtime.sessions.requests(master).every(record => record.action === 'suspend' || record.total <= record.budget)).toBe(true)
    } finally { await host.stop() }
  })

  it('refuses an independent background request over the budget, as it refuses one of a Session', async () => {
    const host = await startRuntime()
    try {
      limit(host.runtime.machine, 'requestMaxChars', 1000)
      limit(host.runtime.machine, 'requestOutputReserveChars', 0)
      limit(host.runtime.machine, 'requestMeasurementReserveChars', 0)
      const asked = host.asked.mock.calls.length
      const refused = await host.streamed({ provider: 'deepseek', model: 'deepseek-chat', system: 's'.repeat(2000),
        messages: [{ role: 'user', content: [{ type: 'text', text: 'score it' }] }] })
      expect(host.asked.mock.calls.length).toBe(asked)
      expect(refused.failures).toEqual([expect.objectContaining({ code: 'REQUEST_OVER_BUDGET' })])
      expect(host.runtime.sessions.requests().at(-1)).toMatchObject({ action: 'suspend' })
      // It belongs to no Session, so there is no history the runtime could compact: the refusal is the whole answer.
      expect(host.runtime.sessions.requests().at(-1)).not.toHaveProperty('sessionId')
    } finally { await host.stop() }
  })

  it('pauses explicitly when even the smallest compaction step cannot fit, and never sends one over the limit', async () => {
    const host = await startRuntime()
    try {
      const master = host.runtime.masterId
      recordPrompt(host, master)
      expect((await host.ask(master)).failures).toEqual([])
      recordResults(host, master, 3, 1000)
      // No room for any history at all: the smallest step still carries the prompt and the tool definitions.
      budgetOfRoom(host, 0)
      const asked = host.asked.mock.calls.length
      expect((await host.ask(master)).failures).not.toEqual([])
      const report = await host.runtime.sessions.awaitRecovery(master)
      expect(report).toMatchObject({ state: 'paused' })
      expect(report!.reason).toContain('budget')
      expect(report!.steps).toBe(0)
      // Nothing was sent, and the history the Session had is untouched: a paused recovery corrupts nothing.
      expect(host.asked.mock.calls.length).toBe(asked)
      expect(host.logs.get(master)!.filter(event => event.type === 'tool/result')).toHaveLength(3)
      expect(host.dsh.compaction.runs.filter(run => run.committed)).toEqual([])
      expect(host.runtime.sessions.recoveryNow(master)).toMatchObject({ state: 'paused' })
    } finally { await host.stop() }
  })

  it('pauses for a refusal no compaction can repair, naming the true cause instead of claiming a recovery', async () => {
    const host = await startRuntime()
    try {
      const master = host.runtime.masterId
      recordPrompt(host, master)
      expect((await host.ask(master)).failures).toEqual([])
      /** A request the runtime cannot size: a file whose model-visible text only the adapter dispatch resolves. */
      const withFile = { messages: [{ role: 'user' as const, content: [{ type: 'file',
        attachment: { attachmentId: 'sha256:0123456789abcdef', name: 'report.txt', bytes: 12 } }] as never[] }] }
      // Room to spare, so the surface this runtime can measure fits and an ordinary request would be sent — the request that was
      // refused is one nothing here can make smaller, because its final size is the thing that could not be established.
      budgetOfRoom(host, 1500)
      const asked = host.asked.mock.calls.length
      const refused = await host.ask(master, withFile)
      expect(refused.failures).toEqual([expect.objectContaining({ message: expect.stringContaining('carries a file') })])
      expect(host.asked.mock.calls.length).toBe(asked)
      // No recovery is claimed: the Session is paused with the reason that made the request unmeasurable, and no compaction ran.
      const report = await host.runtime.sessions.awaitRecovery(master)
      expect(report).toMatchObject({ state: 'paused', steps: 0 })
      expect(report!.reason).toContain('could not be established')
      expect(report!.reason).not.toContain('required parts')
      expect(host.dsh.compaction.runs).toEqual([])
      // The note says the pause, not a recovery: the very same request is refused again, so a claim that it now fits is false.
      expect(refused.failures[0]!.message).not.toContain('recovered in')
      expect(refused.failures[0]!.message).toContain('the Session is paused')
      expect((await host.ask(master, withFile)).failures).not.toEqual([])
      expect(host.asked.mock.calls.length).toBe(asked)
      expect(host.runtime.sessions.recoveryNow(master)).toMatchObject({ state: 'paused' })
      // A budget the Session's own prompt and tool declarations already exceed is not the reason either: the request is refused
      // because it cannot be measured, and that is what the record and the report have to say.
      limit(host.runtime.machine, 'requestMaxChars', 1000)
      limit(host.runtime.machine, 'requestOutputReserveChars', 0)
      limit(host.runtime.machine, 'requestMeasurementReserveChars', 0)
      expect((await host.ask(master, withFile)).failures).not.toEqual([])
      const smaller = await host.runtime.sessions.awaitRecovery(master)
      expect(smaller).toMatchObject({ state: 'paused', steps: 0 })
      expect(smaller!.reason).not.toContain('required parts')
      expect(smaller!.reason).toContain('could not be established')
      expect(host.dsh.compaction.runs).toEqual([])
    } finally { await host.stop() }
  })

  it('pauses with the reason the required parts give, when compacting the history could not have helped', async () => {
    const host = await startRuntime()
    try {
      const master = host.runtime.masterId
      recordPrompt(host, master)
      expect((await host.ask(master)).failures).toEqual([])
      recordResults(host, master, 3, 1000)
      // A budget its own prompt and tool declarations already exceed: the history is what a recovery could compact, and it is not
      // what the refusal is about.
      limit(host.runtime.machine, 'requestMaxChars', 1000)
      limit(host.runtime.machine, 'requestOutputReserveChars', 0)
      limit(host.runtime.machine, 'requestMeasurementReserveChars', 0)
      const asked = host.asked.mock.calls.length
      const refused = await host.ask(master)
      expect(host.runtime.sessions.requests(master).at(-1)).toMatchObject({ action: 'suspend', reason: 'requiredOverBudget' })
      expect(host.asked.mock.calls.length).toBe(asked)
      const report = await host.runtime.sessions.awaitRecovery(master)
      expect(report).toMatchObject({ state: 'paused', steps: 0 })
      expect(report!.reason).toContain('its required parts alone are over the budget')
      expect(host.dsh.compaction.runs).toEqual([])
      expect(refused.failures[0]!.message).toContain('the Session is paused')
      expect(refused.failures[0]!.message).not.toContain('recovered in')
    } finally { await host.stop() }
  })

  it('pauses when the input budget cannot be used at all, with no request and no compaction step sent', async () => {
    const host = await startRuntime()
    try {
      const master = host.runtime.masterId
      recordPrompt(host, master)
      expect((await host.ask(master)).failures).toEqual([])
      recordResults(host, master, 2, 1000)
      // The reserves take the whole budget: a configuration the settings refuse, which the boundary must not invent around.
      limit(host.runtime.machine, 'requestMaxChars', 1000)
      limit(host.runtime.machine, 'requestOutputReserveChars', 900)
      limit(host.runtime.machine, 'requestMeasurementReserveChars', 100)
      const asked = host.asked.mock.calls.length
      expect((await host.ask(master)).failures).not.toEqual([])
      const report = await host.runtime.sessions.awaitRecovery(master)
      expect(report).toMatchObject({ state: 'paused' })
      expect(report!.reason).toContain('not configured usefully')
      // A housekeeping call is refused for the same reason, whatever its purpose: an unusable budget holds every request.
      expect((await host.ask(master, { purpose: 'compaction' })).failures)
        .toEqual([expect.objectContaining({ message: expect.stringContaining('not configured usefully') })])
      expect(host.asked.mock.calls.length).toBe(asked)
      expect(host.dsh.compaction.runs).toEqual([])
      expect(host.runtime.sessions.recoveryNow(master)).toMatchObject({ state: 'paused' })
    } finally { await host.stop() }
  })

  it('keeps the recoverable history intact when a step is interrupted, and its retry commits nothing twice', async () => {
    const host = await startRuntime()
    try {
      const master = host.runtime.masterId
      recordPrompt(host, master)
      expect((await host.ask(master)).failures).toEqual([])
      recordResults(host, master, 6, 1000)
      budgetOfRoom(host, 1500)
      // The second compaction step is interrupted before it commits: the first one stands, the interrupted one changed nothing.
      host.dsh.compaction.interruptAfter = 1
      expect((await host.ask(master)).failures).not.toEqual([])
      const pausedReport = await host.runtime.sessions.awaitRecovery(master)
      expect(pausedReport).toMatchObject({ state: 'paused' })
      expect(pausedReport!.reason).toContain('interrupted')
      expect(pausedReport!.steps).toBe(1)
      const committed = host.dsh.compaction.runs.filter(run => run.committed)
      expect(committed).toHaveLength(1)
      expect(host.dsh.compaction.runs.filter(run => !run.committed)).toHaveLength(1)
      // The failed transaction left its bracket and no replacement: the history it selected is still readable in the log.
      expect(host.logs.get(master)!.some(event => event.type === 'compaction/end'
        && (event.data as { error?: string }).error !== undefined)).toBe(true)
      // The retry is another ordinary turn: refused, which resumes recovery from the surface that is left.
      host.dsh.compaction.interruptAfter = undefined
      expect((await host.ask(master)).failures).not.toEqual([])
      const retry = await host.runtime.sessions.awaitRecovery(master)
      expect(retry).toMatchObject({ state: 'recovered' })
      const ranges = host.dsh.compaction.runs.filter(run => run.committed).map(run => `${run.start}-${run.end}`)
      expect(new Set(ranges).size).toBe(ranges.length)
      expect(ranges.length).toBeGreaterThan(1)
      expect((await host.ask(master)).failures).toEqual([])
    } finally { await host.stop() }
  })

  it('defers a Session title the budget cannot fit, and retries it once the Session has recovered', async () => {
    const host = await startRuntime()
    try {
      const master = host.runtime.masterId
      recordPrompt(host, master)
      expect((await host.ask(master)).failures).toEqual([])
      recordResults(host, master, 6, 1000)
      budgetOfRoom(host, 1500)
      // A title call is a housekeeping request like any other: over the budget it is refused, never sent.
      const asked = host.asked.mock.calls.length
      expect((await host.ask(master, { purpose: 'session-title' })).failures).not.toEqual([])
      expect(host.asked.mock.calls.length).toBe(asked)
      const refused = host.runtime.sessions.requests(master).filter(record => record.purpose === 'session-title').at(-1)!
      expect(refused).toMatchObject({ action: 'suspend', purpose: 'session-title' })
      // It is deferred, not lost, and the ordinary work is not blocked by it: the same Session recovers and answers.
      expect(host.runtime.sessions.title(master)).toMatchObject({ state: 'deferred' })
      expect((await host.ask(master)).failures).not.toEqual([])
      expect(await host.runtime.sessions.awaitRecovery(master)).toMatchObject({ state: 'recovered' })
      // Once the Session fits, the deferred title is retried through DSH's own title service, and that request fitted too.
      await host.runtime.sessions.settled()
      expect(host.dsh.title.refreshes).toContain(master)
      const retried = host.runtime.sessions.requests(master).filter(record => record.purpose === 'session-title').at(-1)!
      expect(retried).toMatchObject({ action: 'send' })
      expect(retried.total).toBeLessThanOrEqual(retried.budget)
      expect(host.runtime.sessions.title(master)).toMatchObject({ state: 'sent' })
      expect((await host.ask(master)).failures).toEqual([])
    } finally { await host.stop() }
  })

  it('records a title the budget refuses while a recovery runs, as the deferral it is, and still retries it after', async () => {
    const host = await startRuntime()
    try {
      const master = host.runtime.masterId
      recordPrompt(host, master)
      expect((await host.ask(master)).failures).toEqual([])
      recordResults(host, master, 6, 1000)
      budgetOfRoom(host, 1500)
      // DSH names a Session while this runtime is compacting it: the title request is over the budget at that instant, and it is a
      // request no recovery may hold up and none may leave silent.
      const duringRecovery: { state?: string; reason?: string; note?: string } = {}
      host.dsh.compaction.duringStep = async () => {
        if (duringRecovery.state !== undefined) return
        const title = await host.ask(master, { purpose: 'session-title' })
        duringRecovery.note = title.failures[0]?.message
        duringRecovery.state = host.runtime.sessions.title(master)?.state
        duringRecovery.reason = host.runtime.sessions.title(master)?.reason
      }
      expect((await host.ask(master)).failures).not.toEqual([])
      expect(await host.runtime.sessions.awaitRecovery(master)).toMatchObject({ state: 'recovered' })
      // The refusal is recorded and explained: deferred until the Session's history is compacted, with the numbers behind it.
      expect(duringRecovery.state).toBe('deferred')
      expect(duringRecovery.reason).toContain('deferred until the Session')
      expect(duringRecovery.note).toContain('deferred until the Session')
      // And it was deferred, not lost: once the Session fits, the same retry the title of a recovered Session gets produces one.
      await host.runtime.sessions.settled()
      expect(host.dsh.title.refreshes).toContain(master)
      expect(host.runtime.sessions.title(master)).toMatchObject({ state: 'sent' })
      expect(host.dsh.compaction.runs.filter(run => run.committed).length).toBeGreaterThan(0)
    } finally { await host.stop() }
  })

  it('keeps a Session title that cannot fit at all skipped, with the reason, and its work unaffected', async () => {
    const host = await startRuntime()
    try {
      const master = host.runtime.masterId
      recordPrompt(host, master)
      expect((await host.ask(master)).failures).toEqual([])
      // A budget its own prompt and tool declarations already exceed: no compaction of the history can make room for a title.
      limit(host.runtime.machine, 'requestMaxChars', 1000)
      limit(host.runtime.machine, 'requestOutputReserveChars', 0)
      limit(host.runtime.machine, 'requestMeasurementReserveChars', 0)
      const asked = host.asked.mock.calls.length
      expect((await host.ask(master, { purpose: 'session-title' })).failures).not.toEqual([])
      expect(host.asked.mock.calls.length).toBe(asked)
      expect(host.runtime.sessions.title(master)).toMatchObject({ state: 'skipped' })
      expect(host.runtime.sessions.title(master)!.reason).toContain('budget')
      // Ordinary work is unaffected by a skipped title: the budget, not the title, is what a person has to change.
      expect((await host.ask(master)).failures).not.toEqual([])
      expect(await host.runtime.sessions.awaitRecovery(master)).toMatchObject({ state: 'paused' })
      expect(host.runtime.sessions.requests(master).every(record => record.action === 'suspend' || record.total <= record.budget)).toBe(true)
    } finally { await host.stop() }
  })

  it('never splits an assistant tool call from its results to make a step fit, and pauses rather than trying', async () => {
    const host = await startRuntime()
    try {
      const master = host.runtime.masterId
      recordPrompt(host, master)
      expect((await host.ask(master)).failures).toEqual([])
      // One assistant turn that called two tools, with both results: a range DSH accepts has to keep them on the same side, so the
      // smallest step that could be taken is that whole unit — larger than the room this budget leaves.
      const log = host.logs.get(master)!
      log.push({ type: 'assistant/message', data: { message: { content: [
        { type: 'tool-call', id: 'call-1', name: 'read', arguments: {} }, { type: 'tool-call', id: 'call-2', name: 'read', arguments: {} }] } } })
      log.push({ type: 'tool/result', data: { message: { content: [{ type: 'text', text: 'a'.repeat(1000) }] } } })
      log.push({ type: 'tool/result', data: { message: { content: [{ type: 'text', text: 'b'.repeat(1000) }] } } })
      budgetOfRoom(host, 1500)
      expect((await host.ask(master)).failures).not.toEqual([])
      const report = await host.runtime.sessions.awaitRecovery(master)
      expect(report).toMatchObject({ state: 'paused' })
      expect(report!.reason).toContain('smallest compaction step')
      // No range was ever rejected for cutting the call from its results, and the transaction that could not fit replaced nothing.
      expect(host.dsh.compaction.runs.every(run => !/starts after a tool call|before the results/.test(run.error ?? ''))).toBe(true)
      expect(host.dsh.compaction.runs.filter(run => run.committed)).toEqual([])
      expect(host.surfaceOf(host.logs.get(master)!).map(event => event.type)).toEqual(['system/message', 'assistant/message',
        'tool/result', 'tool/result'])
      expect(host.runtime.sessions.requests(master).filter(record => record.action === 'send')
        .every(record => record.total <= record.budget)).toBe(true)
    } finally { await host.stop() }
  })

  it('recovers a Worker Session too, and leaves its ticket and tools authorization where it was', async () => {
    const host = await startRuntime()
    try {
      const ticket = await host.acceptedTicket(feishu('1', '@bot fix the regression'))
      const sessionId = ticket.sessionId
      recordPrompt(host, sessionId)
      const asked = await host.ask(sessionId)
      expect(asked.failures).toEqual([])
      const before = host.runtime.sessions.requests(sessionId).at(-1)!
      recordResults(host, sessionId, 6, 1000)
      limit(host.runtime.machine, 'requestMaxChars', before.parts.system + before.parts.tools + 1500)
      limit(host.runtime.machine, 'requestOutputReserveChars', 0)
      limit(host.runtime.machine, 'requestMeasurementReserveChars', 0)
      expect((await host.ask(sessionId)).failures).not.toEqual([])
      expect(await host.runtime.sessions.awaitRecovery(sessionId)).toMatchObject({ state: 'recovered' })
      // The ticket is still live, and the Worker's tools are still the ones it had: recovery compacts history, never authority.
      expect(host.runtime.store.tickets.get(ticket.ticket.id)?.id).toBe(ticket.ticket.id)
      expect((await host.ask(sessionId)).failures).toEqual([])
    } finally { await host.stop() }
  })
})
