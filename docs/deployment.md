# 本地部署记录

部署位置：/home/csc/app/BBNS。验收日期：2026-10-23，时区 Asia/Shanghai。

已安装并启用当前用户的 bbns-scheduler.timer，状态 active/enabled；每分钟唤醒一次，已观察到 17:35 的自动触发。bbns-scheduler.service 首次及自动执行均 Result=success、ExecMainStatus=0。Linger=yes，支持注销后运行。

正式起始业务日为 **2026-10-24**：
- AIHOT、博客 RSS、GitHub Trending 当前没有明确建议时刻，均为 08:00。
- 总结从 08:00 起等待当日三源采集成功。
- 推送从 09:15 起等待当日归档，默认 10:15 截止，不跨日补发。

验收结果：
- 完整测试 29 项通过，覆盖进程中断恢复、并发互斥、持久重试、依赖阻断、跨日隔离、分批总结恢复及投递防重放。
- 三个真实来源各采集 1 条，均成功。
- 使用本地配置的真实模型完成总结，归档至 data/summaries/2026-10-23/ada3d03c-bfa9-45b7-b7a5-82535afe131e.json。
- 企业微信认证成功，验收发送消息数为 0。
- 未发现另一个 src/run.mjs 企微长连接进程。
- 首次正式自动投递尚未发生，最终接受状态以投递回执为准。

配置：config/scheduler.local.json；凭据：.env。不在文档中复制凭据或接收人标识。
账本：data/scheduler/state.sqlite；内容按业务日保存，详见 [调度协议](scheduling.md)。

查看：
```sh
npm run scheduler:status
npm run scheduler:plan
systemctl --user status bbns-scheduler.timer
journalctl --user -u bbns-scheduler.service -n 50 --no-pager
```
停止：
```sh
systemctl --user disable --now bbns-scheduler.timer
systemctl --user stop bbns-scheduler.service
```

## 手动端到端验收（2026-10-23）

用户明确要求总结今天内容并真实推送后，执行了 npm run scheduler:manual。
按 Asia/Shanghai 的文章发布时间和榜单观测时间筛选；未知日期及历史文章不纳入本次总结。

- AIHOT：获取19条，当日8条。
- 博客RSS：获取100条，当日0条。
- GitHub Trending：当日榜单9条。
- 总结：17条，文档 data/summaries/2026-10-23/b607f127-84ff-4e45-9cc4-13d75935e908.json。
- 真实推送：4段均 accepted，均有 provider_reference；接受不等于已读。
- 投递回执目录：data/deliveries/2026-10-23/46b8af5a-e919-45bf-bb31-1444246440d2/。
- 本次执行记录：data/scheduler/manual/2026-10-23/9a8510e4-ff45-4176-8b00-25a1777e24fa.json.result.json。
- 全部5个任务一次成功；完整31项测试通过。
- 既定自动任务仍从2026-10-24开始，配置未改。

手动命令每次创建新执行并真实发送：
```sh
npm run scheduler:manual
```
恢复同一次执行：
```sh
npm run scheduler:manual -- --resume data/scheduler/manual/2026-10-23/9a8510e4-ff45-4176-8b00-25a1777e24fa.json
```
恢复不重发已接受的文本块，unknown 仍不会自动重发。只恢复同一业务日；使用独立任务命名空间，共享生产执行锁与账本。手动引擎不会执行其他命名空间的待办任务。

## 只读前端接入（2026-10-23）

页面地址：http://127.0.0.1:3080。前端与后端查询在同一 BBNS 应用服务中提供，内容唯一来源为正式 SummaryDocument JSON。
应用现在由 bbns.target 统一启停：npm start / npm stop / npm restart。完整状态：npm run app:status。
原 timer 的独立开机入口已迁移到应用 target，原有08:00采集/总结与09:15推送计划保留。

35项测试和真实Chrome交互检查通过。已实际停止/恢复应用，确认页面、timer共享启停；写请求405且真实归档内容哈希不变。
接口与边界见 [只读前端](frontend.md)。

## 工作流 v2 的开发交付与切换

本轮提供新流程代码及离线验收，未自动执行真实模型调用、企微发送或服务切换。原 `.env`、个人配置、历史采集、期次、回执与执行账本保持原状。

1. 保存当前代码和运行配置的私有备份；配置中有凭据与目标，不提交、不放进测试样本。
2. 从 `config/workflow.example.json` 建立私有 `config/workflow.local.json`，确认截止时刻、首次存量策略及起始业务日。旧 config 文件不覆盖。
3. 执行 `npm run workflow:plan -- config/workflow.local.json YYYY-MM-DD` 检查计划；plan 不连接外部服务、不创建内容库。check 验证本地配置与凭据存在性，会初始化新内容库但不发外部请求。
4. 切换前停止旧执行入口并核对正在运行和 unknown 的发送记录，避免同一 Bot 多连接。示例为新流程使用独立 `data/scheduler/workflow-v2.sqlite`，不能与旧服务同时发送。
5. 首次新期次从明确的未来业务日起执行。将 systemd service 的命令改为 `src/workflow-cli.mjs tick config/workflow.local.json`；在 app.local 的 scheduler_config 指向新配置，再重启阅读进程。不要在执行中的期次直接替换计划。
6. 本机 check、离线测试与配置准备可以先完成；真实模型/投递验收需明确授权。`workflow:manual` 会真实发送，不能作为无副作用检查。
7. 若需回退，恢复旧入口和配置，保留新内容库及全部归档，依据回执核对已发送期次，不因回退自动重发。新阅读代码支持旧文档；旧阅读代码不认识 v2，回退前须保留其只读访问方式。

部署迁移尚未发生，因此旧入口代码仍有运行中消费者；实际切换完成并结清其任务后再删除旧执行实现。原始 v1 归档读取是历史数据契约，不能随入口退役删除。
