# 11: 多年经历回放与参数校准报告

**What to build:** 维护者可运行可复现的多年经历回放，对比三种记忆策略，获得包含召回质量、错误、成本和硬约束结果的报告，并据此记录初版参数。

**Blocked by:** 03 — 用实际权限保证外部只读；07 — 时间阈值控制遗忘与线索唤起；08 — 更新当前认识并保留历史依据；10 — 后台积压或规则升级时持续服务

**Status:** resolved
**Spec:** [长期记忆规格](https://github.com/NoClickView/dsh-superagent-prototype/blob/f5b6a3270f390a8068413fdb61f6d2757c020a30/.scratch/long-term-memory/spec.md)

- [x] 提供可运行的回放入口，从事件数据经过真实 Runtime 与记忆读取到评测报告，含可控时钟、受控模型及有预算的实际模型评测方式。
- [x] 比较原文检索、滚动摘要和分层方案，保持相同输入预算及可比较的后台预算，记录所有配置和版本。
- [x] 情景覆盖旧事实更新、同名实体、稀有重要事件、重复自引、矛盾证据、遗忘后唤起、原文淘汰及长期搁置后恢复。
- [x] 报告召回、旧事实误用、虚构细节、弃答、输入规模、存储、后台成本和延迟；证据标注独立于被测模型自述。
- [x] 硬约束验收要求零超限请求、零成功绕过写入、零重复生效，以及中断后只见完整版本；所有相关实现票也必须各自已有验收测试。
- [x] 给出初版数值尺度、线性系数、时间单位及基准、阈值/水位和预算的选择依据与配置记录；不把对话中的示例常数当作实证结果。
- [x] 若复杂机制未比基线带来稳定收益，报告实际结果及限制，不修改评价口径制造通过，也不宣称完成真实多年运行。
- [x] 完成项目类型检查、测试和构建，并复核既有授权、事件路由和执行恢复回归；保持源码与规格范围一致。

## Answer

Resolved on `integration/long-term-memory` (ticket merge `169cdee`; calibration in the `fix/calibration` merge).

**The harness.** `tests/replay/` builds a replay that runs the **real Runtime** — Engine transaction, durable effect queue,
capture, background evaluator, archive — over 20 episodes spanning 2023-01 to 2026-11, restarts it inside an eight-month
silence, then asks 10 questions answered by three strategies under one 1000-character allowance and graded against
hand-written keys that no strategy or model contributes to. Run it with `npx vitest run tests/memory-replay.spec.ts`
(about 2 s of replay) and regenerate the report with `REPLAY_WRITE=1`. 51 model requests, no provider called.

**The comparison.** Layered 8/10 correct with **0** stale-fact misuse; plain original retrieval 8/10 with 2; rolling summary
5/10 with 0. The report concludes a tie on correctness and says so plainly, including the cost: 35 background calls bought
no extra correct answers over the plain baseline.

**What the replay found, and what was done about it.** Two real defects, both repaired and re-run: (1) `REVISION_MIN_CUES =
2` closed five windows of which three were about something else — the rule is now a count *and* a share, and the three cases
are regression tests; (2) the shipped time decay of 1/365 put the memory's horizon at ~18 months, contradicting user story
1 — it is now 1/3650 (`mem-policy-4`), so an important experience keeps its gist for roughly fifteen years. The report was
regenerated against both changes.

**Hard constraints, and where each is independently proved.** Zero over-budget requests (now: every recorded request with
`action: 'send'` is within budget, and there is no exempted population any more — repair 02 removed the housekeeping
exemption, so DSH's own compaction and Session-title calls are counted in the same two populations) —
`tests/budget.spec.ts`. Zero
successful write bypasses — measured by a real second process refused under an ACL deny, and
`tests/memory-isolation.spec.ts`. Zero duplicate applications — `tests/memory-store.spec.ts`,
`tests/memory-crash.spec.ts`. Only complete versions after interruption — `tests/memory-crash.spec.ts`.

**Honest limits.** A replayed span is not production experience; the baselines are ablations of one corpus; the forgotten
rung is evidenced by numeric tests with 30–40 year clocks rather than by this 3.8-year replay; the 1/3 subject share is
fitted to this corpus's separability and is documented with those numbers.
