# LLM 总结模块

[文档目录](README.md) · [系统架构](architecture.md)

单次执行：SourceMessage JSONL → prompt 组装 → 推理 client → 校验 → 本地 SummaryDocument JSON。
不内置采集、调度或推送。输入文件每个非空行必须满足 `src/source-message.mjs`；当前读取整个文件，不默认过滤日期或来源、不去重。调用方应先选好本次批次。按天存储与统一错误处理见 [调度协议](scheduling.md)。

## 调度模块接入

调度模块直接调用 `summarizeFile({ inputPath, client, store })`，成功返回 `{ id, path }`；读取、推理、校验或保存失败时 Promise reject，由调度模块处理失败和重试。

```js
import { DeepSeekClient } from '../src/deepseek-client.mjs';
import { LocalSummaryStore, summarizeFile } from '../src/summary.mjs';

// config 由调度模块加载，可参考 config/summary.example.json。
const client = new DeepSeekClient({
  ...config.client,
  apiKey: process.env.DEEPSEEK_API_KEY
});
const store = new LocalSummaryStore(config.output.directory);
const { id, path } = await summarizeFile({
  inputPath: config.input.path,
  client,
  store
});
// 下游从已归档文档读取内容。
const document = await store.load(id);
```

调度装配入口负责配置和环境变量加载、执行时机及批次选择；总结模块不提供命令行入口。文件路径相对于调度进程工作目录。`config/summary.example.json` 仅为装配配置示例，不由总结模块自动读取。

默认模型依据 [DeepSeek Chat Completions 官方文档](https://api-docs.deepseek.com/api/create-chat-completion/)，支持配置替换；请求使用非流式 JSON 输出。密钥通过构造参数注入，不写入结果。

## 接口与事实来源

- `assembleSummaryPrompt(messages)`：独立版本化 system prompt 与 JSON 素材组装器，完整保留来源字段、顺序和摘要/全文标记。
- `client.complete(messages)`：返回 `{content, provider, model, request_id, usage}`；`DeepSeekClient` 为当前实现，可注入 fetch 或替换 client。
- `SummaryGenerator.generate(messages, input)`：只推理和校验，不读写文件。要求每条输入都有且仅有一条摘要，不接受乱序、漏项、空摘要或非 JSON。
- `summarizeFile({inputPath, client, store})`：组合读取、生成和保存，只有保存成功才返回路径。
- `LocalSummaryStore.save/load`：按 UUID 保存独立文档；完整临时文件通过硬链接原子发布，已存在文件不覆盖。临时文件与结果位于同一目录，要求文件系统支持硬链接。

`SummaryDocument` 是项目契约：`schema_version=1`、`id`、`created_at`、`title`、`prompt_version`、`input`（绝对路径及原始字节 SHA-256）、`inference`（供应商、模型、请求标识、用量）和 `items`。每项包含 `input_index`、纯文本 `summary` 及完整 `source: SourceMessage` 快照，引用与排名由程序复制，不由模型生成。

**已发布的 `data/summaries/YYYY-MM-DD/<id>.json` 是推送和前端内容的唯一事实来源。** 下游通过 store.load(id) 或未来后端查询读取它；推送使用已归档内容转换，不重新总结。当前未接入推送或前端，也未实现查询 API。

输入无效、空批次、网络错误、超时、HTTP 错误、非 stop 完成原因、截断或结构校验失败均抛出错误且不发布新文档；HTTP 错误保留 status/Retry-After 供调用方处理，不自动重试。写入失败不会返回成功；不提供断电持久性保证。

初版一次请求处理整个批次，超出上下文需调用方拆批；不会静默截断输入。prompt 要求不编造、不服从素材指令和不自主排序，但结构校验不等于事实准确性验证。真实 DeepSeek 调用需配置密钥后联调。

素材范围展示：summary-v2 提示词不再要求正文添加“仅依据摘要”；程序依据 SourceMessage.content.completeness 在网页来源旁和推送元信息中标记“基于来源摘要”或“基于全文”。阅读投影兼容清除旧归档开头明确的“仅依据摘要：”等固定前缀，保留正文事实限制且不改写归档。历史原文只有 summary/full 标记的可信度，不代表重新抓取或核验过全文。

## 新流程结构化编辑与 SummaryDocument v2

旧 SummaryGenerator/summarizeFile 继续服务现有已部署入口。新流程通过同一 AIGC 职责中的 `src/editorial.mjs` 生成摘要、scope、事实候选和证据；`src/workflow-handlers.mjs` 负责检查点、存储和期次组装。其模型输入输出与存储完全分开。

事实抽取使用 `facts-v1` 提示词，要求每条输入有且只有一条摘要，原生顺序与排名保留；榜单等非文章 facts 为空。证据使用原文连续片段及位置，不能由中文摘要反推事实；未匹配的证据与条件记录为诊断。详见 [追踪协议](tracking.md)。

SummaryDocument v2 在原条目结构上增加 edition、material、facts、tracking 和 extraction_issues。edition 固定窗口；material 指向稳定身份与内容版本；tracking 冻结当期判断和进展。网页和推送读同一正式文档，不重新总结。历史 v1 文档仍可读，磁盘字节不被改写。

输入哈希相同的成功模型返回先存后用；不完整模型响应、结构错误与批次不匹配仍失败，不能伪装成空摘要。正式期次和业务库索引通过稳定文档 ID 与内容哈希核对恢复。
