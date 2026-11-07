# 01: 每次模型输入守住预算

**What to build:** 主会话或 Worker 的历史与工具输出增长时，实际发出的模型请求始终受固定输入预算约束；超大必要材料触发可解释的分步处理或暂停。

**Blocked by:** None (can start immediately)

**Status:** resolved
**Spec:** [长期记忆规格](https://github.com/NoClickView/dsh-superagent-prototype/blob/f5b6a3270f390a8068413fdb61f6d2757c020a30/.scratch/long-term-memory/spec.md)

- [x] 先核验并接通 DSH 完整模型请求的发送前边界；仅整理必要的调用入口，复用现有 Runtime 宿主和可记录模型适配器。不得用 system prompt 长度或现有 compaction 的配置代替完整请求验证。
- [x] 统一计量系统信息、工具定义、当前状态、历史、工具结果和召回材料，并为输出和计量余量预留空间；模型/计量配置不适用时明确拒绝发送。
- [x] 在工具持续返回大结果、历史持续增长和重试情景中，记录到的每次请求均不超过预算；不静默丢弃现行授权约束。
- [x] 超大可选内容可缩减或分页；必要输入仍超预算时提供明确的暂停或分步结果，不发送超限请求。
- [x] 入口支持后续独立后台请求复用同一预算合同，不要求现在实现后台记忆功能。
- [x] 使用 Runtime 集成测试覆盖主会话与 Worker，维护原有事件路由、权限和执行回归；不做无关会话框架重写。

## Answer

Resolved on `integration/long-term-memory` (ticket merge `987dd85`).

**The boundary.** This bundle never assembles or sends a model request — DeepSeek Harness does, and the loop package is
not even a dependency here. The pre-send boundary it *does* own is DSH's `llm/stream` waterfall
(`src/app/sessions.ts`), which sees every call in the process — main Session, workers, subagents, and DSH's own
compaction and session-title calls — and can decline `next()`. `src/app/budget.ts` measures the complete request
there (`system | tools | state | history | toolResults | recall`), records it, and answers an over-budget request with a
terminal refusal chunk so the adapter never runs. The doc comment and `docs/007` state plainly what the runtime can and
cannot see: this is a pre-adapter guard, not an HTTP-level one.

**Corrected on 2026-11-07 by repair 01 (`repair/01-request-budget`).** The paragraph above is wrong about *what* was
measured, and the review that filed the repair tickets reproduced it. The request at the waterfall is not yet the request
the provider is sent: DSH's `adapterStream` rewrites it after the waterfall and before the adapter — it expands the
Session-folded `toolHistory` into the tool declarations on a route whose `toolUpdate` reads tool updates, drops those
definitions on a route that reads none, and turns a request image into a placeholder on a route without image input. So
metering `options.messages` and `options.tools` approved one request and sent another: with an 800-character budget and
~9,000 characters of historical tool definitions the guard measured 5 characters, let the request through, and the adapter
received 9,090. `measureFinalRequest` now applies DSH's own projection functions in DSH's own order over the route's
metadata (`llm.resolveModelInfo`) and measures the result, so a definition that is declared and historically expanded is
counted once and one that a route ignores is not counted at all; a request whose final size cannot be established (an
unresolvable route, a file only the adapter dispatch resolves) is refused instead of being reported as inside a budget.
The record keeps the declared character count beside what the Session's tool history holds, and the `budget` health entry
names both and states why the last request was refused. The `recovery` exemption below is untouched by this correction;
repair ticket 02 removes it. Evidence for the corrected behaviour is in `.scratch/long-term-memory-repairs/issues/01-complete-request-budget.md`
and `tests/budget.spec.ts`.

**Configuration.** `requestMaxChars` (400 000), `requestOutputReserveChars` (32 000) and
`requestMeasurementReserveChars` (8 000) are volatile machine settings; a policy whose reserves consume the budget is
refused where settings are read, never clamped.

**Deliberate deviation.** A request is deep-frozen at that boundary, so the meter can only send or suspend — the actual
shrinking happens at the producers the runtime owns (delivered messages, tool results, recall), which page with an
explicit "N characters withheld; read …" note. Every request either fits or is suspended, and a Runtime regression test
drives that full cycle.

**Corrected again on 2026-11-07 by repair 02 (`repair/02-bounded-recovery`).** The paragraph above used to end by
exempting DSH's own compaction: it was recorded as `recovery` and let through, on the argument that refusing the call
that shrinks an oversized conversation would deadlock the Session. That is wrong twice over, and the review reproduced
it: the exemption let a request whose purpose was `compaction` or `session-title` be sent over the configured limit, so
the budget was only held for turns. Repair 01's own correction above still says the exemption is untouched; this
correction removes it. A housekeeping call is now measured and refused exactly like a turn (`purpose` is recorded, and
grants nothing), and liveness comes from `SessionRecovery` (`src/app/recovery.ts`), which restores an oversized Session
by compacting its history through DSH's own backend one balanced surface range at a time — each step's summarization
request measured at the same boundary and shrunk from what a refused step measured — pausing with its reason, rather
than sending, when even the smallest step cannot fit. The states `recovering`, `recovered` and `paused` are published
on the `budget` health entry. Evidence is in `.scratch/long-term-memory-repairs/issues/02-bounded-recovery-requests.md`
and `tests/recovery.spec.ts`.

**Evidence.** `tests/budget.spec.ts` (15 tests: main Session and Worker, growing history, repeated attempts, an unusable
policy, paging, and the `llm/stream` refusal through a recordable fake adapter). Event routing, permissions and execution
recovery remain green.
