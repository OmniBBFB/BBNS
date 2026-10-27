# 调度与错误处理协议 v1

状态：统一错误边界、按天存储、持久调度引擎、SQLite 账本、任务适配器及本地 systemd 部署工具已实现。实际安装与运行结果以本地 systemd 状态和验收记录为准。

## 职责

调度器只处理时间、依赖、执行状态和不透明产物引用，不解析 SourceMessage、SummaryDocument 或渠道数据。
任务适配层装配单次采集、总结、存储和推送；文档到文本转换属于推送任务适配层。
主模块没有新增调度依赖或隐藏重试。外部依赖/存储边界分类异常，保留原异常和原因；成功返回的数据契约不变，投递结果仅增加 error 字段。

## 计划

默认时区 Asia/Shanghai。每个启用来源优先采用 recommended_collection.time（HH:mm）和 timezone，没有 time 时每天 08:00。note 是人工说明，不解析为时间。目前示例配置均没有明确时间，所以全部回退 08:00。
src/scheduling.mjs 的 dailyPlans 是纯函数，只生成计划，不自动执行。
总结每天 08:00 起具备执行资格，等待同期采集任务成功；推送每天 09:15 起具备资格，等待同期归档。若推荐采集晚于 08:00，总结等待；晚于 09:15 则当天准时推送无法满足，必须报告依赖未就绪，不能取昨天文档冒充。
首版仅处理当天、单任务串行、不自动跨日补发；默认所有来源成功才总结。推送截止时间通过 push_lateness_minutes 配置；partial 策略尚未开放。

## 执行协议

handler.execute({run_id, occurrence_id, business_date, scheduled_at, attempt, input_refs, config_ref, signal})
返回 {status, output_refs, error}；status 是 succeeded / partial / failed / unknown。
business_date 按工作流时区从计划期次确定，重试跨午夜仍保持不变。run_id 标识执行实例，attempt 标识尝试；occurrence_id 标识计划期次。各来源与总结/推送通过同一个工作流期次关联，不能用不同日期的最近成功结果满足依赖。
output_refs 是 {kind, id?, path?, business_date} 的引用列表，调度器只保存，不解析正文。来源与投递回执细节由适配层保存为独立诊断产物。

## 错误栈与唯一重试所有者

1. 依赖适配器：识别网络、HTTP、超时及响应格式错误，释放资源，失败抛出带 fault 的原异常。
2. 模块边界：隔离单源失败；校验失败不发布总结；存储使用完整文件原子发布。失败不能伪装成空成功。
3. 执行层：统一使用 errors.mjs 的 retryDecision 计算下一次尝试；该工具不 sleep、不自动调用模块。
4. 调度账本：保存 attempt、next_attempt_at、deadline、产物和错误；重启后恢复。告警订阅状态事件，不修改核心流程。

fault/error 字段：
schema_version=1、code、category、operation、retryable、outcome、message、http_status、retry_after_ms。
category：validation / network / timeout / dependency / storage / cancelled / internal。
outcome：not_completed / unknown。not_completed 不表示远端没有产生计费等副作用，只表示本地任务没有确认完成。
抛出的异常保留 name、原生 code（如 EEXIST）、cause、http_status 和 retry_after；协议错误码位于 error.fault.code。
CollectionExecutor 的 results[].error 直接包含协议字段，并保留 retry_after。Messaging 的失败/未知结果增加 error，保留原有 error_code。
错误是内部诊断数据，未经脱敏不能直接返回前端；不可记录请求正文、认证头或密钥。默认日志只记录 code/operation/追踪标识。

| 类型 | 自动重试 |
| --- | --- |
| 网络失败、超时、HTTP 408/429/5xx | 允许执行层有限重试；按操作的副作用进一步收紧 |
| 无效输入、无效模型输出、响应结构变化、401/403 | 不自动重试，修复输入/配置或适配器 |
| ENOSPC/EACCES/EIO、同名产物 EEXIST | 不盲目重试；存储恢复/核验后人工处理 |
| 用户取消 | 不重试 |
| 推送已调用渠道后异常、缺失有效回执、unknown | 不自动重发，等待核对 |
| 推送前 NOT_READY | 可有限重试，不视为已发送 |

建议默认最多 3 次尝试（含首次），指数退避加抖动；Retry-After 支持秒和 HTTP 日期，是最短等待值，不被退避上限截短。超过截止时间或次数直接失败。
禁止模块内部循环重试后再被调度器重复重试。取消必须传播给外部 I/O；仅 Promise.race 不能证明操作停止。采集执行器、来源 HTTP 请求、总结与推理请求已支持外部 signal；自定义适配器须遵守取消约定。文件原子发布阶段不强制中断，企微 SDK 发送仍需按结果未知处理，不能因此重入仍在运行的任务。
单源失败仅重试失败来源；成功来源引用复用。默认总结等待所有来源成功，partial 策略由工作流显式配置。
模型请求重试可能重复计费；不承诺第三方调用恰好一次。推送 accepted 仅指渠道接受。

## 本地按天存储

采集：data/subscriptions/YYYY-MM-DD/<run_id>.jsonl
总结：data/summaries/YYYY-MM-DD/<document_id>.json
执行账本：data/scheduler/state.sqlite；不复制业务正文。

DailyMessageStore 保存单次不可变批次，不追加到共享历史文件；同名拒绝覆盖，重复内容仍保存，不新增业务去重。
LocalSummaryStore 支持构造时指定 businessDate；未指定时按 created_at 的 Asia/Shanghai 日期保存。load(id, {businessDate}) 可直接定位；兼容 load(id) 扫描日期目录和旧平铺文件，重复 ID 显式报错。
CLI 采集按执行开始时间固定归属日，重试引擎应传计划的 business_date。总结适配层将当日期次明确传入 store。
历史平铺文件不自动迁移。旧 JsonlMessageStore 继续作为兼容接口存在，但新的 collect CLI 使用 DailyMessageStore。
存储布局不改变 SourceMessage / SummaryDocument 正文；采集数据按批次输入总结，不能把整个历史根目录视作一次输入。多来源合并快照由任务适配层完成，顺序固定，完成后原子发布。

## Event bus 与调度选型

可使用 event bus，但推荐“持久化编排 + 显式任务调用 + 事件通知”。事件适用于 task.succeeded/task.failed 等观察与后续非关键订阅。
内存 EventEmitter 没有持久化、确认、重放和跨重启恢复；异步监听器也不构成可靠工作流。关键链路不能只靠 emit 串联。
若将关键任务改为事件驱动，需要持久 broker、outbox、consumer inbox、重复消费处理、重试与死信；这比当前三阶段单机流程复杂。
SQLite 执行状态和待发布事件应在同一事务写入；未来有可靠投递需求再加入 outbox 发布器。事件仅携带引用和状态，不携带正文。

推荐单机 Node.js ESM + systemd timer（分钟级 tick）+ SQLite 状态账本。systemd 负责唤醒，SQLite 负责去重领取与恢复，业务时间计划留在项目内，不为每个来源生成操作系统 timer。
Persistent=true 只能补唤醒，不负责重放所有历史任务；调度器根据账本和当天策略处理。
SQLite 保存运行状态需原子领取、唯一期次约束、超时/运行中恢复；不能把推送中断简单改为待重试，应标 unknown。
systemd 同一 service 活跃期间不会重启同服务；任务启动后仍需账本防止手动入口或其他进程重复执行。
现有企微通过长连接认证，推送适配层必须等 ready；当前 start() 不等于已认证，不能刚 connect 就发送。
引擎、任务适配器、连接等待及持久账本已实现；部署工具可安装和启用用户级系统服务。

来源：[systemd.timer](https://www.freedesktop.org/software/systemd/man/latest/systemd.timer.html)、[Node.js events](https://nodejs.org/api/events.html)、[SQLite transactions](https://www.sqlite.org/lang_transaction.html)。

## 本地运行与部署

已实现：Scheduler 通用引擎、SchedulerLedger SQLite 账本、采集/总结/推送任务适配器、只观察的状态事件、CLI 和 systemd 用户 timer。业务数据只在任务适配层解析，SQLite 不保存正文。

要求 Linux、Node.js >=22.13；本机验收版本 v22.22.1，使用内置 node:sqlite，无新增 npm 依赖。该 Node 版本仍将 SQLite 标记为 experimental，部署测试覆盖实际运行版本。
本地配置从 config/scheduler.local.json 读取；示例 config/scheduler.example.json。默认装配 config/subscriptions.example.json、config/summary.json、config/message.json，凭据仅从 .env 注入。
summary_config 的 client 用于推理；scheduler 中的 collection_directory/summary_directory/delivery_directory 决定存储路径，旧 summary 配置的单文件 input/output 不参与周期任务。

```sh
npm test
npm run scheduler:install
npm run scheduler:check
npm run scheduler:plan
npm run scheduler:status
systemctl --user status bbns-scheduler.timer
journalctl --user -u bbns-scheduler.service -n 50 --no-pager
```

安装工具首次创建权限 0600 的本地配置，从下一业务日开始，避免安装当天自动补发；已有配置不覆盖。安装包含当前用户 enable-linger，确保登出后和开机时用户服务仍运行；不修改系统级服务。
timer 每分钟唤醒，OnCalendar 对齐分钟，AccuracySec=1s；业务时间仍由调度器按时区判断。
服务首次运行会检查本地配置并初始化账本；start_date 之前不执行外部任务。安装器会校验 unit、启用 timer，并启动一次 service 验证入口。
可通过 config/scheduler.local.json 修改来源配置路径、存储根目录、起始业务日和推送目标别名。

```sh
# 指定日期查看计划和执行记录
node --env-file=.env src/scheduler-cli.mjs plan config/scheduler.local.json 2026-10-24
node --env-file=.env src/scheduler-cli.mjs status config/scheduler.local.json 2026-10-24
# 停用；数据保留
systemctl --user disable --now bbns-scheduler.timer
systemctl --user stop bbns-scheduler.service
```

### 恢复、期限与投递行为

SQLite 对每个 business_date/task_id 使用唯一约束，计划快照在首次创建期次时固化；当天已创建的任务不会被新配置静默改写。采集/推理配置由适配层从本地读取，业务日关联与执行时间由账本固化。
全局执行锁记录 Linux boot_id、PID 和进程启动时间，存活进程不被基于时间的租约强行抢占；检测到旧进程确实退出后才恢复。只支持本机，不支持共享文件系统多机调度。
状态：pending / running / retry_wait / succeeded / partial / failed / blocked / unknown / expired。
失败依赖会阻断下游；只用同一天成功产物。重试时间持久化，最多 3 次尝试。正常 SIGTERM 的合作式取消保存为可恢复尝试，仍受次数和截止时间限制。
采集与总结截止到工作流当日结束。推送默认最晚 10:15（09:15 后 60 分钟，可配置 push_lateness_minutes），到期不发送；不跨日补发、不自动重试 unknown。
计划按分钟精度运行，系统负载和网络会影响实际完成时间；不承诺秒级投递。

采集批次文件由稳定 run_id 命名，完整产物存在则复用。
总结按 summary_batch_size（默认20条）拆批，每批结果保存到 data/summaries/YYYY-MM-DD/.batches/<run_id>/，失败后不重做已保存批次；最终发布一个完整 SummaryDocument，输入顺序和逐条来源快照保留。多批推理信息记录在 inference.batches。
合并输入快照保存在 data/subscriptions/YYYY-MM-DD/<summary_run_id>-input.jsonl。
推送只读取已归档文档，按 Unicode 字符安全拆成有限字节的文本块，顺序发送，默认块间隔3秒（push_interval_ms 可配置）。channels 的真正限额以提供方响应为准，不承诺无限条数和无限吞吐。
data/deliveries/YYYY-MM-DD/<run_id>/ 保存文本哈希清单、发送前意图和逐块回执；没有接受回执的发送意图不会被重放。中断可能导致少发，需要核对；不会为了补齐而自动重复发送。
当前 SDK 对非零 errcode 可能抛回执对象，Messaging 将其识别为明确失败；无回执的网络异常保持 unknown。
推送任务认证后才发送，结束即关闭连接；同一 Bot 若已有独立长连接进程，需停用其中一个或使用不同 Bot，避免渠道连接互斥。调度推送时保留配置的入站 handler，非推送时段不维持入站服务。

### 验收

npm test 使用 SQLite、子进程中断和替身模型/渠道验证，不发送真实消息。
tools/verify-local.mjs 提供额外真实验收：每个来源最多1条、真实模型总结并按天落盘、企微只认证不发送；失败仅输出协议错误码。执行：
```sh
node --env-file=.env tools/verify-local.mjs
```
该命令会产生少量模型用量。生产首次定时推送是否被渠道实际接受，以 SQLite 任务结果及 delivery 回执为准，认证成功不等于主动投递成功。

## 手动触发

npm run scheduler:manual 创建独立 manual:<id>: 任务命名空间，沿用 SQLite 执行协议与生产任务适配器，立即执行当日采集、总结和真实推送，不修改自动任务的 start_date、时间与配置。
本入口的采集适配层按工作流时区筛选文章 published_at 和榜单 observed_at；历史及未知日期条目不参与当日总结，原始采集和筛选统计仍留档。定时采集原有策略不因此改变。
执行清单及结果位于 data/scheduler/manual/YYYY-MM-DD/，可通过 --resume <清单路径> 恢复同日执行。
Scheduler 只执行当前注册计划的 task_id；所有入口共享同一进程身份锁，避免手动和自动入口相互执行或并发发送。

## 应用统一启停补充

页面接入后，使用 npm start / npm stop / npm restart 管理 bbns.target；页面与调度 timer 同时启停。旧 timer 独立开机入口已移除，调度时间与账本保留。详见 [只读前端](frontend.md)。

## 日报筛选与来源诊断（2026-10-26）

自动和手动日报均使用 todayCollectionHandler：保留原始采集批次，按业务日筛选文章 published_at、榜单 observed_at，排除无日期条目。在选中条目内，按 source_id、source_item_id（缺省回退 URL）、kind 去重；没有稳定键时保留，不按标题猜测。UUID 仅用于抓取追踪。每日榜单跨日不去重。没有新增的 RSS 不再每天重发旧文。这是当日日报策略，不是跨历史已读账本；凌晨前发布或无日期的内容不会补发。

selection 报告统计 fetched、selected、other_date、undated、duplicates（出现重复时）。source_reports 随总结归档并通过阅读 API 提供；空来源在网页与推送说明，全部为空也归档通知且不调用模型。推送每条附来源 ID，网页沿用已有来源标签。采集失败输出 collection.failed 结构化日志（来源、业务日、错误码、操作），仍按既有规则重试，最终失败阻断总结，不伪装成无新增。

历史归档不可变，不补写来源诊断、不重新发送。调度 CLI 在后续 tick 加载新代码。

## 新流程 v2：固定期次与事件处理（已实现，待显式切换）

入口为 `src/workflow-cli.mjs`，装配在 `src/workflow.mjs`，任务适配在 `src/workflow-handlers.mjs`。旧 systemd 服务入口不自动改变。配置示例为 `config/workflow.example.json`。

计划为每源 collect → prepare → edit → track → compose → push；各阶段仍由同一个通用 Scheduler 显式调用。通用执行上下文增加 `parameters`，来自首次固化的计划快照，不解析新闻字段。prepare 根据 business_date 和固化的参数生成 EditionSpec，重试和跨午夜恢复沿用同一窗口。

窗口默认前一日 08:00 到当日 08:00，左闭右开，以工作流日历和时区计算；投递仍为 09:15。截止时刻可通过 `edition_cutoff` 配置。文章按发布窗口选择；榜单按本期当地观测日选择，因此今早采到的每日榜单可以进入本期，不会因恰好在 08:00 边界被延到次日。

存储保留窗口外的材料。尚未编入正式期次的迟到文章可补收，标注原发布时间；有标题、正文与原文链接但无日期的文章保留并标未知，不能以发现时间冒充发布时间。未来消息留档等待到期。已编入期次不等于已发送；若推送过期或未知，仍按旧投递规则核对，不借补收重复发送。

`include_initial_history=false` 是示例中的保守待评审策略：首次来源抓取与来源采集配置变化建立存量基线，窗口前的历史只归档，之后新发现的迟到材料才补收。显式设 true 可纳入这些尚未编入期次的存量。基线以当时窗口固定，不会将首期失败后仍未收录的正常文章在下一期误判成存量。该策略未经真实投递激活，首次部署前需确认。

阶段结果、模型返回和历史上下文保存到独立业务内容库；重试复用输入、模型与提示词版本相同的成功结果。处理失败继续阻断下游，没有新增自动退化为基础摘要的路径。模型尚未返回时中断仍可能重复计费。

手动入口 `workflow:manual` 使用独立任务命名空间和持久清单，但与新流程自动任务共享执行账本锁，窗口与筛选语义相同。手动执行会真实采集、调用模型和发送，测试不执行该命令。`--resume` 仅恢复同一业务日的清单。
