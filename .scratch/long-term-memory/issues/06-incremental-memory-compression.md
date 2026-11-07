# 06: 后台压缩后按需读取记忆细节

**What to build:** 后台将一段经历整理为有来源的梗概和线索；实验体默认读取简短表示，需要时在预算内展开原文，操作者可识别压缩版本并回退。

**Blocked by:** 05 — 无状态后台评分影响召回排序

**Status:** resolved
**Spec:** [长期记忆规格](https://github.com/NoClickView/dsh-superagent-prototype/blob/f5b6a3270f390a8068413fdb61f6d2757c020a30/.scratch/long-term-memory/spec.md)

- [x] 复用独立后台作业边界，从新经历到压缩候选、唯一服务发布，再到模型读取贯通完整路径。
- [x] 同一稳定经历身份关联原文、梗概、线索与来源映射；不把所有历史压成一篇无来源的总摘要。
- [x] 每次整理只加载有界新增材料及必要关联证据；不以反复总结上一版摘要作为唯一信息来源。
- [x] 在同一读取流程内实现梗概返回、受预算约束的展开、原文缺失时的明确说明。
- [x] 验证引用、主体、时间、否定和重要约束等固定反例；不满足要求的候选不替换当前版本，也不把校验通过宣称为语义无损。
- [x] 提供可观察的版本信息和一次回退路径；回退影响下一次读取，仍经唯一提交入口。
- [x] 每次结果提交使用基础版本与作业标识，拒绝过期输出和重复生效；基础生命周期内可暂停或重试。
- [x] Runtime 集成验收包含压缩前后输入大小、召回内容、来源、展开与回退，维护真实事件和工单行为。

## Answer

Resolved on `integration/long-term-memory` (ticket merge `56cfc3f`).

**What was built.** `src/memory/summary.ts` registers a second `BackgroundKind` on the existing job machinery — not a fork.
It requests a gist from the experience's own still-readable material plus at most two related same-scope records, with a
previous summary supplied only as `previous_summary`, never as the sole source. One stable experience identity links
original, gist, cues and a source map back to the input ids.

**The read flow.** Default recall returns the labelled gist; `expand` returns the original inside the allowance and carries
the gist; an evicted or unknown original is answered honestly and never reconstructed from the summary. Fixed
counterexamples (citation, subject, time, negation and a constraint that must survive summarisation) commit nothing when a
candidate fails. A version is visible in the listing and one rollback step restores the previous representation through the
single commit entry; a second rollback reports it is spent.

**Lifecycle.** A paused runner issues no call; a failed job records the failure and does not retry by itself; a candidate
whose base version moved is refused as a conflict naming both versions; the same job id applies once.

**Evidence.** `tests/memory-compression.spec.ts` (before/after recall size, sources, expansion, eviction honesty, rollback
and an unaffected ticket). Known limits: the preservation check reads a blob original through its stored head, so it is a
floor rather than a guarantee, and the constraint check is strict enough that a real model will often be refused — both
recorded for calibration.
