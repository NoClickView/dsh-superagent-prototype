# 02: 经历写入后可跨重启召回

**What to build:** 一条运行时经历通过唯一服务写入文件，正常重启后仍可按来源、范围和线索找到，并在固定预算内返回给实验体。

**Blocked by:** 01 — 每次模型输入守住预算

**Status:** resolved
**Spec:** [长期记忆规格](https://github.com/NoClickView/dsh-superagent-prototype/blob/f5b6a3270f390a8068413fdb61f6d2757c020a30/.scratch/long-term-memory/spec.md)

- [x] 从一个实际 Source 事件或执行结果开始贯通捕获、权威文件写入、只读查询及模型输入；提供可运行的演示场景，不止提供存储 API。
- [x] 经历包含稳定标识、发生/写入时间、来源、主体及项目/任务范围；区分观察与推断，保留来源标识。
- [x] 重复上报同一事件只产生一段经历；建立可恢复的输入交付记录或进度，不能依赖提交后仅存在于内存的通知。
- [x] 通过记忆服务单点提交，形成读者可识别的完整版本和基础版本校验；正常重启恢复原身份及可用内容。
- [x] 首版可采用简单确定性的关键词、实体或时间检索；只在允许范围返回原文片段，计入统一输入预算。
- [x] 初期文件容量满时能够背压，不因尚未实现智能淘汰而无限写入；外部写入权限的进程级验证由后续专票完成。
- [x] 记忆不授予新权限；当前工单、Mandate 及未完成事项仍由现有业务状态维护。
- [x] 在 Runtime 集成边界验证写入、重复投递、正常重启、范围隔离和最终模型输入；所有公开写操作归唯一服务。

## Answer

Resolved on `integration/long-term-memory` (ticket merge `6b669c6`).

**What exists.** `src/memory/model.ts` (the domain: `Experience`, `Representation`, `MemoryRecord`, material, stable
ids, limits), `src/memory/store.ts` (the files under `<stateDir>/memory`: an fsynced append-only journal as the commit
point, checkpoints and a manifest a restart replays past, recovery that drops a torn unacknowledged append, capacity
accounting), `src/memory/retrieval.ts` (deterministic cues for Latin words and CJK bigrams, the scope filter before any
matching, the character-bounded recall block) and `src/memory/service.ts` (`MemoryService`, the single submit/read
entry). `src/app/memory.ts` captures domain facts as durable `memory` effects inside the Engine's transaction, which is
the recoverable delivery record the ticket asks for.

**Reaching the model.** Recall is delivered as a `recall`-formed message (so ticket 01's budget counts it as the
`recall` part and can give it up first) plus the `memory` and `memory/<id>` read resources. Recall never enters the
system prompt: `tests/model-surface.spec.ts` caps prompt plus tool text and is nearly full.

**Runnable demonstration.** `npx vitest run tests/memory-runtime.spec.ts` walks a Feishu trigger through capture, the
files on disk, the read resource, the delivered notice and the model's input, then a redelivery, a restart, a torn
append, scope isolation and an exhausted budget.

**Evidence.** `tests/memory-store.spec.ts`, `tests/memory-recall.spec.ts`, `tests/memory-runtime.spec.ts`.
Honest limits: `source` records the Source kind with the exact ids in `origin.ids`, and durability is scoped to process
crash on this platform (ticket 04).
