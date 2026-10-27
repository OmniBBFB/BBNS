# 消息源订阅与采集

[文档目录](README.md) · [架构](architecture.md) · [术语](terminology.md)

按天存储与统一错误处理见 [调度协议](scheduling.md)。采集 CLI 新产物为 data/subscriptions/YYYY-MM-DD/<run_id>.jsonl，旧平铺文件不自动迁移。

首版支持 AIHOT 精选资讯、rqdmap 博客 RSS 和 GitHub Trending 每日榜单。财经和个人脚本适配器暂未实现；不依赖 AI、推送或 agent loop，不包含定时器和去重。

## 职责与调用

- `Subscriptions`：管理来源与策略，`list()` 返回完整配置，`requests(sourceIds?)` 返回启用来源的执行请求。推荐采集时间仅是元数据，不过滤请求，不触发任务。
- `CollectionExecutor.execute(requests)`：执行一次并返回消息和逐来源状态，不导入存储。适配器通过 `collect(request, { fetched_at })` 注入，可独立替换。
- `DailyMessageStore.save(messages, {businessDate, runId})`：当前 CLI 使用的按天不可变批次存储，重复内容仍保存；`JsonlMessageStore` 保留作旧接口兼容。
- `src/collect.mjs`：独立 CLI 装配入口，读取策略、执行、调用存储；未来调度模块或 agent 可直接调用同样的接口。

```js
const requests = subscriptions.requests(['aihot', 'rqdmap']);
const run = await executor.execute(requests);
await store.save(run.messages);
```

调用方负责触发时间与是否重试。执行器逐来源执行，单源失败不阻断其他来源；失败来源不返回部分消息。没有自动重试、轮询、游标持久化、ETag 增量同步或日期过滤。推荐时间与 HTTP 缓存、Retry-After 信息均供外部调度参考。

## 配置和运行

```sh
npm install
npm run collect
npm run collect -- config/subscriptions.example.json rqdmap
```

默认读取 `config/subscriptions.example.json`，可另存为被忽略的 `config/subscriptions.local.json` 后显式传入。存储路径相对进程工作目录；默认目录 `data/subscriptions`，按日保存不可变批次。任何来源失败退出码为 1，但成功来源仍保存；配置或存储失败同样退出码为 1。

每个来源包含 `id`、`adapter`、`enabled`、`limit`（1..1000）、`options`、可选 `recommended_collection`。指定未知来源报错；指定禁用来源不会执行。

| adapter | options | 行为 |
| --- | --- | --- |
| `aihot` | `mode`（selected/all）、`window`（24h/7d）、可选 category | 使用 items API 按返回游标分页，到来源结束或 limit；不跨批次保存游标 |
| `rss` | `url` | RSS 2.0；默认读取 description 摘要，有 content:encoded 则标记全文；转换为纯文本，不补抓详情页 |
| `github_trending` | 可选 language（GitHub URL 中的语言名称） | 获取 since=daily 榜单快照，保留顺序；页面结构不匹配时显式失败 |

limit 是单次条数上限，不是去重或时间策略。结果的 `truncated` 表示仍有条目被上限截断；RSS 不承诺完整历史，GitHub 只返回网站当前榜单。AIHOT 时间窗由来源定义。

## SourceMessage v1

所有来源共用以下内部字段；JSONL 每行直接保存该对象。

| 字段 | 类型与语义 |
| --- | --- |
| schema_version | 固定为 1 |
| id | 本次获取生成的 UUID，重复获取也生成新 ID，不是去重键 |
| source_id | 配置中的来源标识 |
| source_item_id | 来源原生条目标识或 null，仅用于追溯 |
| kind | article / ranking_entry；预留 observation / alert |
| title | 非空标题 |
| url | 原始 HTTP(S) 链接或 null |
| published_at | 来源发布时间，未知为 null |
| observed_at | 榜单、行情等观测时间，文章为 null |
| fetched_at | 本次来源执行开始时间 |
| content | text、format（text/html/markdown）、completeness（summary/full）；当前适配器输出纯文本 |
| source_signals | 来源原生排名、分数、推荐理由等；不自行评分或排序 |
| data | 来源特有结构与溯源信息，AIHOT 包含 attribution、链接和 discovered_at；GitHub 包含 period、语言和 stars |

时间统一为带时区的 ISO 8601 字符串，未知为 null。SourceMessage 是本项目采集契约，与企业微信 InboundMessage 分属不同职责。

`execute` 返回 `run_id`、started_at、finished_at、messages、results。每个来源结果包含 source_id、status（succeeded/failed）、count、时间；成功包含 truncated 与 metadata（缓存提示），失败包含 error（message、http_status、retry_after）。这些运行信息打印到 CLI，不混入消息，也尚未持久化。

## 存储边界

JSONL 实现支持同一实例内并发保存串行追加，不保证多进程并发或整批事务。若写入中断，可能产生部分记录；暂不自动重试或修复。未来后端替换 `save(messages)` 即可，执行器不用改变。

## 验证与外部接口

`npm test` 使用固定样本验证 RSS、AIHOT 分页、GitHub 排名解析、错误隔离和重复追加，并运行已有消息推送测试。真实来源可用上述 CLI 手动验收，网络测试不作为单元测试依赖。

- [AIHOT OpenAPI](https://aihot.news/openapi-v1.json)：items、分页、缓存及使用说明。
- [博客 RSS](https://www.rqdmap.top/index.xml)：实际包含摘要。
- [GitHub Trending](https://github.com/trending)：HTML 结构可能变化，需要维护适配器。

## 本次真实验收（2026-10-23）

三个来源累计落盘并通过统一消息校验：AIHOT 18 条、博客 100 条（达到 limit，truncated=true）、GitHub Trending 9 条，共 127 条。GitHub 首次连接失败，人工单源重试成功；执行器没有自动重试。验收数据保存在被忽略的 data/subscriptions/messages.jsonl。

## 新流程 v2 的身份与时间

CollectionExecutor 仍只采集一次，不存储、不筛选期次。RSS 在 `data.source_time` 保存原始发布时间、更新时间及解释所用时区偏移，在 `data.source_updated_at` 保存可解析的更新时间。`options.utc_offset` 缺省 +08:00，无时区的明确日期按该值解释；未知表达保留为 null。CST 按信源偏移解释，不依赖运行机器时区。

稳定文章身份和版本位于 ContentStore：来源原生 ID 优先，URL 次之，缺失稳定键不按标题猜测。SourceMessage UUID 继续只追踪单次抓取。每日榜单按当地观测日建立独立身份，并保留原生排名。

日报窗口、迟到补收和初次存量基线属于新流程 prepare 适配层与存储协作，不进入来源 Adapter。原采集 CLI 和旧自动入口行为仍按各自协议，直到部署切换。
