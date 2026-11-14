# 网页变化监控

changedetection.io 独立检测网页，BBNS worker 读取其单个 watch 的 RSS。管理 API 不进入 BBNS 日常采集。

## 部署

`deploy/compose.yml` 在原有两个 BBNS 服务之外增加 `changedetection`，默认固定为 0.70.3。生产通过主 Compose `.env` 的 `CHANGEDETECTION_IMAGE` 固定镜像摘要。仅 worker 加入 `feeds` 网络并声明 `service_started` 依赖；web 不依赖监控服务。启动顺序不代表目标网页已经可读。

生产数据目录为 `/root/docker/main/changedetection/data`，挂载 `/datastore`。配置、watch UUID、RSS/API 令牌和历史快照一同备份；不要直接删除目录重建。管理端口仅绑定服务器 `127.0.0.1:5000`，可通过 SSH 转发访问：

```sh
ssh -N -L 5000:127.0.0.1:5000 root@123.56.248.107 \
  -o IdentitiesOnly=yes -i ~/.ssh/ecs_123_56_248_107_ed25519
```

随后打开 `http://127.0.0.1:5000`。首版使用普通 HTTP 抓取、一个 fetch worker、384 MiB 内存上限，关闭 LLM 功能；不启动 Chromium。

## 监控配置

公开的来源及选择器见 `config/change-monitors.example.json`。生产副本为 `/root/docker/main/changedetection/monitors.json`。每个来源检查间隔 6 小时，只比较文章 URL，排序、去重并启用历史唯一行，忽略删除和重排。首次成功抓取建立基线，现有文章不作为新增消息。

| 来源 | 页面 |
| --- | --- |
| Claude Cookbook | https://platform.claude.com/cookbook/ |
| OpenAI Developer Blog | https://developers.openai.com/blog |
| OpenAI Engineering | https://openai.com/news/engineering/ |

通过 UI 修改时，在每个 watch 的过滤设置里预览结果，确认是绝对文章链接；403、过滤失败或无内容都要保留真实错误，不能把错误页建立成基线。API 也可配置 watch，官方入口为 `/api/v1/watch`，令牌保存在 changedetection 自己的数据目录中，不写进公开示例。

## BBNS 的 RSS 入口

每个来源使用独立历史 RSS：`http://changedetection:5000/rss/watch/<UUID>?token=<TOKEN>`。不使用受“已查看”状态影响的 tag 汇总 RSS。实际 UUID 和 URL 保存在被 Git 忽略的 `config/changedetection.local.json`，订阅保存在 `config/subscriptions.local.json`，并由 `scheduler.local.json` 指向该文件。

```json
{
  "id": "claude-cookbook-updates",
  "adapter": "changedetection",
  "enabled": true,
  "limit": 100,
  "options": {
    "title": "Claude Cookbook",
    "url": "http://changedetection:5000/rss/watch/WATCH_UUID?token=RSS_TOKEN"
  }
}
```

少于两个快照时，0.70.3 的单项 RSS 返回特定 HTTP 400。`changedetection` 适配器仅将与当前 UUID 精确匹配的该响应转为 `waiting_for_history` 空批次；普通 400、403、404、500 仍失败。该状态只说明没有可比较的历史，不保证目标网页抓取成功。目标抓取是否成功须在 changedetection UI 中核实；尚未成功建立基线的来源暂不启用 BBNS 订阅。

RSS GUID 作为变化身份，`pubDate` 作为检测时间，`kind` 为 `observation`，正文标为 `summary`。单条可能包含多个新增链接，不表示一篇教程，也不表示教程全文。当前日报沿用按北京时间筛选当日材料的规则。

## 验证

离线测试覆盖变化语义、GUID、日期、正文及初始化错误的精确识别。另用无外网、临时数据目录的真实 0.70.3 镜像建立模拟页面：一次初始快照返回 400，增加链接后 RSS 返回 200，再由 BBNS 实际适配器验证。测试数据不进入生产 watch，不触发模型和消息推送。
