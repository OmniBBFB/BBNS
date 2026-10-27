# 只读归档页面

前端是 BBNS 应用的展示组件，地址默认为 http://127.0.0.1:3080，使用 app.local.json 的 host/port 配置。无前端构建步骤、无新增运行依赖。

## 唯一事实源与 MVC 边界

唯一内容事实源是正式发布的 SummaryDocument JSON：
data/summaries/YYYY-MM-DD/<id>.json，兼容旧平铺 <id>.json。
目录中的日期是工作流业务日期；旧平铺文档由 created_at 按 Asia/Shanghai 归属日期。

- Model：SummaryReader 只读归档文件，不依赖采集存储、任务账本、模型接口或推送记录。
- Controller：HTTP 路由负责查询；浏览器 controller 负责加载文档和维护日期、版本、来源、关键词等临时阅读状态。
- View：web/view.mjs 的纯函数接受归档投影与阅读状态，返回展示结果，不改变输入文档。

标题、摘要、来源、链接、原始排名、顺序、条数和时间都由归档文档及其中的 source 快照派生。页面不重新总结、不抓取原文、不另存可编辑内容。
.batches、临时文件、JSONL、Markdown 副本不进入目录。无可用归档时展示空状态；坏文档单独计数并提示，不编造内容。
API 不返回输入文件的本地绝对路径、模型凭据或原始正文，只返回展示所需的归档投影。
归档内容按文本转义展示，原文链接仅接受 HTTP(S)。

## 只读 HTTP 契约

- GET /api/summaries：返回 documents 元数据、dates 和不可读数量 unavailable。
- GET /api/summaries/YYYY-MM-DD/<id>：读取指定业务日期与文档ID的展示投影。
- GET /health：应用健康检查。
- HEAD：对应只读资源的无正文响应。
- POST / PUT / PATCH / DELETE / OPTIONS 等其他方法一律返回 405，Allow: GET, HEAD。

静态资源使用固定白名单，不开放 data、config 或任意文件下载。所有响应 no-store；刷新会重新读取归档，列表没有独立数据库。
筛选、搜索和清除只改变浏览器阅读状态；界面不提供采集、重试、总结、推送或写入入口。

## 与应用共享生命周期

bbns.target 是统一应用入口，包含：

- bbns-app.service：后端只读查询与前端静态资源。
- bbns-scheduler.timer：每分钟唤醒调度。
- bbns-scheduler.service：按需执行任务。

上述服务和 timer 使用 PartOf=bbns.target。停止应用 target 会停止页面、timer 和正在执行的调度服务；重新启动 target 恢复整套应用。
安装工具移除旧 timer 在 timers.target 下独立启动的引导，改为由 BBNS 应用 target 管理，原有时间计划和 SQLite 账本保留。

```sh
npm run app:install
npm start
npm stop
npm restart
npm run app:status
```

npm start/stop/restart 操作已安装的用户级系统服务，命令返回后应用在后台运行。Linger 保持当前用户服务在注销后运行。
页面开发入口为 npm run app:serve；独立企微入站调试入口为 npm run messaging:start。

## 当前验证

完整35项测试通过，包括只读方法、真实文档不被修改、忽略中间产物、坏文件隔离、旧格式读取、路径约束与纯视图输入不变。
真实 Chrome 检查默认展示17条；来源筛选为9条、搜索空状态和归档版本切换通过，控制台无异常。390px手机布局无横向溢出。
已实际执行 npm stop / npm start：target、页面服务和timer同时停止，HTTP无法访问；启动后均恢复 active，HTTP正常。
真实归档 POST 返回405，校验前后文件 SHA-256 一致。本次开发和验证未触发额外模型或推送任务。
截图及启停验证位于 data/verification/reader-desktop.png、reader-mobile.png、reader-lifecycle.json。

## 新期次与事件证据

SummaryReader 支持 v1 和 v2，后者先校验结构化字段。条目可展示补收、未知发布时间、进展、原文证据、首次发现与处理时间。旧期次仍按原快照展示，不被当前事件状态改写。

内部只读接口增加 `GET /api/stories/<story-id>`，通过 ContentReader 的 SQLite readOnly 模式读取已保存关系。页面展开“事件当前历史”后才读取，明确显示当前状态；没有模型、采集或写操作。不存在的数据库不能被阅读请求创建。标题、证据及进展均转义；原文链接仍仅允许 HTTP(S)。

新流程部署时，在 `config/app.local.json` 将 `scheduler_config` 指向 `config/workflow.local.json`，让阅读进程使用新流程的内容库路径。默认仍指向已部署的旧配置，不自动切换服务。
