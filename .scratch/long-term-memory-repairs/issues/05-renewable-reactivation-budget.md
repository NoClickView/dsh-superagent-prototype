# 05: 线索唤起使用可恢复额度并持续可用

**What to build:** 实验体持续运行并经历多轮对话后，新的强相关线索仍能自动唤起旧经历；通过有界、可补充的额度控制短期打扰，而不是累计八次后永久停止。

**Blocked by:** None (can start immediately).

**Status:** resolved
**Labels:** ready-for-agent
**Priority:** P2
**Spec:** [长期记忆规格](https://github.com/NoClickView/dsh-superagent-prototype/blob/f5b6a3270f390a8068413fdb61f6d2757c020a30/.scratch/long-term-memory/spec.md)
**Source:** 2026-11-07 实现审查；基线 da65294 至 bcf5ea6。

审查复现：连续 12 次强关联输入且上下文有足够空间时，通知累计为 0、1、2、3、4、5、6、7、8、8、8、8；计数没有进程内恢复条件，重启前所有后续线索均被忽略。

- [x] 以明确记录、可配置的时间窗或轮次策略补充唤起额度；额度耗尽后的恢复不依赖进程重启，不要求实验体主动管理记忆。
- [x] 额度恢复后，全新强相关线索仍能唤起符合范围的旧经历；弱线索不唤起，已遗忘经历仍可按既有阈值重新成为候选。
- [x] 对同一未变化经历进行有界去重，并明确再次可唤起的条件；去重状态自身有容量或保留期限，不能随多年运行无限增长。
- [x] 每次通知仍受完整请求预算约束并优先呈现梗概；额度补充不提高记忆重要性、证据可信度，不重置事件年龄或延长原文保留期。
- [x] 明确额度补充、实际交付成功、失败重试及重启时的计数语义，不重复投递、不因重试制造额度或永久占用额度。
- [x] 在 Runtime 集成测试中覆盖超过八次成功唤起、额度耗尽、可控时间或轮次推进后恢复、不同线索、重复经历、预算不足及重启；直接检查模型可见通知与记忆状态。
- [x] 通过现有状态或诊断记录说明未唤起是额度不足、重复、相关性不足还是上下文无空间，不新增独立管理产品。

## Answer

Resolved on `repair/05-reactivation-budget`. The lifetime per-process counter is gone; automatic reactivation now runs under a
replenishable allowance in `src/memory/wake.ts` (`WakeAllowance`), composed by `src/app/memory.ts`.

**The window.** `memoryRecallWakes` notices (default 8, bounds 1–64) inside a moving `memoryRecallWindowMs` (default 30 minutes =
1 800 000 ms, bounds 1 s – 24 h), both read from the machine settings on each cue so a live change applies to the next one. The
window is a *sliding* one: a notice stops counting exactly one window after it landed, so the guarantee is "no more than eight
notices in any half hour" and the allowance refills notice by notice instead of in a burst at a boundary. Time rather than a
round/turn counter because the nuisance this bounds is time — what a model reads as background context in one stretch of work —
and a round counter would let a burst of captures spend the whole allowance in seconds while an idle agent, the one case where the
quota does not matter, would never refill it. Recovery therefore needs neither a restart nor anything the agent does.

**Dedupe.** The dedupe is keyed by experience and the record version it was shown at, and lives in the same allowance. It is
bounded twice: at most `WAKE_DEDUPE_MAX` = 256 experiences (the least recently shown is let go first) and at most
`WAKE_DEDUPE_WINDOWS` = 8 windows of retention. An unchanged record may be shown again only when (a) a later write changed it — a
committed gist, a newer weight — or (b) the dedupe let it go by either bound; a repeated cue alone never re-pushes it.

**Counting semantics.** A notice is counted, and its experiences remembered, only after `deliver` returned; a delivery that threw
counts nothing and remembers nothing, so the queue's retry spends exactly the one notice it would have spent, under the same request
id (which is what makes it land once). A restart begins a fresh window and a fresh dedupe — that is the allowance's stated lifetime,
and DSH's own message ids are what keeps a crash redelivery from becoming a second copy. No cue spends allowance for a request with
no room, and there is no path that holds quota permanently.

**Explanation.** `Memory.status()` now returns `MemoryReport` with a `wake` state (notices, capacity, window, `nextAt`,
`remembered`, dedupeMax, and the newest cue's `outcome` + one-sentence `detail`), and the `memory-store` health line carries the same
sentence. The four reasons are `quota`, `duplicate`, `weak` and `no-room`, plus `no-cue` and `failed`; no separate management
product, no new health entry (which would have needed the panel's copy table, outside this ticket's boundary).

**Evidence.** `tests/memory-reactivation-budget.spec.ts` (eight tests, all at the Runtime boundary): the reviewer's twelve-input
sequence plus the window passing (nine then ten notices, where the old build stayed at eight), the allowance held and stated, a weak
cue, no room spending nothing, one unchanged experience deduped and waking again after the dedupe's retention, a different cue
waking the experience it is about, a forgotten experience returning as its gist with no weight/confidence/age/record change, a failed
delivery retried and counted once, and a restart beginning a fresh window whose redelivered cue lands no second copy.
`tests/memory-runtime.spec.ts`'s twelve-message test now states the window rather than a lifetime cap, and `tests/deployment.spec.ts`
carries the two settings' defaults.
