# 消息推送模块协议草案 v0.1

[文档目录](README.md) · [系统架构](architecture.md)

状态：接口草案，已提供 Node.js 最小实现；调度适配器的认证等待、文本分块和逐块回执见 [调度协议](scheduling.md)。完整应用启动：npm start；独立企微入站调试：npm run messaging:start。启动器读取 .env 和 config/message.json。

术语定义、来源及作用域见 [项目术语](terminology.md)。

## 范围

唯一业务模块是消息推送模块。渠道 adapter、入站 handler 是模块内部的替换接口。
负责主动推送、接收用户消息、关联回复、连接生命周期和渠道协议转换。
不负责采集、AIGC、定时调度、agent 推理和任务执行、日报存储、前端。
当前 adapter 为企业微信智能机器人 WebSocket 长连接；未来公众号、小程序按各自实际能力接入。

## 调用关系

上游 -> Messaging.push -> ChannelAdapter.send -> 企业微信
企业微信 -> ChannelAdapter -> InboundHandler.handle -> Messaging.reply -> ChannelAdapter.reply

当前 StaticTodoHandler 对每条有效用户消息返回正文 todo。
连接、认证、心跳、进入会话等系统事件不进入此 handler。
未来 AgentHandler 替换 StaticTodoHandler，在模块外完成推理和任务执行。

## 逻辑接口（不限定语言或 HTTP 部署）

- push(PushRequest) -> DeliveryResult：主动推送。
- reply(ReplyRequest) -> DeliveryResult：关联某次入站消息回复。
- InboundHandler.handle(InboundMessage) -> ReplyContent | None：可异步；None 允许后台自行处理。
- ChannelAdapter：start(on_message)、stop()、send(target, content)、reply(reply_token, content)。

初期正文只支持 text。企微主动推送若采用 Markdown 承载，由 adapter 转义为字面文本。
不向上游暴露 SDK 帧、req_id、企微专属字段或密钥。

### 数据契约

PushRequest:
- request_id: 调用方生成的追踪标识；不承诺去重。
- target: 配置中的目标别名，例如 personal。
- content: { type: "text", text: string }。

ReplyRequest:
- request_id: 追踪标识。
- reply_token: 入站消息携带的不透明关联令牌。
- content: 与 PushRequest 相同。

InboundMessage:
- message_id: 渠道消息标识。
- adapter_id: adapter 实例标识。
- conversation_id: 当前入站消息的会话标识；企微私聊取该消息的 from.userid，群聊取 chatid。不决定主动推送接收目标。
- sender_id: 渠道内发送者标识。
- kind: text | image | voice | file | mixed | unknown。
- text: string | null；初期不下载附件。
- received_at: 接收时间。
- reply_token: 不透明关联令牌，仅 adapter 解读；不承诺跨重启或长期有效。

DeliveryResult:
- request_id: 原请求追踪标识。
- status: accepted | failed | unknown。
- error_code: 可选的稳定错误码，例如 INVALID_TARGET、NOT_READY、UNSUPPORTED_CONTENT、PROVIDER_REJECTED、OUTCOME_UNKNOWN。
- provider_reference: 可选的渠道回执引用。

accepted 仅表示渠道确认接受，不代表用户已读。
unknown 表示无法确认是否接受，初期不自动重发，避免重复推送。
回复令牌过期或渠道不支持该能力时明确失败，不静默改成主动推送。
以上只定义契约；重试、持久化和完整错误策略后续讨论。

## 配置

复制 config/messaging.example.json 为 config/message.json。
复制 .env.example 为 .env，填写 Bot ID 和 Secret；启动器通过 Node.js --env-file 显式加载 .env。
credentials 中 *_env 的值是环境变量名称，不是凭据本身。
填写 push.targets.personal.recipient_id，或后续通过入站事件获取并由用户确认目标。
配置中的 push.targets 仅用于主动推送，recipient_id 是渠道接收目标标识，不参与关联回复或发送者权限检查。关联回复通过入站消息的 reply_token 回到原会话。当前所有有效用户消息均回复 todo，未设置发送者白名单。
不自动把最新发消息的人设置为推送目标。
凭据为空时不能建立真实连接；目标为空时不能主动推送，两项分别校验。
入站静态回复不依赖预设主动推送目标。

未来增加渠道时，目标仍以别名暴露，渠道标识和会话标识只在配置与 adapter 内使用。
公众号、小程序是否支持主动推送、关联回复及其时限，接入时分别核实；不承诺各渠道能力完全相同。

## 独立验收范围

后续实现需验证：配置校验；指定目标主动推送；各类用户消息回复 todo；系统事件不回复；可替换 handler；上游无需依赖企微 SDK。
连接认证后输出 AUTHENTICATED；再向企微机器人发消息，终端输出 INBOUND_TARGET 和回复状态。将私聊输出的 conversation_id 值填入 push.targets.personal.recipient_id；程序不会自动修改目标。

## 参考

- https://github.com/WecomTeam/aibot-node-sdk ：认证、消息事件、主动发送与关联回复。
