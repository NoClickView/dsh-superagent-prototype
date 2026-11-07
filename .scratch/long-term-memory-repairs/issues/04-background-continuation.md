# 04: 后台积压按有限额度自动续跑

**What to build:** 后台恢复或接收一批经历后，在没有新事件、没有操作者主动调用的情况下，自动逐轮处理剩余作业；每轮保持调用、批次和并发上限，暂停或容量不足时停止空转。

**Blocked by:** None (can start immediately).

**Status:** resolved
**Labels:** ready-for-agent
**Priority:** P2
**Spec:** [长期记忆规格](https://github.com/NoClickView/dsh-superagent-prototype/blob/f5b6a3270f390a8068413fdb61f6d2757c020a30/.scratch/long-term-memory/spec.md)
**Source:** 2026-11-07 实现审查；基线 da65294 至 bcf5ea6。包含 P3 窄依赖规范问题的先行整理。

审查复现：暂停期间排入 6 个作业，每轮调用上限设为 2；恢复后只运行 2 个，剩余 4 个一直等待。显式调用等待清空接口才会驱动其继续执行。

- [x] 先缩小后台调度器的服务依赖，只暴露它实际需要的版本、策略、状态、扫描与回收能力；保留作业候选通过记忆服务提交的既有职责。
- [x] 单轮达到额度而仍有可推进工作时，自动安排下一轮并让出执行机会；只有一个调度者，不依赖新增事件或测试等待函数驱动进度。
- [x] 每轮调用数、总处理批次、并发、等待队列和重试均遵守有效配置；持续积压时前台仍可响应，失败不得变成无上限重试。
- [x] 暂停、容量不足或没有可推进工作时不忙循环；恢复、容量释放和可重试条件变化后有明确的再次调度入口。
- [x] Runtime 停止时取消后续调度，不在关闭存储后继续提交；重新启动仍按已有幂等与基础版本规则处理工作。
- [x] 在 Runtime 集成测试中用可控时钟、模型响应和只读进度观察，验证 6 个作业按每轮 2 个自动完成；不得调用会主动清空队列的等待接口来证明自动续跑。
- [x] 覆盖运行中追加、暂停再恢复、容量不足再恢复、模型超时及重复唤醒；现有健康状态准确显示推进或阻塞原因。

## Answer

Resolved on `integration/long-term-memory` (merge `66a6ca2`).

**What was wrong.** With `maxCalls = 2` and six jobs queued while paused, `resume()` ran exactly two and left four
waiting; only an explicit wait-for-empty call drove the rest. The background resumed for one bounded pass and then stalled
until a new event or an operator action.

**Narrowed first.** `BackgroundHost.service` was the whole `MemoryService`; it is now a five-capability
`BackgroundMemory` (version, policyVersion, status, scan, reclaim). The job kinds still take the full service, so a
candidate still commits through the memory's one commit path — the scheduler only reads. That narrowing is also what let the
released-capacity entrance be proved over a stand-in with no store.

**Continuation.** A pass that spends its call bound with work left sets `owed`; when the pass settles, `drain()`'s
`finally` schedules exactly one `setTimeout(…, 0)` — a macrotask, so the foreground is served between rounds — whose
callback runs the next pass. One timer at a time. `pause()`, `stop()` and an explicit `drain()` clear it. A held pass, a
pass stopped for capacity and a pass that advanced nothing schedule nothing; `resume()`, the new `wake()` (called by
`reclaim()` when it freed room) and `enqueue()` are the explicit entrances. `stop()` cancels the scheduled round and
awaits the pass in flight, and `memory.close()` — now async and awaited by the runtime — stops the background before the
store closes, so a call already in flight commits while the files are open and nothing starts after.

**Evidence.** The red-before test "runs six jobs two calls at a time, with no event, no operator and no wait-for-empty"
failed at `expected [ Array(2) ] to have a length of 3 but got 2` — two calls, four queued forever — and now shows three
passes of two calls each and all six committed, with `settle()`/`whenIdle()` never called. Ten new runtime-boundary tests
cover work appended mid-backlog with a foreground capture served in between, a hold taken mid-backlog, a full queue's
deferred plans recovered as it drains, a stalled call abandoned with the rounds carrying on, a duplicate wake and 60
seconds of driven virtual clock costing nothing, a full store that schedules nothing of its own, the released-capacity wake
over a stand-in memory, and a stop that lands the call in flight and leaves the rest to the next start.

**Known limits.** A storage-full store of inline material can free no byte in process, so at the Runtime boundary the
stopped-without-spin path and the reclaim wake are pinned, and the released-capacity wake is proved at the scheduler seam.
A capture landing while a background call is in flight still makes that reply `stale` under the pre-existing base-version
rule and is not re-planned until the next sweep; the attempts counter stays in process, so a restart re-arms it.

## Reopened (2026-11-07, second review round)

**One finding: a pass does not respect `batch`.** `src/memory/background.ts` around line 623 sizes each slice with
`Math.min(limits.batch, limits.concurrency, limits.maxCalls - calls, queue.length)` but the `while` loop keeps taking
slices until `calls >= maxCalls`, so `batch` bounds only how many run **at once**, never how many a **round** may
process. Reproduced by the reviewer: with `maxCalls = 6` and `batch = 2`, one round processed all six jobs. Ticket 10's
own wording is "每轮调用数、总处理批次" — the round's cumulative processed count is the bound.

- [x] A round takes at most `batch` jobs in total, whatever `maxCalls` allows; what is left is scheduled as the next
      round through the existing continuation.
- [x] Test: `maxCalls = 6`, `batch = 2`, six jobs queued -> passes of two jobs each, three rounds, all six completed,
      with no wait-for-empty helper.
- [x] The pass record and the health line still name why a round stopped (batch, calls, held, capacity).

`Status:` was `resolved`; this ticket is **open** again until these hold.

## Answer (second round, 2026-11-07)

The reopened finding is closed on `integration/long-term-memory` (merge `f849c0f`).

**A round is bounded by its batch.** `pass()` now stops at `batch` jobs **taken in total**, whatever `maxCalls` would
still pay for: the slice is sized `batch - ran`, `ran` counts jobs taken (a skipped job spends a batch slot and no call),
and `PassRecord.stopped` gained `'batch'`. `concurrency` still bounds what runs at once; `maxCalls` still bounds the
spend, so a round can stop on `calls` before it fills its batch — and the existing continuation (`owed` → one
`setTimeout(0)`) schedules the rest as the next round, with nothing scheduled when held, capacity-stopped or
non-advancing. The health line already renders `then stopped for …`, so a round that used its whole batch reads
differently from one that ran out of calls.

Reproduced before the fix with the reviewer's configuration and fixed after: `maxCalls = 6`, `batch = 2`, six jobs
queued — before, one pass of six (`[[6,6,null]]`); now `[[2,2,'batch'],[2,2,'batch'],[2,2,undefined]]`, six committed,
with `settle()`/`whenIdle()` never called. Siblings cover a round stopped on `calls` before reaching its batch
(`maxCalls = 2`, `batch = 6` → `['calls','calls',undefined]`) and a queue shorter than the batch (three jobs with
`batch = 4` → one pass). The setting's description in `src/deployment.ts`, `docs/006` and the `docs/007` row were
corrected from "at a time" to "in total".
