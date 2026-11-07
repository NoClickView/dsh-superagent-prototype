# 03: 记忆接收积压纳入容量预算并向入口背压

**What to build:** 记忆存储容量不足或不能提交时，待接收经历也保持有界；前台明确区分已经接收与暂未接收的材料，空间释放后可以恢复补送，不把无限增长转移到业务数据库。

**Blocked by:** None (can start immediately).

**Status:** resolved
**Labels:** ready-for-agent
**Priority:** P1
**Spec:** [长期记忆规格](https://github.com/NoClickView/dsh-superagent-prototype/blob/f5b6a3270f390a8068413fdb61f6d2757c020a30/.scratch/long-term-memory/spec.md)
**Source:** 2026-11-07 实现审查；基线 da65294 至 bcf5ea6。

审查复现：记忆预算 65,536 字节，连续输入 320 个约 32 KB 的事件，记忆目录仅计量 18,012 字节，但 SQLite 中仍保留 318 个待处理正文，合计约 10 MiB；继续输入会继续增长。

- [x] 为待接收材料建立明确、可计量的字节与条目上限，连同持久化队列、必要日志及暂存空间纳入有限容量合同，不另设无界缓冲区。
- [x] 在达到上限前执行接收决策及背压；明确报告已接收、待处理、失败与暂未接收，不能先宣称接收成功再静默丢弃。
- [x] 若使用源事件引用与补送游标替代重复正文，验证源记录的保留、可重放性及读取失败语义；不能把保留压力转移成另一个无限集合。
- [x] 业务事实已经提交但记忆尚未接收时，崩溃重启后仍有有界、持久且幂等的恢复路径；容量恢复后逐步补送，重复事件只生效一次。
- [x] 存储满、隔离边界拒绝写入、后台暂停、持续输入及并发接收均不突破待接收容量；不改变现行授权、活动任务或业务事实的一致性。
- [x] 用 Runtime 集成测试覆盖 64 KiB 与超过 320 个大事件的压力，观测所有记忆相关持久化占用，而非只检查记忆目录；同时验证恢复补送和稳定的容量状态。
- [x] 在现有健康状态中提供队列容量、占用、背压原因与恢复进度，操作者无需查数据库判断是否仍在无界增长。

## Answer

Resolved on `integration/long-term-memory` (merge `3a60843`).

**What was wrong.** With a 65,536-byte memory budget the runtime accepted 320 events of about 32 KB: the memory
*directory* reported 18,012 bytes while `orchestrator.sqlite` kept 318 pending payloads ≈ 10 MiB, still growing.
`capture()` enqueued the whole payload with no admission, and `Later` back-pressure simply moved the growth into the
business database.

**The bound.** `src/memory/store.ts` gains the pending half of the capacity contract (`PENDING.share`,
`pendingBytesOf(budget)`): the queue may hold as many payload bytes as the store itself, and `memoryPendingMaxItems`
(default 256) captures. Files ≤ budget plus queue ≤ budget, so every memory-related persisted byte is ≤ 2 × budget. The
pending ceiling never spends the store's reserve, and the store's watermarks still decide when it back-pressures.

**Admission at the receiving boundary.** `capture()` decides accepted, queued or refused *before* the row is written,
with one synchronous read of the queue plus one synchronous write, so two receipts in the same tick cannot both pass. A
key that already waits replaces its own row instead of counting twice; past the bound the capture is refused and counted,
never claimed and then dropped.

**Four states, observable.** received (published), pending (durable queue), failed (a payload that is not a capture, an id
mismatch, or a row keyed with another fact — now counted rather than settled in silence) and not-yet-accepted (refused,
with the sentence naming why). Both `memory-store` and `memory-background` report capacity, occupancy, the back-pressure
reason and the refusal count; the waiting count is read from the queue, so a restart reports what really waits.

**What "resume when space frees" covers.** Only the durable queue. A capture the store could not take is a row in
`orchestrator.sqlite` and is delivered when the store has room — across a restart, one attempt per due row, exactly
once. A capture **refused at the receiving boundary** is a different thing: it was never held anywhere, so freeing space
later does not bring it back. It is dropped, counted in `pending.refused`, and the business row it came from is the only
record left of it. The `memory-store` detail now says the two apart in one line — what waits is "offered again as the
store takes them", and a refusal is "not held for a later delivery" — because reading a refusal count as material a
freed queue will deliver is exactly the mistake that distinction exists to prevent.

**Evidence.** `tests/memory-pending.spec.ts` reproduced 10,489,866 bytes of queue for a 65,536-byte store and now settles
at files 8,754 + queue 32,988 with 477 refused, measuring *all* persisted memory bytes (the directory walked recursively
plus `SUM(LENGTH(CAST(value AS BLOB)))` over the `memory` rows — bytes, not the characters `LENGTH` counts over a text
value, which is what let a 65,536-byte queue hold three times that in CJK text); `tests/memory-runtime.spec.ts` does the
same through the real Runtime, and a restart drains the queue applying each waiting fact exactly once. The same spec
proves both halves of the sentence above: the waiting rows drain once the store has room, and the facts the boundary
refused stay unremembered.

**Known limit.** No source-event references or replay cursor: the payload stays the full capture, clipped by
`CAPTURE_MAX_CHARS`. A reference design still needs its own bound and would re-derive content from mutable business rows at
dispatch time. The consequence is stated plainly — a fact refused at the boundary is not re-captured later; the business
keeps its own record and memory does not scan for it.

## Reopened (2026-11-07, second review round)

**The acceptance line "空间释放后可以恢复补送" is still not met.** `src/app/memory.ts` around line 455 refuses a capture
by incrementing an in-memory counter and returning — there is no durable record of what was refused, so nothing can ever
offer it again. Reproduced by the reviewer: with the pending queue holding one entry, two business facts are submitted;
after space is freed **and the runtime restarts**, the memory still holds one experience and the refusal count has reset
to zero. A refusal is therefore a permanent, silent loss.

- [x] Give a refused capture a **durable** redelivery position: a bounded, persisted list of what was not accepted (an
      event reference is enough only if it can be re-derived — otherwise keep the material), surviving a restart.
- [x] Re-offer it when capacity returns (the existing released-capacity wake, a successful publish, and at startup),
      gradually and through the same single commit entry, never in one unbounded burst.
- [x] Bound that list by the same capacity contract as the queue (its own item bound and a byte bound), evicting the
      oldest **explicitly and visibly** as permanently lost rather than dropping silently.
- [x] The reported "not yet accepted" figure must be read from the durable list, so it does not reset to zero while
      material is still outstanding.
- [x] A re-offered capture keeps its stable experience id, so a redelivery and an original can never both apply.
- [x] Test at the Runtime boundary: queue capacity 1, submit two facts, free space, restart, observe the second fact
      published exactly once after the restart; and a case that stays refused reports a stable count.

**Also from this round (byte accounting is done; this is the remaining half of it):** none — the byte/character mismatch
was fixed. This reopen is only about the missing redelivery path.

Status was `resolved`; this ticket is **open** again until the four behavioural boxes above hold.

## Answer (second round, 2026-11-07)

Resolved on `repair/r2-03`. Status was `reopened`; every box above now holds.

**What a refusal is now.** `src/app/redelivery.ts` (`Redelivery`) keeps the capture at a durable position: one KV record
(`KV.memory.redelivery`, key `memory-redelivery`) holding the exact `ExperienceInput` an enqueue would have carried,
written inside the Engine's transaction that recorded the business fact — so a rolled-back command leaves no position
behind either.

**Material, not a reference.** `inputOf` assembles a capture from rows a later write changes: a Ticket's title, its
mandate and the report it ended with (`ticket.created`/`resumed`/`ended`), the Trigger row a Source may save again and the
disposition its fanout was read from (`trigger.received`). A `policy.changed` capture is stored nowhere else at all. A
reference would re-derive a *different* capture under the same experience id once the row moved — a different fact, not
the refused one — so every kind keeps its material. It is exact because it is byte-for-byte the payload the queue would
have stored, already clipped by `CAPTURE_MAX_CHARS`, and it carries the stable `experienceId` that is both the queue's
coalescing key and the store's dedupe key, which is what makes a redelivery of what the store holds a no-op.

**The two bounds, where they are configured.** `memoryRedeliveryMaxItems` (`src/limits.ts`, `src/deployment.ts`; 64 by
default) and `pendingBytesOf(memoryBudgetBytes)` (`src/memory/store.ts`) — the same payload-byte share the queue takes.
Past either bound the oldest are evicted and counted into the record's durable `lost` count, and the `memory-store`
entry reports it: "N permanently lost: the oldest were evicted when that position reached its X captures or Y bytes".
Three areas carry the whole contract — files <= budget, queue <= budget, position <= budget — so every memory byte is
<= 3 x budget instead of the reviewer's ten megabytes. A capture larger than the whole bound is lost at once and costs
nothing already held, because no room can be made for it by evicting the others; and one fact refused twice is one
capture waiting, since the position coalesces on the experience id exactly as the queue's own row does.

**Offering back.** `reoffer()` moves **one** capture per trigger, only when the queue would admit it (`admitsPending`, the
same predicate the receiving boundary uses), through `handOver`, which enqueues the durable `memory` effect row and drops
the position entry in one transaction. The three triggers are startup (`createMemory`), a delivery that reached the store
(`store()`, discounting the row it is finishing), and `reclaim()` when it freed something (the released-capacity wake).
There is a **fourth** entrance, `admit()`: the composition starts before setup has resolved the world, so the boundary
check that decides whether writes run is the moment a deployment gated on one becomes able to publish, and what was
refused while the gate was shut is offered again there. It is kept deliberately — an operator opening the write gate
should re-offer — and the three above are the ticket's list, not a closed set. A refused capture cannot spin: it moves
only into room the queue has, and a delivery that publishes nothing offers nothing.

**The figure an operator reads.** `PendingState` gains `redelivery` (items, bytes, both bounds, `lost`, `state`) and
`notYetAccepted` = queue items + position items, both read from what is stored, so a restart reports the outstanding
material instead of zero. `refused` stays this runtime's operational count; the `memory-background` entry's "not yet
accepted" is the durable sum.

**Evidence.** `tests/memory-runtime.spec.ts` — the reviewer's scenario at the Runtime boundary: queue capacity 1, a shut
gate, two facts (one queued, one refused), stop, restart with room, and the second fact published exactly once; it failed
on `KV.memory.redelivery` being absent before the fix. `tests/memory-pending.spec.ts` — the position bounded with its
evictions reported and the oldest named, the durable figure holding across a restart while the material is outstanding,
exactly one capture offered back per trigger (startup, then a delivery; a retry that publishes nothing moves nothing), the
release trigger draining it through `reclaim()`, and the whole recovery publishing every held fact exactly once.

**Known limits, stated.** The position is one KV record rewritten per refusal, bounded by its own byte bound rather than
streamed. `refused` still begins again with the runtime (the durable figure is `redelivery.items`). Nothing re-scans the
business database for a fact evicted past the bound: an eviction is permanent, and is reported as such.

## Reopened (2026-11-07, third review round)

**One P2 finding: the re-offer spends a slot that has not been freed yet.**

`src/app/memory.ts` offers a refused capture back from *inside* the delivery handler (`store()`), and to make room it
discounts the row the current delivery still holds (`releasedRoom`: "its own row is still there until the handler
returns, so the place it takes and the payload bytes it holds are already free"). That is not true: `Effects.attempt`
deletes the row only **after** the handler resolves, and it does not delete it at all when the handler fails, throws
`Later`, or the process stops mid-attempt. The re-offer therefore inserts a second row while the first still exists.

Reviewer reproduction: with the position's item bound at 1, a delivery fails; the old entry stays queued for retry and
the newly offered entry is already inserted — **2 durable entries against a bound of 1**, still over the bound after a
restart.

- [x] Offer the next capture **after the old row is confirmed released**, or make the handover atomic (the release and the
      new insert in one transaction). No discount computed on a row that still exists.
- [x] The invariant must hold at every observable moment, including after a failed delivery, a `Later` retry and a
      restart: queue items + position items never exceed their configured bounds.
- [x] Test the reviewer's case: bound 1, a delivery that fails, then a restart — the durable total stays at the bound,
      and the refused capture is still offered later when room genuinely exists.
- [x] Remove the discount path (`releasedRoom` and the `finishing` parameter) rather than leaving it unused, and state in
      the code comment what now guarantees the handover.

**Standards: none outstanding** — the review confirmed the previous round's dependency-widening finding is fixed and
that the earlier reproductions pass.

Every box above holds; the answer is below. `Status:` was `resolved`, this ticket was **open** again, and it is `resolved` again.

## Answer (third round, 2026-11-07)

Resolved on `repair/r3-03`. Status was `reopened`; every box above now holds.

**What was wrong.** `reoffer(finishing)` subtracted the delivering row from the occupancy it read (`releasedRoom`), on the comment's
claim that "its own row is still there until the handler returns, so the place it takes and the payload bytes it holds are already
free". `Effects.attempt` deletes the row only **after** the handler resolves, and keeps it entirely when the handler fails, throws
`Later`, or the process stops mid-attempt — so an offer made from inside a failing delivery inserted a second row beside the first.
Measured at the Runtime boundary, with the position's item bound at 1 and a delivery that fails: **2 durable queue entries against a
bound of 1**.

**What now guarantees the handover.** `Effects` has `released(kind, listener)` (with the `ReleaseListener` type): the one notification
sent *after* the successful `DELETE` in `attempt`, and only when that statement removed the row (`.changes > 0`). `createMemory`
subscribes once, and `reoffer()` runs from there with **no discount at all** — the occupancy it reads is the queue's own truth, taken
after the place is really free. `releasedRoom` and `reoffer`'s `finishing` parameter are deleted rather than left unused; `reoffer`'s
comment now states what asks for it, and `store()`'s comment states why the delivery itself must not. `memory.close()` takes the
subscription back first, so a closed memory is never offered anything. The other entrances are unchanged: startup (`createMemory`),
`admit()` when the write gate opens, and the released-capacity wake in `reclaim()`. Only the timing of the delivery entrance changed —
a successful publish still offers one capture back, now after its row is deleted instead of before.

**The invariant.** Queue items ≤ `memoryPendingMaxItems` and queue payload bytes ≤ `pendingBytesOf(memoryBudgetBytes)`; position items
≤ `memoryRedeliveryMaxItems` and its payload bytes ≤ the same share — at every moment a reader can observe, including after a failed
delivery, a `Later` retry, and a restart. Each area is measured against its own bound, no figure is discounted for work still in
flight, and the handover's two writes (the queue row and the record that stops holding the capture) commit in one transaction, so no
reader sees the capture in both places or in neither.

**Evidence.** `tests/memory-runtime.spec.ts` runs the review's own case at the Runtime boundary: queue bound 1, position bound 1, the
second fact's delivery failing where it hands its recalled context to the Session, the fact after it refused to the position, the
retry that failure scheduled run and failed again, then a restart — one queue row and one held capture at each reading, and once the
delivery goes through the refused fact is published exactly once. It failed before the fix with
`expected 2 to be less than or equal to 1`. `tests/effects.spec.ts` pins the notification's timing directly: the listener reads the
kind's queue as empty when it is told, and a failure, a `Later`, and a shutdown mid-attempt tell it nothing. `tests/memory-pending.spec.ts`
keeps the released-capacity wake test honest by dropping its waiting row with `cancel` instead of settling it through the queue, because
a settled row's release legitimately offers one capture back now.

**Known limits, stated.** A row the queue is asked to `cancel` frees its place without a notification, so a refused capture waits for
the next entrance (a start, a release, the write gate, or reclamation) rather than for that drop; nothing cancels a `memory` row today.

