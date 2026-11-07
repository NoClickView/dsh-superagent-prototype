/** The input budget of one model request: what the runtime measures, how it plans a fit, and the record of every request it sent, paged or refused. */
import { contentHasFile, contentHasImage, projectImagesForTextModel, projectToolUpdates } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, ModelModality, RequestMessage, StreamChunk, ToolSchema, ToolUpdate } from '@deepseek-ai/dsh-llm'

/**
 * This module is the runtime's side of the model-request budget. It is not an HTTP-level guard: the DeepSeek Harness assembles
 * and sends the request, so the runtime cannot rewrite a request that is already built. What it can do is measure every request
 * at the one point DSH exposes before the adapter runs (`llm/stream`), refuse a request that does not fit, and page the material
 * it contributes itself — the messages it delivers, the tool results it returns, and the recalled material the memory service
 * will add — so those never push a request over.
 *
 * The request at that point is not yet the request the provider is sent, and the difference is exactly what a meter must not
 * miss. Verified against `@deepseek-ai/dsh-llm` 0.2.1-alpha.2 (`streamWithRegistration` and `adapterStream`):
 *
 * 1. The waterfall passes the caller's `options` to the listener and `next()` to `adapterStream`: a listener that measures
 *    `options.messages` and `options.tools` measures what was assembled, not what is sent.
 * 2. `adapterStream` then resolves the route's exact model metadata (`resolveModelInfo`/`prepareCall`: `toolUpdate` and
 *    `inputModalities`) and rewrites the request before the adapter sees it: a `file` block becomes its handle text, an `image`
 *    block becomes a placeholder on a route that declares no image input, and `projectToolUpdates` replaces the declared tool
 *    list with the route's declarations — the Session-folded `toolHistory` (every historical definition, plus the additions
 *    recorded in developer messages) for a route that reads tool updates, the current list for a route that reads none.
 * 3. The adapter is handed `{ ...options, messages, tools }` in that projected form. Nothing else the runtime does grows the
 *    request after it: the check is the last step before `next()`.
 *
 * A definition that is both declared and historically expanded is one entry of the projected list, so it is counted once; a
 * definition a route without tool history ignores is not in that list at all, so it is counted at all. `measureFinalRequest`
 * therefore measures the projected request — DSH's own functions, in DSH's own order — and a request the meter cannot project
 * (an unresolvable route, a file only the dispatch can resolve) is refused instead of being reported as a budget it kept.
 *
 * The one recorded exemption used to be DSH's own compaction (`RequestPurpose`): it was measured and recorded under the `recovery`
 * action instead of `send`, and it was let through even when it was over the budget. That traded boundedness for liveness, and the
 * repair made the liveness come from bounded work instead: a housekeeping call is measured exactly like any other request and is
 * refused when it does not fit, while `SessionRecovery` (this module's caller) restores a recoverable Session by compacting its
 * history one measured step at a time. The invariant this module holds is therefore total: every request that is sent fits the
 * policy, and a request that does not fit is suspended and named, whatever its purpose.
 */

/** How large one model request may be, and how much of that stays free for the model's answer and for measurement. */
export interface RequestPolicy {
  /** Largest request the runtime sends, in characters. */
  readonly maxInputChars: number
  /** Characters of `maxInputChars` kept free for the model's answer. */
  readonly outputReserveChars: number
  /** Characters of `maxInputChars` kept free for what the token count of the same text may add. */
  readonly measurementReserveChars: number
}

/** The characters each part of one request takes, by the part of the runtime that contributed it. */
export interface RequestParts {
  /** The system prompt: fixed instructions and the authorization constraints a Session runs under. */
  readonly system: number
  /** The tool definitions the request declares. */
  readonly tools: number
  /** The runtime's state snapshot: working directory, sandbox and approval policies. */
  readonly state: number
  /** The conversation so far: what people and the model said. */
  readonly history: number
  /** Tool results inside the conversation, which grow the fastest. */
  readonly toolResults: number
  /** Recalled memory, which the memory service assembles within the budget's allowance. */
  readonly recall: number
}
export type RequestPart = keyof RequestParts
/** Every part, in the order a record names them. */
export const PARTS = ['system', 'tools', 'state', 'history', 'toolResults', 'recall'] as const
/**
 * The parts a request can do without, in the order the budget gives them up: recalled material first, because it is only a
 * candidate for the context; then tool results, which page; then the conversation itself, which only the Harness can compact.
 */
export const OPTIONAL_PARTS = ['recall', 'toolResults', 'history'] as const
export type OptionalPart = typeof OPTIONAL_PARTS[number]
/**
 * The parts a request cannot do without. Trimming them would silently drop current authorization (the policy and mandate
 * sections) or a tool the model must be able to see, so a request that does not fit with them is suspended instead.
 */
export const REQUIRED_PARTS = ['system', 'tools', 'state'] as const
/** The characters of `parts`. */
export const totalOf = (parts: RequestParts): number => PARTS.reduce((sum, part) => sum + parts[part], 0)
/** Characters held back from `maxInputChars` for the answer and for measurement. */
export const reserveOf = (policy: RequestPolicy): number => policy.outputReserveChars + policy.measurementReserveChars
/** The characters the parts may take: `maxInputChars` without the reserves, and zero for a policy that cannot be used. */
export const budgetOf = (policy: RequestPolicy): number =>
  validPolicy(policy) ? policy.maxInputChars - reserveOf(policy) : 0
/**
 * True when a policy can be used: whole, finite numbers, a positive budget, non-negative reserves, and reserves that leave the
 * request some room. An unusable policy refuses every request rather than being clamped to something that was never configured.
 */
export function validPolicy(policy: RequestPolicy): boolean {
  const whole = (value: number): boolean => Number.isSafeInteger(value) && value >= 0
  return whole(policy.maxInputChars) && whole(policy.outputReserveChars) && whole(policy.measurementReserveChars)
    && policy.maxInputChars > 0 && reserveOf(policy) < policy.maxInputChars
}

/** What the budget does with one request: send it, cut optional parts until it fits, or suspend it. */
export type RequestAction = 'send' | 'shrink' | 'suspend'
/** The decision for one request: its measured parts, the budget they are held to, and the cut that would make it fit. */
export interface RequestPlan {
  readonly action: RequestAction
  readonly parts: RequestParts
  /** Characters held back from `maxInputChars` for the answer and for measurement. */
  readonly reserve: number
  /** `maxInputChars - reserve`: what the parts have to fit in. Zero when the policy cannot be used. */
  readonly budget: number
  readonly total: number
  /** How far the request is over `budget`, in characters; zero when it fits. */
  readonly over: number
  /** Characters each optional part would have to give up for the request to fit. */
  readonly cut: Readonly<Record<OptionalPart, number>>
  /** Why the request cannot be sent as it is: the policy is unusable, or named required parts alone are over. */
  readonly reason?: 'invalidConfig' | 'requiredOverBudget'
}
const NO_CUT: Readonly<Record<OptionalPart, number>> = { recall: 0, toolResults: 0, history: 0 }
/**
 * Plan one request against its policy. It fits, so it is sent; it does not fit, so optional parts are given up in the declared
 * order until it does; and when even that is not enough, the parts that remain are required ones and the request is suspended.
 * Pure: the same parts and policy always give the same plan.
 */
export function planRequest(parts: RequestParts, policy: RequestPolicy): RequestPlan {
  const reserve = reserveOf(policy), budget = budgetOf(policy), total = totalOf(parts)
  if (!validPolicy(policy)) return { action: 'suspend', parts, reserve, budget, total, over: total, cut: NO_CUT, reason: 'invalidConfig' }
  const over = total - budget
  if (over <= 0) return { action: 'send', parts, reserve, budget, total, over: 0, cut: NO_CUT }
  const cut: Record<OptionalPart, number> = { ...NO_CUT }
  let remaining = over
  for (const part of OPTIONAL_PARTS) {
    if (remaining <= 0) break
    cut[part] = Math.min(remaining, parts[part])
    remaining -= cut[part]
  }
  return remaining <= 0 ? { action: 'shrink', parts, reserve, budget, total, over, cut }
    : { action: 'suspend', parts, reserve, budget, total, over, cut, reason: 'requiredOverBudget' }
}

/** The characters a message's content takes: its text as written, and any other block as its JSON. */
function contentChars(content: unknown): number {
  if (typeof content === 'string') return content.length
  if (Array.isArray(content)) return content.reduce((sum: number, block: unknown) => {
    const text = block !== null && typeof block === 'object' && (block as { type?: unknown }).type === 'text'
      ? (block as { text?: unknown }).text : undefined
    return sum + (typeof text === 'string' ? text.length : JSON.stringify(block).length)
  }, 0)
  return JSON.stringify(content).length
}
/** The part of a request a message belongs to, by its role and by the kind of context it declares. */
function partOf(message: { role?: unknown; source?: unknown }): RequestPart {
  const form = message.source !== null && typeof message.source === 'object' ? (message.source as { form?: unknown }).form : undefined
  if (message.role === 'system') return 'system'
  if (form === 'snapshot') return 'state'
  if (form === 'recall') return 'recall'
  return message.role === 'tool' ? 'toolResults' : 'history'
}
/** Add `chars` to `part`, returning new parts. */
const add = (parts: RequestParts, part: RequestPart, chars: number): RequestParts => ({ ...parts, [part]: parts[part] + chars })
/** Parts that are all zero: a request that carries nothing, or a Session that is not loaded. */
export const NO_PARTS: RequestParts = { system: 0, tools: 0, state: 0, history: 0, toolResults: 0, recall: 0 }
/** The shape of one request this module measures: what a caller assembled, or what DSH's projection makes of it. */
export interface MeasuredRequest {
  readonly messages?: readonly RequestMessage[]
  readonly tools?: readonly ToolSchema[]
  /** The system text a one-shot caller passes instead of a leading system message. */
  readonly system?: string
}
/**
 * Measure the parts of one request as it is sent: the messages in order, the tool definitions it declares, and the system text a
 * one-shot caller passes instead of a system message. A message that declares `form: 'snapshot'` or `form: 'recall'` counts as the
 * state or the recalled material, so later memory code needs no separate accounting.
 */
export function measureRequest(options: MeasuredRequest): RequestParts {
  const tools = options.tools?.length ? JSON.stringify(options.tools).length : 0
  let parts: RequestParts = { ...NO_PARTS, system: contentChars(options.system ?? ''), tools }
  for (const message of options.messages ?? []) parts = add(parts, partOf(message), contentChars((message as { content?: unknown }).content))
  return parts
}

/** The capabilities of the model route a request is sent on that decide what DSH's own projection does to it. */
export interface RouteFacts {
  /** How the route reads tool history; absent when it reads none and every request declares the complete list. */
  readonly toolUpdate?: ToolUpdate
  /** The modalities the route accepts; absent when its adapter declares none, which DSH leaves unknown. */
  readonly inputModalities?: readonly ModelModality[]
}
/** How the tool definitions of one request were declared, and what the Session's tool history holds for it. */
export interface ToolExpansion {
  /** The route's tool update mode, when it declares one. */
  readonly toolUpdate?: ToolUpdate
  /** Characters of the definitions the request declared. */
  readonly declared: number
  /** Characters of the definitions the Session's tool history holds, whether or not this route reads them. */
  readonly history: number
}
/** Why the runtime could not establish what one request would finally contain, so it refuses instead of sending it. */
export type UnmeasuredReason =
  /** The route's model metadata could not be resolved, and the request's final form depends on it. */
  | 'routeUnresolved'
  /** A message carries a file, whose model-visible text DSH builds from a read path only its dispatch resolves. */
  | 'fileProjection'
/**
 * What the runtime established about one request: the parts that will be sent, or why it cannot say. A request it cannot
 * measure still carries the parts its caller made visible, so a record explains what was there without claiming it fits.
 */
export type RequestMeasurement =
  | { readonly measured: true; readonly parts: RequestParts; readonly expansion?: ToolExpansion }
  | { readonly measured: false; readonly reason: UnmeasuredReason; readonly parts: RequestParts }
/** A request whose final input the runtime established. */
export const measuredRequest = (parts: RequestParts, expansion?: ToolExpansion): RequestMeasurement =>
  ({ measured: true, parts, ...(expansion === undefined ? {} : { expansion }) })
/** A request the runtime could not measure, with the visible parts as the floor it records. */
export const unmeasuredRequest = (parts: RequestParts, reason: UnmeasuredReason): RequestMeasurement => ({ measured: false, parts, reason })

/**
 * Whether DSH's projection could change a request: it reads the route's tool update mode when the request carries a tool
 * history or a deferred definition, and the route's image support when a message carries an image. A request with none of
 * those reaches the adapter exactly as it was assembled, so it is measurable without asking the route anything.
 */
export const routeDecides = (options: Pick<GenerateOptions, 'messages' | 'tools' | 'toolHistory'>): boolean =>
  options.toolHistory !== undefined
  || (options.tools?.some(tool => tool.deferLoading === true) ?? false)
  || (options.messages ?? []).some(message => contentHasImage(message.content))
/** Characters of the definitions a tool history holds: its baseline declarations and the additions its updates carry. */
const historyCharsOf = (history: GenerateOptions['toolHistory']): number => history === undefined ? 0
  : history.tools.length === 0 && history.updates.length === 0 ? 0
    : JSON.stringify(history.tools).length + history.updates.reduce((sum, update) => sum + JSON.stringify(update.additions).length, 0)
/**
 * Measure the request DSH will hand its adapter, which is what the provider is sent: DSH's own projection functions in DSH's own
 * order (`adapterStream`), over the request the caller assembled. `route` is the exact model metadata the adapter declares, and
 * it is needed exactly when the projection depends on it (`routeDecides`); a request that carries a file is refused instead of
 * measured, because only the dispatch resolves the read path its handle text names.
 */
export function measureFinalRequest(options: GenerateOptions, route?: RouteFacts): RequestMeasurement {
  const messages: readonly RequestMessage[] = options.messages ?? []
  const visible = (): RequestParts => measureRequest({ messages, tools: options.tools, system: options.system })
  if (messages.some(message => contentHasFile(message.content))) return unmeasuredRequest(visible(), 'fileProjection')
  if (route === undefined && routeDecides(options)) return unmeasuredRequest(visible(), 'routeUnresolved')
  const supported = route?.inputModalities === undefined || route.inputModalities.includes('image')
    ? messages : projectImagesForTextModel(messages)
  const final = projectToolUpdates(supported, options.tools, route?.toolUpdate, options.toolHistory)
  const expansion: ToolExpansion | undefined = options.toolHistory === undefined ? undefined
    : { ...(route?.toolUpdate === undefined ? {} : { toolUpdate: route.toolUpdate }),
      declared: options.tools?.length ? JSON.stringify(options.tools).length : 0, history: historyCharsOf(options.toolHistory) }
  return measuredRequest(measureRequest({ messages: final.messages, tools: final.tools, system: options.system }), expansion)
}
/** One Session log event, as far as the budget reads it: the message it contributed, if any. */
export interface MaterialEvent { readonly type: string; readonly data: unknown }
const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
/** The Session a measurement reads: the model-visible history DSH derives for its next request. */
export interface VisibleSession {
  /**
   * DSH's derived history for the next request: its surface in model-visible order, after every committed replacement and every
   * logged message projection. It is the live, cached form of `foldSurface` + `deriveEventMessage` from
   * `@deepseek-ai/dsh-session/surface`, so a compaction's replacement has already taken the place of the range it shadowed.
   */
  deriveMessages(): readonly RequestMessage[]
}
/**
 * Measure what the model will actually see of `session`: the one measurement every room and every recalled-material allowance is
 * computed from.
 *
 * A Session log is append-only. A compaction *replaces* a range of the surface and leaves the events it shadowed in the log, so
 * after a recovery the log still holds every message the model no longer sees. Measuring it reports a Session that was never
 * compacted, and the room it computes is wrong by exactly what recovery gave back: an implementation review reproduced a request
 * with 442 characters free whose recall allowance was zero, which paged a 25-character instruction away entirely. Measuring DSH's
 * own derived history instead is what makes room follow the request the model is handed rather than the history it came from.
 */
export function measureVisible(session: VisibleSession): RequestParts {
  return measureRequest({ messages: session.deriveMessages() })
}
/**
 * Measure the parts the given model-visible events take: one part per role, as `measureRequest` reads the same messages.
 *
 * The caller supplies the surface — the events the model will see, in model-visible order — because this folds nothing. A
 * Session's append-only log is *not* that surface (`measureVisible` is the measurement of the Session); passing the log here
 * counts every message a compaction replaced. Bounded recovery uses this on surface nodes it has already selected, one node or one
 * whole range at a time, where no fold can be applied to a subset of the log.
 */
export function measureSurfaceEvents(events: readonly MaterialEvent[]): RequestParts {
  let parts: RequestParts = { ...NO_PARTS }
  for (const event of events) {
    const data = record(event.data)
    const message = record(event.type === 'user/message' ? data : data?.message)
    if (!message) continue
    const chars = contentChars(message.content)
    if (event.type === 'system/message') parts = add(parts, 'system', chars)
    else if (event.type === 'tool/result') parts = add(parts, 'toolResults', chars)
    else if (event.type === 'user/message') parts = add(parts, partOf(message as { role?: unknown; source?: unknown }), chars)
    else if (event.type === 'assistant/message' || event.type === 'developer/message') parts = add(parts, 'history', chars)
  }
  return parts
}

/**
 * Why DSH makes a housekeeping call of its own: it compacts an oversized conversation, or names a Session. The purpose classifies
 * the call for the record and for the Session's recovery state; it grants no room — a compaction or title call is measured and
 * held to the same input budget as any other, because a call that shrinks a history is not a licence to send one that is too big.
 */
export type RequestPurpose = 'compaction' | 'session-title'

/** One request the runtime caused, as the budget measured and decided it. */
export interface RequestRecord {
  /** The Session it belongs to; absent for a request made outside a Session, such as an independent background job. */
  readonly sessionId?: string
  readonly at: string
  /** The parts of the request as measured; for one that could not be measured, only the parts its caller made visible. */
  readonly parts: RequestParts
  readonly reserve: number
  readonly budget: number
  readonly total: number
  /**
   * What the runtime did: `send` when the request fitted and reached the model, or `suspend` when it did not and never did. There
   * is no third action: a request that is over the budget is never recorded as a recovery that succeeded.
   */
  readonly action: 'send' | 'suspend'
  /** DSH's purpose for a housekeeping call, recorded so a refusal explains which call it was; absent for an ordinary turn. */
  readonly purpose?: RequestPurpose
  /** Characters each optional part would have had to give up; the recorded reason names the parts that could not. */
  readonly cut: Readonly<Record<OptionalPart, number>>
  /**
   * Why the request was refused: the policy cannot be used, the required parts alone are over the budget, or the final size of
   * the request could not be established. Absent when it would have fitted had the optional parts been smaller — a cut only the
   * material those parts come from can make, before it arrives.
   */
  readonly reason?: 'invalidConfig' | 'requiredOverBudget' | 'unmeasured'
  /** Why the final size could not be established; set exactly when the reason is `unmeasured`. */
  readonly unmeasured?: UnmeasuredReason
  /**
   * The tool definitions the request declared and what the Session's tool history holds, recorded whenever a tool history was in
   * play: it is how a refusal explains that the definitions the route adds — not the ones the caller declared — are what is over.
   */
  readonly expansion?: ToolExpansion
}
/** One delivered message or tool result the budget made smaller, with what it was offered and what it kept. */
export interface PageRecord {
  readonly sessionId?: string
  readonly at: string
  /** Which producer's material it is. */
  readonly kind: 'message' | 'tool-result'
  /** Characters offered, characters kept, and the room the budget had for it. */
  readonly offered: number
  readonly kept: number
  readonly room: number
  /** What the runtime did: `shrink` when it paged the material, or `suspend` when it was offered no room at all. */
  readonly action: 'shrink' | 'suspend'
}
/** What the budget has recorded since this process started: every request it measured, and the material it made smaller. */
export interface BudgetUsage {
  /** Requests measured, and how each was decided: sent, or suspended before the model was called. */
  readonly requests: number
  readonly sent: number
  readonly suspended: number
  /** Requests DSH made for a purpose of its own — a compaction or a Session title — and which are held to the same limit. */
  readonly housekeeping: number
  /** Requests refused because what they would finally contain could not be established. */
  readonly unmeasured: number
  /** The largest request recorded, in characters, and the budget every request is held to. */
  readonly largest: number
  readonly budget: number
  /** Materials the pager made smaller, the characters they offered and the characters they kept. */
  readonly pages: number
  readonly offered: number
  readonly kept: number
  /** The last request recorded: which Session made it, how it was decided, and how many characters its parts used. */
  readonly last?: { readonly sessionId?: string; readonly action: RequestRecord['action']; readonly parts: RequestParts; readonly total: number
    readonly purpose?: RequestPurpose; readonly reason?: RequestRecord['reason']; readonly unmeasured?: UnmeasuredReason
    readonly expansion?: ToolExpansion }
}
/** Most records one Session keeps; older ones are dropped, as they only inform, never authorize. */
const KEEP = 200
/**
 * Characters held back for the tool definitions of a Session that has not made a request yet. A delivered message is measured
 * against what the next request will carry, and the tool definitions are part of that request although no Session-log event holds
 * them: reserving nothing for them is how a delivered message came to spend room the tool definitions needed. Once a request has
 * been measured its own count replaces this allowance, so it is only ever the answer before the first request of a process.
 */
const TOOL_DEFINITIONS_CHARS = 32_000
const at = (): string => new Date().toISOString()

/**
 * Measures and records every model request the runtime causes, and tells the material the runtime delivers itself how much room
 * is left. `Sessions` feeds it the request DSH will hand its adapter — `measureFinalRequest`, after DSH's own projection — at the
 * `llm/stream` boundary and pages delivered messages and tool results through `room` and `page`; later memory work asks
 * `allowance` for the characters it may recall. The same contract serves a request made outside a Session: a background job
 * passes no Session id and gets the same policy and the same record.
 */
export class RequestBudget {
  private readonly requests = new Map<string, RequestRecord[]>()
  private readonly pages: PageRecord[] = []
  /** What each Session's own tool definitions take, as its last measured request declared them. */
  private readonly definitions = new Map<string, number>()
  constructor(private readonly current: () => RequestPolicy) {}
  /** The policy in force, read on each use so a changed setting applies to the next request. */
  policy(): RequestPolicy { return this.current() }
  /** The plan for `parts` under the policy in force. */
  plan(parts: RequestParts): RequestPlan { return planRequest(parts, this.policy()) }
  /**
   * Plan, record and decide one request. `send` lets it through; anything the plan cannot fit is suspended, because a request
   * that is already assembled cannot be shrunk here — only the parts the runtime delivers itself can be, before they arrive.
   * A `purpose` marks DSH's own housekeeping call for the record and for the Session's recovery state. It grants nothing: a
   * compaction or title call that is over the budget is suspended like any other request, and the runtime's bounded recovery —
   * compacting the history one measured step at a time — is what restores liveness for the Session that made it.
   *
   * A measurement the runtime could not establish is refused whatever its purpose: a request nobody can size is not one this
   * module can call inside a budget, and the record says so instead of reporting a success it cannot substantiate.
   */
  record(sessionId: string | undefined, measurement: RequestMeasurement, purpose?: RequestPurpose): RequestRecord {
    const planned = this.plan(measurement.parts)
    const unmeasured = measurement.measured ? undefined : measurement.reason
    const action = unmeasured !== undefined || planned.action !== 'send' ? 'suspend' as const : 'send' as const
    const entry: RequestRecord = {
      ...(sessionId === undefined ? {} : { sessionId }), at: at(), parts: planned.parts, reserve: planned.reserve, budget: planned.budget,
      total: planned.total, action, cut: planned.cut,
      ...(purpose === undefined ? {} : { purpose }),
      ...(action === 'suspend' ? { reason: unmeasured === undefined ? planned.reason : 'unmeasured' as const } : {}),
      ...(unmeasured === undefined ? {} : { unmeasured }),
      ...(measurement.measured && measurement.expansion !== undefined ? { expansion: measurement.expansion } : {}),
    }
    // What this request declared is also what the Session's next request carries, so it is the tool count a delivered message is
    // paged against until the next request replaces it. It is measured here because nowhere earlier can it be seen at all; a
    // measurement that could not be established is a floor, so it never replaces what an earlier request proved.
    if (sessionId !== undefined && measurement.measured) {
      this.definitions.set(sessionId, Math.max(planned.parts.tools, this.definitions.get(sessionId) ?? 0))
    }
    const list = this.requests.get(sessionId ?? '') ?? []
    list.push(entry)
    if (list.length > KEEP) list.splice(0, list.length - KEEP)
    this.requests.set(sessionId ?? '', list)
    return entry
  }
  /** Every recorded request, oldest first, of `sessionId` or of every Session and background request. */
  requestsOf(sessionId?: string): RequestRecord[] {
    if (sessionId !== undefined) return [...this.requests.get(sessionId) ?? []]
    return [...this.requests.values()].flat().sort((left, right) => left.at.localeCompare(right.at))
  }
  /** The last request recorded for `sessionId`, or for any request when it is absent. */
  last(sessionId?: string): RequestRecord | undefined { return this.requestsOf(sessionId).at(-1) }
  /** Every message and tool result the budget made smaller, oldest first. */
  pagesOf(sessionId?: string): PageRecord[] {
    return sessionId === undefined ? [...this.pages] : this.pages.filter(page => page.sessionId === sessionId)
  }
  /**
   * The characters `material` leaves of the budget: what one delivered message or tool result may take as things stand. What the
   * next request will carry is `material` and the tool definitions beside it, so both are taken off the budget — the definitions a
   * Session's last request measured, or the allowance above until it has made one.
   */
  room(material: RequestParts, sessionId?: string): number {
    const policy = this.policy()
    return validPolicy(policy) ? Math.max(0, budgetOf(policy) - totalOf(material) - this.definitionsOf(sessionId)) : 0
  }
  /** The characters one Session's tool definitions take: its last request's own count, or what this process has measured before. */
  definitionsOf(sessionId?: string): number {
    const own = sessionId === undefined ? undefined : this.definitions.get(sessionId)
    if (own !== undefined) return own
    const measured = Math.max(0, ...this.definitions.values())
    return measured > 0 ? measured : TOOL_DEFINITIONS_CHARS
  }
  /**
   * What the budget has done since this process started, in totals an operator reads: how many requests it measured and how many it
   * refused, how large the largest one was against the budget in force, and how much material the pager had to cut. It is the
   * published form of the two test-only accounts beside it (`requestsOf`, `pagesOf`), and it writes nothing.
   */
  usage(): BudgetUsage {
    const records = this.requestsOf()
    const last = records.at(-1)
    const count = (action: RequestRecord['action']): number => records.filter(record => record.action === action).length
    return { requests: records.length, sent: count('send'), suspended: count('suspend'),
      housekeeping: records.filter(record => record.purpose !== undefined).length,
      unmeasured: records.filter(record => record.unmeasured !== undefined).length,
      largest: records.reduce((largest, record) => Math.max(largest, record.total), 0), budget: budgetOf(this.policy()),
      pages: this.pages.length, offered: this.pages.reduce((sum, page) => sum + page.offered, 0),
      kept: this.pages.reduce((sum, page) => sum + page.kept, 0),
      ...(last === undefined ? {} : { last: { ...(last.sessionId === undefined ? {} : { sessionId: last.sessionId }),
        action: last.action, parts: last.parts, total: last.total,
        ...(last.purpose === undefined ? {} : { purpose: last.purpose }),
        ...(last.reason === undefined ? {} : { reason: last.reason }),
        ...(last.unmeasured === undefined ? {} : { unmeasured: last.unmeasured }),
        ...(last.expansion === undefined ? {} : { expansion: last.expansion }) } }) }
  }
  /**
   * Page `text` to `available` characters. Text that fits is returned whole and unrecorded; a longer text keeps its head and ends
   * with a line that states how much was withheld and where the whole text is, so nothing is ever truncated silently.
   */
  page(sessionId: string | undefined, kind: PageRecord['kind'], text: string, available: number, read?: string): string {
    if (text.length <= available) return text
    const note = `… ${text.length} characters withheld${read ? `; read ${read}` : ''} (${available > 0
      ? `${available} of ${text.length} kept` : 'no room in the request budget'})`
    const kept = `${available > note.length ? text.slice(0, available - note.length) : ''}${note}`
    this.pages.push({ ...(sessionId === undefined ? {} : { sessionId }), at: at(), kind, offered: text.length, kept: kept.length,
      room: available, action: kept.length <= available ? 'shrink' : 'suspend' })
    if (this.pages.length > KEEP) this.pages.splice(0, this.pages.length - KEEP)
    return kept
  }
  /**
   * The characters left for recalled material on `sessionId`'s next request: the budget less the parts the last request took.
   * A caller that assembles recall must stay inside it; it is an upper bound, not a target, and the memory service caps its own.
   */
  allowance(sessionId?: string): number {
    const policy = this.policy()
    if (!validPolicy(policy)) return 0
    const last = this.last(sessionId)
    return Math.max(0, budgetOf(policy) - (last?.total ?? 0))
  }
}

/** The line a refused request fails with: what it measured, against which budget, and what would have made it fit. */
export function refusalMessage(record: RequestRecord): string {
  const parts = PARTS.map(part => `${part} ${record.parts[part]}`).join(', ')
  const fits = (Object.entries(record.cut) as [OptionalPart, number][]).filter(([, chars]) => chars > 0)
    .map(([part, chars]) => `${part} by ${chars}`)
  const why = record.reason === 'invalidConfig' ? 'its input budget is not configured usefully'
    : record.reason === 'unmeasured' ? record.unmeasured === 'fileProjection'
      ? 'it carries a file whose model-visible text only the adapter dispatch can resolve, so its final size is unknown'
      : 'the model route it would be sent on could not be resolved, so what it would finally contain is unknown'
      : record.reason === 'requiredOverBudget' ? 'its required parts alone are over the budget'
        : `cutting ${fits.join(' and ')} would have made it fit, which only the material those parts come from can do`
  const expands = record.expansion === undefined ? '' : `; its route declares ${record.parts.tools} characters of tool definitions`
    + ` for ${record.expansion.declared} declared, the Session's tool history holding ${record.expansion.history}`
  // A housekeeping call is named as one, and as a call held to the same limit: that is the whole point of refusing it.
  const housekeeping = record.purpose === undefined ? '' : `; it is DSH's ${record.purpose} call, held to the same limit as any`
    + ' other request, so the Session recovers in bounded steps rather than by sending this one'
  // A request the runtime could not measure is refused on what it could see, so its size is stated as the floor it is.
  const size = record.reason === 'unmeasured' ? `at least ${record.total} characters` : `${record.total} characters`
  return `dsh-superagent refused this model request: ${size} against a ${record.budget}-character budget`
    + ` (${parts}); ${why}${expands}${housekeeping}`
}
/**
 * The stream a refused request ends with instead of reaching the adapter: one terminal error chunk, so no provider is called.
 * This is the pre-send veto at `llm/stream`; DSH reports the failure as a failed step, and the record keeps why. `note` is what the
 * caller did about the refusal — a bounded recovery that restored the Session, or the pause it ended in — and the message carries
 * it because a person reading the failure is the one who needs to know whether to retry.
 */
export async function* refusal(record: RequestRecord, note?: string): AsyncIterable<StreamChunk> {
  const message = `${refusalMessage(record)}${note === undefined ? '' : `; ${note}`}`
  yield { type: 'finish', reason: { kind: 'error', failure: { code: 'REQUEST_OVER_BUDGET', message } } }
}
