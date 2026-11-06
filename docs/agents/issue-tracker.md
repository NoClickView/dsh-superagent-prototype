# Issue tracker: Local Markdown

本项目使用本地 Markdown 追踪规格与规划议题，发布到 [NoClickView/dsh-superagent-prototype](https://github.com/NoClickView/dsh-superagent-prototype)。上游为 deepseek-ai/dsh-superagent-prototype；本项目规格不发布到上游议题区。

## Specifications

- 规格位于 `.scratch/<feature>/spec.md`，每项功能单独保存。
- 文档顶部记录 Status 和 Labels，使用 [triage label vocabulary](triage-labels.md)。可实施规格标记为 `ready-for-agent`。
- “发布到议题追踪”表示将规格及必要支持文档提交到本项目 fork；无需创建重复的 GitHub Issue 正文。
- 规格链接必须在远端可解析，讨论过程与本机交接记录不作为公开规格的依赖。

## Wayfinding operations

- Map: `.scratch/<effort>/map.md`，标签 `wayfinder:map`；只存目标、约束、已决索引、迷雾与范围边界。
- Child: `.scratch/<effort>/issues/NN-<slug>.md`；文件路径是身份，标题是展示名称，`Parent` 链接地图。
- Metadata: `Type` 为 research/prototype/grilling/task，`Labels` 为对应 wayfinder 标签，`Mode` 为 AFK/HITL。
- Status: open / claimed / resolved；`Assignee: unassigned` 表示未领取。
- Blocking: `Blocked by: NN, NN` 引用同目录编号，`none` 表示无阻塞。本追踪方式没有原生依赖关系，使用此字段。
- Frontier: 按编号扫描 open 且 unassigned 的子票，只取所有阻塞票均 resolved 的票。领取前重读状态，保存 Status: claimed 与本会话的 Assignee 后再开展工作。
- Resolution: 在票尾追加 `## Answer` 记录结论及资产链接，设 Status: resolved；地图 Decisions so far 只添加标题链接与一句摘要。讨论追加在 `## Comments`。
- Charting: 建图轮次只建立问题与依赖；除 research 外不结案。HITL 票由用户实际参与讨论后解决。

创建所有子票后再写阻塞边；修改或结案时核对依赖仍指向存在的票。新问题能明确表达时建票，否则留在地图 Not yet specified。

