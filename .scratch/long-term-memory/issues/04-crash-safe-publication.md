# 04: 写入中断后恢复一致记忆

**What to build:** 经历交付或文件发布期间进程中断，恢复后读者仍只见完整版本，未交付经历可以补送，重复投递不会重复生效。

**Blocked by:** 02 — 经历写入后可跨重启召回

**Status:** resolved
**Spec:** [长期记忆规格](https://github.com/NoClickView/dsh-superagent-prototype/blob/f5b6a3270f390a8068413fdb61f6d2757c020a30/.scratch/long-term-memory/spec.md)

- [x] 在上游已提交但文件未接收、临时写入、版本发布前后及结果确认前后注入中断，重启后可继续真实读取流程。
- [x] 文件版本一次性对读者生效；不把一次重命名等同于所有内容已可靠落盘，验证所选文件系统上的提交协议。
- [x] 稳定事件/作业标识支持恢复与去重；已应用操作的重试不会产生第二次变化。
- [x] 携带过期基础版本的提交不会覆盖新版本；返回明确冲突或安排基于新材料处理。
- [x] 读者并发读取时观察到旧版或新版完整结果，不出现混合正文、悬空版本或凭空丢失已确认数据。
- [x] 利用实际临时文件系统和 Runtime 重启/并发宿主验证，并确认既有工单执行恢复不回退。

## Answer

Resolved on `integration/long-term-memory` (ticket merge `aaed798`).

**What was built.** `src/memory/store.ts` exposes `MemoryStep`, the twelve points of the publication protocol, and a host
hook called immediately before each one, so a crash is injected by construction rather than by hand-editing files. A
read-only opening serves a version; a candidate carrying a replaced base version is refused as `{ status: 'conflict' }`
naming both versions and writes nothing.

**A real defect found and fixed here.** A checkpoint advanced `checkpointSeq` before the manifest rename that publishes it,
so with a permanently failing rename plus budget pressure, reclamation deleted journal segments whose checkpoint no
manifest named — the next open reported corruption and acknowledged experiences were gone. Fixed by publishing the manifest
before any deletion is authorised, and by not failing a durable commit when only derived index data could not be published.
The regression goes red when the old ordering is restored.

**Honest scope.** Durability is proved for **process crash only**. Directory `fsync` is `EPERM` on this platform, so no
rename is treated as a durable commit; `flushDirectory` asks for what the platform allows. A file reader can observe an
op whose fsync has not returned — asserted explicitly rather than hidden, and such an op is redelivered after a crash.

**Evidence.** `tests/memory-crash.spec.ts` (16 tests over the design's crash matrix plus the ticket's own rows),
`tests/memory-runtime.spec.ts` (restart rows), `tests/memory-store.spec.ts`.
