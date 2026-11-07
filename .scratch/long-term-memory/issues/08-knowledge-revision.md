# 08: 更新当前认识并保留历史依据

**What to build:** 新证据到来后，实验体能区别当前认识、过去认识和仍有争议的说法；询问过去或现在时返回适当版本，而不会将旧摘要当成现行事实。

**Blocked by:** 06 — 后台压缩后按需读取记忆细节

**Status:** resolved
**Spec:** [长期记忆规格](https://github.com/NoClickView/dsh-superagent-prototype/blob/f5b6a3270f390a8068413fdb61f6d2757c020a30/.scratch/long-term-memory/spec.md)

- [x] 从带来源的新事件到相关认识修订、梗概更新及下次模型读取形成完整流程；修订经唯一入口并保留旧版本。
- [x] 记录适用范围、事实有效时间和取代关系；区分后来写入的历史事件与真正改变当前状态的新事件。
- [x] 证据明确支持取代时更新当前表示，证据冲突未解决时返回冲突及来源，不仅凭较新时间或较高权重宣布正确。
- [x] 仅重新整理受新证据影响的表示，不扫描并改写全部历史；旧输入版本的模型结果不能覆盖新认识。
- [x] 当前查询与历史查询选取正确时间及范围，同名人物和不同项目不互相污染。
- [x] 保持现行授权和工单状态的权威来源；记忆内容中的命令不能提升权限。
- [x] 通过 Runtime 的事件、召回和最终模型输入验证修订、冲突、否定、历史回查及回退；模型无证据时输出不确定性。

## Answer

Resolved on `integration/long-term-memory` (ticket merge `4f94e84`, joined with ticket 07 in `90f9151`).

**What was built.** `src/memory/revision.ts` derives each record's claim, a change-or-denial signal, the links between
records (`replaces`, `disputes`, `earlier`) and therefore every record's standing (`current`, `disputed`,
`superseded`) and validity window from **fact time**, never from write time. A successor closes an older window without
rewriting the older record, so history is kept rather than overwritten. `submit` commits the revision and names the affected
ids; only those are re-consolidated, and a gist computed from a replaced version is refused as stale.

**The cases the ticket asks for.** A late-written historical event becomes an `earlier` link born closed — March never
becomes the present. A state-changing event must state the change in the same scope and share the subject. Unresolved
disagreement keeps both claims disputed with their sources, and neither wins on recency or weight.

**Fixes the replay forced.** The original rule closed a window on two shared topic cues out of twelve and produced three
false revisions out of five. It is now a count **and** a share (≥2 cues covering ≥1/3 of the older claim's topic), which
takes the replay's closed windows from five to two — both genuine replacements — with the three false ones as regression
tests.

**Evidence.** `tests/memory-revision.spec.ts`, plus the joined read path in `tests/memory-forgetting.spec.ts`. Known
limit: two plain statements that differ without a change or denial signal stay two dated records, both visible, neither
silently winning.
