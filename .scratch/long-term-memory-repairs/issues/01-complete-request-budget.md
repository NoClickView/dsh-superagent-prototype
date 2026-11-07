# 01: 最终模型请求计入历史工具定义并守住预算

**What to build:** 主会话、Worker 和独立后台调用在真正交给模型适配器前，统一校验完整输入；历史工具定义等后续展开内容不能让获准发送的请求突破配置预算。

**Blocked by:** None (can start immediately).

**Status:** resolved
**Labels:** ready-for-agent
**Priority:** P1
**Spec:** [长期记忆规格](https://github.com/NoClickView/dsh-superagent-prototype/blob/f5b6a3270f390a8068413fdb61f6d2757c020a30/.scratch/long-term-memory/spec.md)
**Source:** 2026-11-07 实现审查；基线 da65294 至 bcf5ea6。

审查复现：预算为 800 字符，当前工具列表为空、历史工具定义约 9,000 字符时，守卫仅计量 5 字符并放行；DSH 按模型的工具历史能力展开后，实际输入为 9,090 字符。

- [x] 核实当前 DSH 的完整请求转换和适配器发送顺序；预算覆盖最终可见的系统信息、工具定义、状态、交互历史、工具结果及召回材料，并保留输出与计量余量。
- [x] 覆盖工具历史启用、移除、延迟加载以及不支持工具历史的模型路线；按最终实际声明计量，既不遗漏历史定义，也不重复计费。
- [x] 输入和模型计量配置不适用时明确拒绝发送；无法取得可靠最终计量时不给出“已守住完整预算”的成功结果。
- [x] 请求通过后不再发生未经预算检查的输入膨胀；必要输入仍超限时明确暂停或分步处理，保留当前授权约束。
- [x] 经 Runtime 到可记录适配器验证上述 5→9,090 的案例，直接观察最终请求；校验主会话、Worker、独立后台请求、精确预算边界和重试。
- [x] 预算状态能够解释实际计量与拒绝原因；请求组装和原有路由、授权回归保持有效。

本单建立完整输入的最终校验入口；压缩与标题用途的超限豁免由 02 单取消，不在本单宣称所有用途均已满足硬上限。

## Answer

Resolved on `repair/01-request-budget`.

**What DSH does after the waterfall.** `streamWithRegistration` hands the caller's `options` to the `llm/stream`
listener and `next()` to `adapterStream`; `adapterStream` resolves the route's exact model metadata and rewrites the
request before the adapter sees it (`projectFilesToText`, `projectImagesForTextModel`, then `projectToolUpdates`). On a
route whose `toolUpdate` reads tool updates the declarations become the Session-folded `toolHistory` — every historical
definition plus the additions recorded in developer messages, deduplicated by name — and on a route that reads none they
become the complete current list, the developer messages and the deferred-loading flag dropped with them. Measuring
`options.messages` and `options.tools` at the waterfall therefore measures a different request from the one sent.

**The fix.** `measureFinalRequest` (`src/app/budget.ts`) applies DSH's own projection functions, in DSH's own order, over
the route metadata `Sessions` resolves through `llm.resolveModelInfo`, and measures the result. A definition that is both
declared and historically expanded is one entry of the projected list and is billed once; a definition a route ignores is
not in that list and is not billed. `routeDecides` keeps the request DSH cannot change measurable without the route; a
request whose final size cannot be established (unresolvable route, or a file only the adapter dispatch resolves) is
refused with `reason: 'unmeasured'` and never reaches the adapter. The record keeps the declared character count beside
what the Session's tool history holds, and the `budget` health entry names both and states why the last request was
refused. `RequestBudget.room` now holds back the definitions the route actually declares, so material the runtime delivers
after an expansion is paged to what is left instead of to a budget the expanded definitions already spent.

**Scope.** The compaction/session-title exemption is untouched: this ticket refuses unmeasurable requests whatever their
purpose, but a measured recovery call that is over the budget is still let through, and ticket 02 removes that exemption.

**Evidence.** `tests/budget.spec.ts`, `describe('the request DeepSeek Harness finally hands its adapter')`: the reviewed
5 → 9,090 case refused with the adapter never called, the same request measured through a Worker and through an
independent background call, the exact boundary (at the budget sent, one character over refused), a retry, an
unresolvable route and a file-carrying request refused as unmeasurable, a route without tool history that does not bill
the history, a definition declared and expanded billed once, deferred definitions, and the health detail. The fixture's
adapter performs DSH's projection, so every assertion is on the request a provider would have been sent.
