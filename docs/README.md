# 文档目录

| 文档 | 内容 | 阅读用途 |
| --- | --- | --- |
| [系统架构与模块依赖](architecture.md) | 模块职责、依赖方向、日报数据流、消息模块内部关系及实现状态 | 了解整体结构与独立开发范围 |
| [项目术语](terminology.md) | 术语含义、来源、用法与作用域，区分项目和企业微信字段 | 确认讨论及接口中的准确含义 |
| [订阅与采集协议](subscriptions.md) | 来源、统一消息、执行与 JSONL 保存边界 | 开发和调用采集模块 |
| [消息推送模块协议](messaging.md) | push／reply／入站消息契约、配置和启动说明 | 实现、接入及联调消息模块 |

| [LLM 总结模块](summary.md) | prompt、DeepSeek client、JSONL 输入与本地事实文档 | 开发与运行总结模块 |

[调度与错误协议](scheduling.md)：计划时间、统一错误栈、按天存储、执行契约和架构选型。

建议阅读顺序：架构 → 术语 → 具体模块协议。架构中的规划内容不代表已经实现；当前消息推送、订阅采集和临时 JSONL 保存已有最小实现。

配置示例见 [`config/messaging.example.json`](../config/messaging.example.json)，凭据模板见 [`.env.example`](../.env.example)。真实凭据与个人接收目标保存在被 Git 忽略的本地配置中，文档不复制这些值。

新增文档时在本目录添加链接；模块依赖变化同步更新架构，术语和字段语义变化同步更新术语文档。

[本地部署记录](deployment.md)：服务状态、正式起始时间及真实验收结果。

[只读前端](frontend.md)：SummaryDocument 唯一事实源、纯视图与应用统一启停。

[事件追踪协议](tracking.md)：结构化事实、相似度、关系复核、来源证据与可恢复处理。

[领域术语](../CONTEXT.md)：Article/Fact/Story、观测快照、期次窗口与发送状态的定义。

新流程配置示例为 `config/workflow.example.json`，入口为 `src/workflow-cli.mjs`。它已提供开发实现，尚未替换已部署定时服务；切换步骤见部署记录。

[本轮开发验证](verification-20261027.md)：离线测试、浏览器验收、窗口回放及未验证范围。
