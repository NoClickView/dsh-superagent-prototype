# 07: 时间阈值控制遗忘与线索唤起

**What to build:** 随着时间推进，记忆按数值阈值减少默认细节并退出常规召回；当强相关线索出现时，旧经历自动以梗概重现，仍服从输入预算。

**Blocked by:** 06 — 后台压缩后按需读取记忆细节

**Status:** resolved
**Spec:** [长期记忆规格](https://github.com/NoClickView/dsh-superagent-prototype/blob/f5b6a3270f390a8068413fdb61f6d2757c020a30/.scratch/long-term-memory/spec.md)

- [x] 由程序基于明确时间基准、单位及线性时间项更新有效权重，覆盖详细、梗概、线索及退出常规召回的可观察变化。
- [x] 使用可配置且版本化的有序阈值，定义等号归属并拒绝非法配置；先前的示例常数不作为已经验证的默认参数。
- [x] 当前情境达到独立的相关性唤起阈值时，自动返回低权重旧经历；没有足够线索时保持遗忘。
- [x] 唤起不直接改写长期重要性、事件年龄、真实性或保留期限，情境变化后不无限驻留。
- [x] 常规阈值只决定候选粒度/资格，唤起也不能绕过范围过滤及输入预算；有效任务状态不因遗忘失效。
- [x] 若采用不同进入/退出阈值，验证边界抖动行为；不要求后台模型为每次时间推进重新评分。
- [x] 用可控时钟和跨年事件在 Runtime 内验证日常不再想起、线索自动重现、原文仍在及检索不自我强化。

## Answer

Resolved on `integration/long-term-memory` (ticket merge `3a411ec`, joined with ticket 08 in `90f9151`).

**What was built.** `granularityOf` in `src/memory/score.ts` puts each record on a rung from its effective weight and a
versioned, ordered policy: detail → summary → cues → out of routine recall. Equality is defined and tested on both sides of
every threshold, and illegal, crossed, unreachable or non-boolean configurations are refused. `MemoryService.reactivate`
returns a low-weight old experience when the query's correlation reaches the policy's reactivation threshold with at least
two distinct cues — gist first — and returns nothing without a strong cue.

**What it may not do.** Reactivation changes no long-term importance, age, truthfulness or retention: the record is
byte-identical after a read, the version and the journal do not move, and the request budget still governs what is
delivered. Thresholds decide candidacy and granularity only; forgetting never deletes. An open ticket stays open.

**Accumulation.** A delivered wake cannot be unsent (DSH owns the message log), so the mechanism is bounded instead: a cap
on wakes per Session and a dedupe by experience and version, with `docs/007` stating exactly what "does not linger" means.
The cap and the dedupe are both tested.

**Evidence.** `tests/memory-forgetting.spec.ts`, `tests/memory-forgetting-runtime.spec.ts` (a controlled clock and
cross-year events: routine forgetting, cue-driven reappearance, the original still present, and no self-reinforcement). The
replay found the time constant too aggressive; it is now 1/3650 (`mem-policy-4`), so a high-importance experience keeps its
gist for roughly fifteen years.
