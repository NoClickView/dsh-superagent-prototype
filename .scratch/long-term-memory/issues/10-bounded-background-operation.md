# 10: 后台积压或规则升级时持续服务

**What to build:** 后台慢、离线或原则版本变化时，前台继续使用一致快照和有界新事件；后台按有限额度逐步恢复，操作者可以看到积压、成本与处理进度。

**Blocked by:** 09 — 容量受限时淘汰原文并保持可回忆

**Status:** resolved
**Spec:** [长期记忆规格](https://github.com/NoClickView/dsh-superagent-prototype/blob/f5b6a3270f390a8068413fdb61f6d2757c020a30/.scratch/long-term-memory/spec.md)

- [x] 为模型调用、并发、批次、待处理材料与重试设置可计量上限，不每天重新评分或总结全部历史。
- [x] 后台暂停或长时间超时时，前台用已发布版本与有界新事件继续服务；不丢失已接收经历，不靠无限队列或无限输入缓冲。
- [x] 存储/队列容量满时按已有容量合同背压；清晰区分已接收、待处理、失败和暂未接收材料。
- [x] 原则或模型版本改变后，用有限增量作业重评受影响记忆；重试和旧版本输出不重复生效、不覆盖当前材料。
- [x] 通过现有运行状态或只读资源公开积压、版本、最近错误、预算使用与处理进度，不引入独立可视化产品。
- [x] 输入中的指令性文本不改变原则或预算；后台控制状态由运行时明确保存，而不是评估器长期对话。
- [x] Runtime 集成测试同时施加事件持续输入、后台中断、恢复、升级及容量压力，所有实际模型请求始终守住预算。

## Answer

Resolved on `integration/long-term-memory` (ticket merge `8f145e7`).

**Limits.** Six volatile machine settings bound the work: `memoryBackgroundMaxCalls` 8, `memoryBackgroundBatch` 8,
`memoryBackgroundConcurrency` 1, `memoryBackgroundPending` 256, `memoryBackgroundTimeoutMs` 60 000 and
`memoryBackgroundAttempts` 2. Nothing rescans all history on a schedule; the sweep is triggered by a version change, a boot
or a deferral, and is cursor-and-page bounded.

**Foreground independence.** While the background is held, captures still publish and recall still answers from the
published version; a stalled call is abandoned at its timeout and recorded; the queue is bounded and a deferred plan is
re-planned from the store. Under capacity pressure the pass reclaims first and, when it frees nothing, stops with zero calls
and the queue intact.

**Repair (2026-11-07, repair ticket 04).** The answers above described a backlog that is worked through "once it is let go",
and that was not true of the code the review read. With `memoryBackgroundMaxCalls` 2 and six jobs queued while held, a resume
ran two and left four waiting; nothing but an explicit wait-for-empty call — which the tests made and production never did —
moved them. The runner now schedules the next bounded pass itself, one macrotask later, so the backlog is carried through in
rounds of at most `maxCalls` calls, `batch` jobs and `concurrency` in flight with no new event, no operator call and no wait
helper. A held runner, one the store's capacity stopped and one that advanced nothing schedule nothing of their own, so
nothing spins; a `reclaim()` that frees room is the explicit entrance a capacity-stopped queue comes back through, and
`stop()` takes the scheduled round back and waits for the call in flight so nothing commits into a closed store. Recovery in
this ticket therefore means: the queue moves on the runner's own initiative, and `memory-background` says whether the next
pass is scheduled or why it is not.

**Upgrade.** The runner reconciles the versions in force — each kind's principles, the policy, the configured model — against
the sweep key, and re-plans only the records whose committed weight or gist names an older one. Job ids name the versions
and the base version, so an old-version result is refused as stale and cannot overwrite a newer commit.

**Observability.** The `memory-background` health entry reports backlog, bound, last error and progress, and the `budget`
entry (added in review) publishes requests sent and suspended, how many of them were DSH's own housekeeping calls, paged
material and characters against the budget, and the recovery and title state of the last Session it refused.
No panel page and no new prompt text.

**Corrected on 2026-11-07 by repair 02 (`repair/02-bounded-recovery`).** This answer said the `budget` entry publishes a
`recovery` count, which described an exemption the review then reproduced as a defect: a request carrying `purpose`
`compaction` or `session-title` was sent over the configured limit while the same input was suspended as a turn. There is
no `recovery` action any more — a request is `send` or `suspend`, the entry counts housekeeping calls among them and
reports no exemption — and a Session that is over its budget is restored by bounded compaction steps (`SessionRecovery`)
whose states are `recovering`, `recovered` and `paused`. A background request that belongs to no Session is refused and
reported like any other; it has no history this runtime could compact. See
`.scratch/long-term-memory-repairs/issues/02-bounded-recovery-requests.md` and `tests/recovery.spec.ts`.

**Evidence.** `tests/memory-background.spec.ts` (including one scenario that combines continuous input, interruption,
recovery, a model upgrade and capacity pressure and asserts that every adapter request matches a budget record with
`action: 'send'` and `total <= budget`; and, for the repair above, six jobs finished two calls a round with no drain call,
work appended mid-backlog, a hold taken mid-backlog, a full queue's deferred plans recovered, a stalled call, a duplicate wake
on a clock the test drives, and a stop that leaves the rest to the next start). Known limit: the attempts counter is
in-process, so a restart re-arms it.
