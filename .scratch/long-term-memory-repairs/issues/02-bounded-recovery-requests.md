# 02: 压缩和标题生成也遵守模型输入上限

**What to build:** 会话历史超限时，系统使用有界步骤恢复可继续运行的上下文；压缩和标题生成始终遵守与普通调用相同的输入预算，不能通过请求用途获得超额发送资格。

**Blocked by:** 01 — 最终模型请求计入历史工具定义并守住预算。

**Status:** resolved
**Labels:** ready-for-agent
**Priority:** P1
**Spec:** [长期记忆规格](https://github.com/NoClickView/dsh-superagent-prototype/blob/f5b6a3270f390a8068413fdb61f6d2757c020a30/.scratch/long-term-memory/spec.md)
**Source:** 2026-11-07 实现审查；基线 da65294 至 bcf5ea6。

审查复现：预算为 800 字符时，9,000 字符的普通请求被暂停，同一输入以压缩或标题生成为用途时却被作为恢复请求放行。

- [x] 复用 01 单的完整请求校验，取消压缩和标题用途的超限放行，包括无效预算配置；所有真正发出的请求都守住配置上限。
- [x] 超大历史通过每步均有界的压缩或分段处理恢复；小型必要输入也无法容纳时显式暂停并报告原因，不以绕过上限来解除暂停。
- [x] 维持现行授权、活动任务与工具调用关联；压缩失败、中断或重试不破坏可恢复历史，不重复提交压缩成果。
- [x] 标题生成只使用预算内材料，无法生成时可解释地延后或跳过，不阻塞正常业务和会话恢复。
- [x] 在 Runtime 集成测试中，从超限历史进入实际恢复流程并继续普通请求；不能靠测试直接清空历史或只修改用途来模拟恢复成功。
- [x] 对压缩的每个子请求、标题请求、普通重试及后台请求检查最终适配器输入；覆盖超限、边界、不可用配置、恢复中断和后台暂停。
- [x] 可观测状态区分恢复中、恢复完成及无法恢复的暂停；不得将超限发送记作成功恢复。

## Answer

Resolved on `integration/long-term-memory` (merge `45b3a37`).

**The exemption is gone.** It lived in `RequestBudget.record`: a third `purpose` argument turned an over-budget plan into
`action: 'recovery'`, fed by `options.purpose` from `Sessions.streamed`. A request record now has only `send` or
`suspend`; `purpose` is recorded and grants nothing. A compaction or session-title call over the budget is refused
exactly like an ordinary turn, including when the budget configuration itself is unusable. This is the change repair 01
deliberately left for this ticket.

**Bounded liveness instead.** `src/app/recovery.ts` (`SessionRecovery`) drives DSH's own `compactRegion` over one
balanced surface range per step, sized so the summarisation request that range implies fits the same budget. A step never
splits an assistant tool call from its results. If a step is still refused, nothing reached the adapter and the gap that
refused step *measured* sizes the next range — no foreign constant can drift from DSH's instruction. When even the
smallest step cannot fit, the Session is paused with the reason; the limit is never lifted to break the pause.

**What survives.** Current authorisation, active tasks and tool-call association stay intact. An interrupted step closes
DSH's `compaction/start…compaction/end` bracket with an error and no replacement, so the history is exactly as it was and
the state is `paused` with the reason; a retry re-derives its range from the current surface, so a committed range is
gone and nothing commits twice. A session title uses only in-budget material and is deferred and retried after recovery,
or skipped with its reason, never blocking the Session's own work.

**States.** `recovering`, `recovered after N step(s)` and `paused (reason)` are visible on the `budget` health entry,
through `Sessions.recovery`/`Sessions.recovered`, and in the refusal note a person sees. No record can be an over-limit
"recovery".

**Evidence.** `tests/budget.spec.ts` — the red-before test
"refuses a housekeeping call that is over the budget, as it refuses any other request" failed with `action: 'recovery'`
where `suspend` was expected. `tests/recovery.spec.ts` — six 1,000-character tool results against a 1,500-character
allowance: the ordinary turn refused, real steps run (each a `send` within budget, the adapter seeing only
`purpose: 'compaction'` calls), state `recovered`, then an ordinary request is sent and fits, with every original event
still in the log. Siblings cover an interrupted step and its retry, the tool pair that is never split, a budget too small
for one step, an unusable configuration, a background refusal, and a title deferred/retried/skipped.

**Known limit.** The production seam is `agent.ctx.get('compaction')`, and DSH's `compactRegion` requires an open turn
when a request is refused. The fixture models that contract; a live DSH profile was not exercised here. If the service is
unreachable the Session pauses with that reason rather than breaking.

**Review-round correction (2026-11-07).** Two statements above are out of date, and one behaviour was wrong and is
fixed:

- The Session accessors are `recoveryNow()` (answers without waiting) and `awaitRecovery()` (waits, then answers).
  They were `recovery()` and `recovered()` — one letter apart for two different contracts.
- **A refusal that compaction cannot repair no longer claims a recovery.** A request whose final size could not be
  established (`unmeasured` — a file-carrying request, or a route that cannot describe itself) or whose required parts
  alone are over the budget used to be routed into history recovery, which reported `recovered` with 0 steps and the note
  "its next request fits" even though the same request was refused again. `SessionRecovery.unrepairable()` now records
  `paused` with the refusal record's own cause and takes no step; recovery is entered only for a size refusal that
  history can actually fix, and `recovered` is claimed only after a committed step refunded room. Tests:
  `tests/recovery.spec.ts` — "pauses for a refusal no compaction can repair, naming the true cause instead of claiming
  a recovery", and "pauses with the reason the required parts give, when compacting the history could not have helped".
- A Session title refused **while a recovery is running** is now recorded as the deferral or skip it is, instead of
  being dropped silently by the in-flight guard.

## Reopened (2026-11-07, second review round)

Three findings, one of them a correctness bug that survives the recovery itself.

**1. [P1] After a compaction recovery, new material is still squeezed out by the replaced log.** `src/app/sessions.ts`
around line 246 (`paged`) and `src/app/runtime.ts` around line 258 (`agentMaterial`) compute the remaining room with
`measureEvents(agent.session.snapshotEvents())` — the **raw** log, which still contains every message the compaction
replaced. Reproduced by the reviewer: after recovery the real request had 442 characters free, yet the recall allowance
was zero and a 25-character new instruction was truncated entirely. These entry points must measure the **current
model-visible content** — DSH's own surface after its replacement events (`foldSurface` /
`deriveEventMessage` from `@deepseek-ai/dsh-session/surface`) — not the append-only history that compaction has
already superseded.

- [x] One measurement of "what the model will actually see" used by every entry point that computes room or an
      allowance: paged messages, paged tool results, and the recalled-material allowance.
- [x] A test that reproduces the reviewer's case: compact a Session, then show that a new small message and a recall
      notice both fit in the room the real request leaves, rather than being cut against the replaced history.

**2. [P2] A successful eighth step is reported as paused.** `src/app/recovery.ts` around line 289 returns
`paused` ("after N compaction steps the Session is still over its budget") when the step budget runs out, without
re-measuring. Reproduced: after the eighth step the request already fitted, yet the report said it was still over and the
deferred Session title was never retried.

- [x] After the step budget is exhausted, **re-measure**: if the Session now fits, settle `recovered` with its step
      count and run the deferred-title retry; only report `paused` when it genuinely still does not fit.

**3. [P3] The recovery host depends on more than it uses.** `src/app/recovery.ts` around line 79 takes the whole
`RequestBudget`; it uses exactly `policy`, `plan`, `last`, `requestsOf` and `definitionsOf`. Narrow it to those
five, as the background scheduler's dependency was narrowed in the previous round.

- [x] `RecoveryHost.budget` is a narrow capability, and the typecheck proves no other member is reached.

`Status:` was `resolved`; this ticket is **open** again until these hold.

## Answer (second round, 2026-11-07)

All three reopened findings are closed on `integration/long-term-memory` (merge `84db904`).

**1. Room is now measured on what the model actually sees.** One function, `measureVisible(session)`, measures
`measureRequest({ messages: session.deriveMessages() })` — DSH's own derived history, the live cached form of
`foldSurface` + `deriveEventMessage`, in which a committed compaction replacement has already taken the place of the
range it shadowed. `Sessions.paged` (paged messages **and** paged tool results) and `Runtime.visibleMaterial` (the
recalled-material allowance) both use it. The two measurements are now named apart so the wrong one cannot be picked
again: `measureVisible` takes a Session, `measureSurfaceEvents` takes surface events a caller has already selected and
is documented as never being a Session's log. The raw log is still read, but only where it is not a measurement:
recovery's per-node range analysis (which filters to `session.surface.nodes`), `RetryHealth.restore`, and model
selection. The reviewer's case is a test: after compaction a new 25-character instruction and a recall notice are both
delivered whole, with no page record, whereas before the fix the allowance was zero while the real request had over 200
characters free.

**2. A successful last step settles `recovered`.** The step loop now decides on a fresh measurement on every iteration,
including the last one it may take: fits ⇒ `recovered` with its step count and the deferred-title retry; required parts
over ⇒ paused naming that; unusable configuration ⇒ paused naming that; the step budget exhausted while still over ⇒
paused saying so. The unconditional post-loop `paused` is gone. Tests: "settles recovered when the last step the budget
allows is the one that made the Session fit" (red before: `paused`, 8 steps) and "pauses after the last step the budget
allows only when the Session genuinely still does not fit".

**3. The recovery host is narrowed.** `RecoveryBudget = Pick<RequestBudget, 'policy' | 'plan' | 'last' | 'requestsOf' |
'definitionsOf'>`, and `RecoveryHost.budget` is that; the typecheck proves no other member is reached.

**Known limits (unchanged).** The production seams — `compaction`, `sessionTitle`, `deriveMessages` — are modelled by
the fixtures, not exercised against a running DSH profile.
