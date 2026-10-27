# 项目术语

[文档目录](README.md) · [系统架构](architecture.md)

本文件说明项目约定与第三方术语的区别。项目字段以当前实现为准，第三方含义以文末引用为准。本文不包含真实用户标识或密钥。

## 项目术语

| 术语／字段 | 含义 | 来源 | 用法 | 作用域 |
| --- | --- | --- | --- | --- |
| 消息推送模块（Messaging） | 对外提供主动推送、关联回复和入站处理的业务模块 | 本项目需求与 `src/messaging.mjs` | 上游通过 `push` 或 `reply` 调用 | 本项目消息交互；不执行 AI 推理或任务 |
| 渠道适配器（Channel Adapter） | 封装一种外部渠道协议的模块内部实现 | 通用 Adapter 概念；本项目接口定义 | 当前 `WecomAdapter` 封装企微 SDK | 模块内部；不是独立业务模块 |
| 适配器实例标识（adapter_id） | 配置中某个渠道实例的本地名称 | 本项目配置 | 例如 `wecom-main`；不能当企微 Bot ID | 本项目配置及标准消息 |
| 主动推送（push） | 调用方主动指定目标发送一条消息 | 本项目接口，底层使用企微主动发送能力 [W1] | `push({ target: "personal", ... })` | 使用配置中的目标；不要求收到一条用户消息 |
| 推送目标别名（target） | 调用方引用一个已配置发送地址的名称 | 本项目配置 | `personal` 查找 `push.targets.personal` | 本项目主动推送请求；不是用户身份或权限 |
| 配置中的推送地址（push.targets.<别名>.recipient_id） | 指定主动推送发往哪个渠道地址 | 本项目字段；企微映射见 [W1] | 企微私聊填接收人的 `userid`，群聊填群 `chatid` | 只在 `push` 路径读取；不控制 `reply`，不限制发送者 |
| 入站会话标识（InboundMessage.conversation_id） | 标准化入站消息所属的会话标识 | 本项目字段，由 adapter 从企微消息转换 [W2] | 私聊取该条消息的 `from.userid`，群聊取该条消息的 `chatid` | 随每条消息确定，非固定配置；在 adapter 实例内理解 |
| 发送者标识（sender_id） | 当前入站消息发送者的渠道内标识 | 本项目字段，映射企微 `from.userid` [W2] | 区分谁发来消息；未来可用于权限检查 | 每条入站消息；当前未实现白名单 |
| 关联回复（reply） | 针对某条已收到的消息进行回复 | 本项目接口，底层使用企微回复能力 [W1] | `reply({ reply_token, content, ... })` | 回复原消息所在会话；不读取 `push.targets` |
| 回复关联令牌（reply_token） | adapter 生成的、本次回复上下文的不透明引用 | 本项目 UUID 与内部映射；不是企微原生字段 | adapter 用令牌取回收到的原始帧后调用 `replyStream` | 当前进程、当前 adapter；当前实现保留 60 秒、使用一次即删除，不承诺企微有效期 |
| 入站处理器（handler） | 根据标准消息决定回复内容的可替换逻辑 | 本项目依赖注入约定 | 当前为返回 `todo` 的异步函数；未来可接外部 agent | 不负责决定主动推送目标；当前 StaticTodoHandler 是文档职责名，未定义同名类 |
| 请求追踪标识（request_id） | 标识调用方的一次推送或回复请求 | 本项目字段 | 关联请求与 `DeliveryResult` | 不等于企微 `req_id`，不保证消息去重 |
| 投递结果（DeliveryResult） | 一次发送操作的接受状态 | 本项目接口 | `accepted`、`failed`、`unknown` | 渠道接受不等于用户已读；未知不自动重试 |
| 个人 agent | 未来承接用户消息、生成回复并执行任务的后台能力 | 用户需求；尚未实现 | 通过替换入站 handler 接入 | 消息推送模块之外；不同于企业微信机器人身份 |

主动推送配置使用 `push.targets.<别名>.recipient_id`，入站消息使用 `conversation_id`，分别表达“主动发送给谁”和“消息来自哪个会话”。两者是项目字段，并非企业微信原生字段名；企微私聊时可能映射到同一个 userid 值，但用途独立。旧版顶层 `targets` 和配置中的 `conversation_id` 已迁移，不再作为配置格式支持。

## 企业微信术语

| 术语／字段 | 含义 | 来源 | 用法 | 作用域 |
| --- | --- | --- | --- | --- |
| 智能机器人（Bot） | 企业微信中通过开发接口收发消息的机器人身份 | 企业微信 [W1] | 使用 Bot ID 和 Secret 认证长连接 | 企业微信；不表示后台推理 agent |
| Bot ID／botId／bot_id | 机器人身份标识；名称随配置或协议层而异 | 企业微信协议与 SDK [W1] | 项目环境变量 `WECOM_BOT_ID` 映射到 SDK `botId` | 机器人身份；不是发送目标或本项目 adapter_id |
| Secret | 机器人的认证凭据 | 企业微信与 SDK [W1] | 通过 `WECOM_BOT_SECRET` 提供给 SDK | 认证用途；不是会话地址 |
| userid／from.userid | 企业微信用户标识；`from.userid` 是消息发送者 | 企业微信消息结构与 SDK [W1][W2] | 私聊主动推送使用接收人 userid；入站读取发送者 userid | 企业微信身份上下文；不可假定跨渠道通用 |
| chatid | 需结合所处协议位置解释的企微字段或 SDK 参数名 | 企业微信与 SDK [W1][W2] | `sendMessage(chatid, body)` 参数：私聊可填 userid、群聊填群 chatid；入站 `body.chatid` 为群聊标识 | SDK 发送参数与入站群聊字段不能简单等同 |
| chattype | 区分单聊和群聊的入站类型 | 企业微信消息结构 [W2] | `single` 或 `group`，用于入站标识转换 | 原始企微消息；不表示访问权限 |
| req_id | 企微帧头的请求关联标识 | 企业微信与 SDK [W1] | 回复接口透传原消息帧头中的值 | SDK 与 adapter 内部；不是用户／会话 ID |
| msgid | 企微消息标识 | 企业微信消息结构 [W2] | 映射本项目 `message_id` | 标识消息，不标识用户或目标 |

## 两条发送路径

```text
主动推送：
push(target="personal")
  -> push.targets.personal.recipient_id
  -> adapter.send(配置中的地址)
  -> SDK.sendMessage(配置中的地址, 正文)

关联回复：
收到用户 B 的消息帧
  -> 为该帧生成 reply_token_B
  -> handler 返回 todo
  -> reply(reply_token_B)
  -> adapter 取回 B 的原始消息帧
  -> SDK.replyStream(B 的原始消息帧, 正文)
```

假设配置的 personal 指向用户 A：主动推送 personal 发给 A；A 私聊得到 A 会话中的回复；B 私聊得到 B 会话中的回复。B 的消息不会因为 personal 指向 A 而被回复到 A。

这是因为当前 `Messaging.push` 读取 `this.pushTargets`，而 `Messaging.reply` 只使用 `reply_token`。标识值配置为 A 的 userid 不等于所有发送操作都使用该值。当前没有发送者白名单。

## 来源与核对位置

- 项目事实：[`src/messaging.mjs`](../src/messaging.mjs)、[`src/run.mjs`](../src/run.mjs)、[`config/messaging.example.json`](../config/messaging.example.json)。
- [W1] [企业微信 Node SDK：接口及协议说明](https://github.com/WecomTeam/aibot-node-sdk)。重点：`sendMessage`、`replyStream`、`WsFrame`。
- [W2] [企业微信 SDK 消息结构](https://github.com/WecomTeam/aibot-node-sdk#basemessage消息体基础结构)。入站字段也见 SDK README 的 `BaseMessage`。
- [SDK 实际调用实现](https://github.com/WecomTeam/aibot-node-sdk/blob/main/src/client.ts)：`reply` 取原帧 `headers.req_id`，`sendMessage` 在新发送请求中填入目标 `chatid`。

第三方资料核对日期：2026-10-23。新增字段时同步补充含义、来源、用法和作用域，明确项目字段与第三方字段的映射。

## 订阅采集术语（项目契约）

| 术语 | 含义 | 来源 | 用法 | 作用域 |
| --- | --- | --- | --- | --- |
| Subscriptions | 来源及采集策略配置 | 本项目 | 生成执行请求，推荐时间仅作元数据 | 不执行、不保存、不调度 |
| CollectionExecutor | 单次采集执行器 | 本项目 | 调用来源适配器，返回消息和执行结果 | 不运行 agent loop，不保存 |
| SourceMessage | 统一采集消息 v1 | 本项目，见 [订阅协议](subscriptions.md) | 适配器输出、后续 AIGC 与存储输入 | 不等于企微 InboundMessage |
| source_id | 本地配置的来源标识 | 本项目 | 识别订阅配置，如 rqdmap | 不等于第三方原生条目 ID |
| source_item_id | 来源原生条目标识 | 第三方值映射到项目字段 | 追溯原始条目 | 暂不去重 |
| source_signals | 来源提供的排名、热度等信息 | 第三方信号映射到项目字段 | 保留原始重要性信息 | 不新增 AI 评分 |
| JsonlMessageStore | 临时后端保存实现 | 本项目 | save(messages)，逐行追加统一消息 | 独立于策略与执行器 |

## 总结模块术语

| 术语 | 含义与来源 | 用法与作用域 |
| --- | --- | --- |
| SourceMessage | 项目采集消息契约，`src/source-message.mjs` 定义 | JSONL 输入；保存来源、正文、排名和时间 |
| SummaryDocument | 项目生成内容契约，见 [总结协议](summary.md) | 本地归档；推送和前端内容唯一事实来源 |
| prompt_version | 项目 prompt 版本 | 随结果归档，定位组装规则 |
| input_index | 项目批次内位置，从零开始 | 保证重复 ID 的消息也可逐项追溯；不是来源排名 |
| DeepSeek Chat Completions | DeepSeek 第三方推理接口 | 由 client 封装，业务层仅依赖 complete 接口 |

## 事件与期次术语

Article、ArticleRevision、Fact、Story、ObservationSnapshot、Evidence、日报窗口与已编入期次的定义统一见根目录 [CONTEXT.md](../CONTEXT.md)。Fact 是报道中的具体发生或待核对主张，不是已验证真理。窗口决定通常覆盖范围；迟到补收、初次存量与重复抓取是三种不同情况。

模型输出的关系经过原文引用校验与必要复核；原文匹配不证明主张真实。来源独立性未知时必须保留未知，不把不同域名或转载数量当成独立证据。
