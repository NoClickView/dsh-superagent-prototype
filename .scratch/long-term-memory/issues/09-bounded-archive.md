# 09: 容量受限时淘汰原文并保持可回忆

**What to build:** 归档接近容量上限时，系统按明确策略回收低保留优先级原文和无用派生数据；仍可回忆留下的梗概，读取已淘汰原文会明确返回不可用。

**Blocked by:** 04 — 写入中断后恢复一致记忆；06 — 后台压缩后按需读取记忆细节

**Status:** resolved
**Spec:** [长期记忆规格](https://github.com/NoClickView/dsh-superagent-prototype/blob/f5b6a3270f390a8068413fdb61f6d2757c020a30/.scratch/long-term-memory/spec.md)

- [x] 存储使用量涵盖原文、摘要、索引、历史版本、日志与暂存空间，预留提交和恢复所需空间。
- [x] 由存储高低水位及保留优先级触发回收，退出主动召回的阈值本身不直接删除原文。
- [x] 容量回收贯通占用观测、候选选择、唯一服务提交、索引更新与下一次召回；原文不可用状态可见。
- [x] 优先回收可重建缓存和无用版本，按可配置数值策略决定原文候选；不自行引入无限保留的保护类别。
- [x] 梗概或线索若仍在可供召回，但不得从失效索引读出已淘汰正文，也不得由摘要补造细节。
- [x] 预算不足且没有合格淘汰项时，对新增大正文背压或暂停并报告容量状态；硬上限不被隐式突破。
- [x] 在小容量真实临时文件系统中覆盖并发读取、回收中断、重启及重复回收，证明恢复后的记忆版本仍一致。

## Answer

Resolved on `integration/long-term-memory` (ticket merge `da615d1`).

**Accounting.** Six classes are walked from the filesystem on every commit — original material, summaries, index, journal,
history (checkpoints and manifest) and temporary/staging — and reported in `MemoryStatus.capacity` and `usage`.
`reserve = max(3 blocks, 2%)` covers staging, a manifest and one journal line, and only a commit that frees space may spend
it.

**Reclamation.** `src/memory/archive.ts` holds a versioned retention policy: watermarks 0.9 / 0.75 over *usable* bytes, and
a retention score `(weight·3 + (no gist ? 100 : 0)) / 4` on 0–100. Reclaimable caches and useless versions go first, then
original material ascending by retention. No protected class exists — a gist-less original is only ordered last. Forgetting
thresholds delete nothing; eviction is a separate, explicit decision.

**What a reader sees.** An evicted original answers `{ status: 'evicted', evictedAt, evictedBy }` and never text; the recall
line marks `[original no longer stored]`; `list` reports `readable: false`; a gist is never dressed as detail. A full
store with no candidate back-pressures new large originals through the existing path and reports capacity.

**Two hazards the tests forced out.** An eviction commit was itself back-pressured at the cap (a deadlock — the reserve now
covers the commit that frees space), and a blob shared by two experiences was deleted while the other still named it (they
are released together). Recovery is proved against interruption at the same seams ticket 04 introduced.

**Evidence.** `tests/memory-capacity.spec.ts` (15 tests on a small real temporary filesystem).
