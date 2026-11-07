# 03: 用实际权限保证外部只读

**What to build:** 在声明支持的部署环境里，实验体及其他消费者能够读取已发布记忆，但即使通过文件或 shell 工具，也不能绕过记忆服务修改权威记录。

**Blocked by:** 02 — 经历写入后可跨重启召回

**Status:** resolved
**Spec:** [长期记忆规格](https://github.com/NoClickView/dsh-superagent-prototype/blob/f5b6a3270f390a8068413fdb61f6d2757c020a30/.scratch/long-term-memory/spec.md)

- [x] 基于实际部署支持的账户、进程或沙箱边界分离唯一写入者与读者权限；不能仅依赖模块封装、提示词或文件约定。
- [x] 贯通部署配置、启动检查、正常事件写入、读取和拒绝绕过写入的可见结果；不扩展其他工作区权限。
- [x] 用受限进程或账户验证直接写入、替换和删除权威记录失败，正常通过服务上报事件仍成功。
- [x] 检查适用环境下目录继承、可写父目录及链接绕过等实际边界；记录验证过的部署条件，不声称已有跨平台保证。
- [x] 无法建立所需隔离时拒绝启用长期记忆写入，并在现有运行状态渠道说明原因。
- [x] 测试仅断言文件保持完整、服务结果和权限拒绝，不锁定内部类或调用次数。

## Answer

Resolved on `integration/long-term-memory` (ticket merge `0a52934`). **Read the boundary note: bullet 1 is not satisfied
as an enforced separation on this deployment, and the ticket's own bullets 4 and 5 are what ship.**

**What was measured.** Both roles run as the operator's OS account, `Sessions.ensure` sets `danger-full-access`, no DSH
sandbox service is mounted, and a Windows child process inherits its parent's token — so no filesystem permission can make
the memory writer stronger than an agent's shell. That is a property of the deployment, not of this code, and it is
recorded rather than papered over.

**What was verified.** With a real ACL deny (`icacls <memory dir> /deny <account>:(OI)(CI)(W)`), a second process fails
every write, rename and delete on the authoritative files with `EPERM`, while the memory service still publishes (it keeps
an open handle). Inheritance, a writable parent directory and junction/symlink bypass are probed as gates, and the verified
conditions are recorded in `docs/006` with no cross-platform claim.

**What ships.** `src/infra/isolation.ts` probes four gates; `src/app/setup.ts` runs it at startup; `memoryWriteMode`
defaults to `require`, which **refuses every memory write** when no boundary is proven and says which condition failed on
the existing `memory-store` health entry, with the capture left queued in SQLite and reads unaffected.
`memoryWriteMode: 'waive'` is the one explicit operator setting that runs the degraded path, and every health report then
states that the boundary is unproven. The default is not flipped.

**Evidence.** `tests/memory-isolation.spec.ts`: the probe's gates, the write gate on every commit path, a real second
process refused under an ACL deny, the runtime refusing a capture with the reason and later publishing it once an operator
waives, and an end-to-end demonstration running in that documented configuration.
