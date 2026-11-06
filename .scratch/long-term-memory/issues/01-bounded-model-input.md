# 01: 每次模型输入守住预算

**What to build:** 主会话或 Worker 的历史与工具输出增长时，实际发出的模型请求始终受固定输入预算约束；超大必要材料触发可解释的分步处理或暂停。

**Blocked by:** None (can start immediately)

**Status:** ready-for-agent

**Spec:** [长期记忆规格](https://github.com/NoClickView/dsh-superagent-prototype/blob/f5b6a3270f390a8068413fdb61f6d2757c020a30/.scratch/long-term-memory/spec.md)

- [ ] 先核验并接通 DSH 完整模型请求的发送前边界；仅整理必要的调用入口，复用现有 Runtime 宿主和可记录模型适配器。不得用 system prompt 长度或现有 compaction 的配置代替完整请求验证。
- [ ] 统一计量系统信息、工具定义、当前状态、历史、工具结果和召回材料，并为输出和计量余量预留空间；模型/计量配置不适用时明确拒绝发送。
- [ ] 在工具持续返回大结果、历史持续增长和重试情景中，记录到的每次请求均不超过预算；不静默丢弃现行授权约束。
- [ ] 超大可选内容可缩减或分页；必要输入仍超预算时提供明确的暂停或分步结果，不发送超限请求。
- [ ] 入口支持后续独立后台请求复用同一预算合同，不要求现在实现后台记忆功能。
- [ ] 使用 Runtime 集成测试覆盖主会话与 Worker，维护原有事件路由、权限和执行回归；不做无关会话框架重写。


