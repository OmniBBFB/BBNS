# Docker 服务器部署

公开只读入口：https://news.omnibbfb.top 。不要求登录，GET/HEAD 提供日报、来源和事件证据，写请求返回 405；网页请求不运行模型或推送。API Key、接收人配置、采集原文和发送回执不通过网页路由发布。

## 服务与持久化

- 镜像基于 Node.js 24 bookworm-slim，使用 package-lock.json 和 npm ci 安装依赖，不复制配置、凭据、数据或 Git 目录。
- `bbns-web`：提供页面和只读查询，数据挂载为只读，没有 DeepSeek／企微环境变量，不映射宿主机端口。
- `bbns-worker`：每个 tick 完成后等待 60 秒；已有调度器决定业务时间、依赖、重试与回执状态。SIGTERM 转发给当前 tick；单实例运行，不能水平扩容。网页和 worker 共用一个镜像。
- 现有 `nginx` 通过 `nginx_net` 网络转发到 `bbns-web:3080`，使用现有通配符证书，HTTP 重定向至 HTTPS。证书续期后的 Nginx reload 延用服务器既有机制。
- SQLite 为进程内数据库，不需要 MySQL/Postgres 或单独数据库容器。`data/scheduler/state.sqlite` 是执行账本，v2 的 `data/content/state.sqlite` 是内容库；日报、采集、回执继续使用文件。
- 整个 `/root/docker/main/bbns/data` 挂载到 `/app/data`，随时可备份，替换镜像不会删除；不能放进镜像层或仅保留在容器可写层。SQLite 必须与其 WAL/SHM 一起在同一个本地磁盘目录，不能分别挂载数据库文件，也不使用网络文件系统。
- `/root/docker/main/bbns/config` 只读挂载；凭据独立保存在 `bbns/.env`，仅 worker 经 Compose `env_file` 加载。文件不提交，备份同样属于私有数据。

## 首次安装

1. 构建并上传镜像，使用固定版本标签。服务器已有 `~/docker/main/docker-compose.yml`，将 `deploy/compose.yml` 的两个服务合入它，复用原有 `nginx_net`；不要替换其他服务。模板中的路径相对于 `~/docker/main`。
2. 在主 Compose `.env` 设置 `BBNS_IMAGE=bbns:<版本>`，把 `deploy/activate-image.sh` 复制为 `bbns/activate-image.sh`。把 Nginx 文件复制到 `nginx/conf/news.conf`。
3. 停止本机 `bbns.target`，停用独立 timer（如果仍启用），等待任务退出并核对 running/unknown 投递。备份本机完整 `data/`，停止写入后通过 SSH 迁移整个目录及实际使用的配置。必须保留相同的相对路径、账本和回执；不要修改已持久化任务配置或删除任务身份来“重新开始”。
4. 容器内工作目录为 `/app`，业务配置使用 `data/...` 和 `config/...` 相对路径。本次继续使用现行 `scheduler.local.json`，不同时切换工作流 v2。`app.local.json` 设置 `host: "0.0.0.0"`、`port: 3080`。
5. 数据和配置由镜像内 node 用户（UID/GID 1000）可访问；data 可写，config 只读；`.env` 为 root 所有、权限 600。不要执行不相关目录的递归 chown。
6. 执行以下检查，然后启动 web、检查 Nginx 配置并 reload，最后启动 worker。既有账本控制今天已经执行的任务，不重发已接受或 unknown 的消息块。

```sh
cd /root/docker/main
docker compose config --quiet
docker compose run --rm --no-deps bbns-worker node src/scheduler-cli.mjs check
# 真实、少量付费请求；此命令不发送企微消息。
docker compose run --rm --no-deps bbns-worker node tools/check-provider.mjs
docker compose up -d bbns-web
docker exec nginx nginx -t
docker exec nginx nginx -s reload
docker compose up -d bbns-worker
curl --fail https://news.omnibbfb.top/health
```

## CI/CD、升级与回滚

GitHub Actions 在 main push、PR 和手动运行时执行 npm ci、完整测试、部署隔离测试、Compose 校验和 Docker 构建，再以合成配置、无网络、只读文件系统测试实际 reader 镜像。测试不读取生产凭据、不启动生产 worker。仅 main 的 push/手动运行将这个已验证镜像发布至 `ghcr.io/omnibbfb/bbns:sha-<commit>`，部署时选择发布后的 `@sha256:` 摘要。

仓库变量 `BBNS_AUTO_DEPLOY=true` 启用自动部署；设为 `false` 可暂停更新，CI 和镜像发布仍照常运行。`production` 环境保存 `BBNS_DEPLOY_SSH_KEY`、`BBNS_DEPLOY_KNOWN_HOSTS` 两项 secret，以及 `BBNS_DEPLOY_HOST` 变量。BBNS 使用独立 Ed25519 key，服务器 `authorized_keys` 将其绑定到 `python3 /root/docker/main/bbns/deploy/remote-release.py`，加上 `restrict`；只接受 `deploy` 和本仓库固定摘要镜像，不开放 shell 或转发，不复用游戏站的部署私钥。

首次接入已授权的 GitHub CLI 后，由管理员安装该部署入口、公钥并设置上述仓库/环境配置。服务器用当前 CI job 的临时 `GITHUB_TOKEN` 拉取镜像，凭据只写临时 Docker 配置并在拉取后清除；不保存个人 PAT。日常提交代码后执行 `git push origin main` 即可。运行结果见 [BBNS Actions](https://github.com/OmniBBFB/BBNS/actions/workflows/ci.yml)。

自动部署依次执行：

1. 获取项目发布锁，同时遵守共享 Compose 栈中游戏站的发布锁，避免两个项目同时替换服务。
2. 拉取固定摘要镜像；等待当前 scheduler/workflow tick 空闲，最长 10 分钟，超时则保留旧服务。仅停止 `bbns-worker`，继续使用原有 SIGTERM 合作式取消机制。
3. 保存主 `.env`、Compose、完整 `bbns/data`（包含 SQLite sidecar）、配置和凭据至 `bbns/backups/cicd-<timestamp>`；备份目录仅 root 可访问。
4. 在无网络的新镜像中复制快照到临时文件系统，运行对应版本的 `check` 验证生产配置和账本。仅副本可写，不调用模型、不连接企微、不手动 tick、不恢复任务。
5. 原子更新主 `.env` 的 **BBNS_IMAGE 一项**，核对其他 Compose 服务配置完全相同，先替换/检查 web，再启动单个 worker。现有配置、归档、任务账本和投递回执保留，不切换 v2，不回填历史或越过截止时间补发。
6. 验证 worker 运行状态和公开 HTTPS；Nginx 配置无需修改。失败时恢复原镜像并重启旧服务，保留当前数据，绝不覆盖回执或自动重发。涉及存储格式不兼容的版本仍需另行安排迁移，不能依靠镜像回退撤销数据库变更。

`deploy/remote-release.py` 是服务器受限入口。修改该入口本身需管理员维护通道重新安装，常规 CI 只部署应用镜像。私钥和本机验收文件位于被忽略的 `.local/`，不提交。

原有本地构建、上传并激活入口继续保留供人工维护（该命令真实替换服务）：

```sh
bash deploy/upload-image.sh bbns:release-20261028 root@123.56.248.107 \
  -o IdentitiesOnly=yes -i ~/.ssh/ecs_123_56_248_107_ed25519
```

`activate-image.sh` 备份主 `.env`，只替换两个 BBNS 服务并检查网页健康；失败时恢复上一镜像。它不会撤销已发生的模型调用、数据库变更或企微发送；带存储格式变更的升级必须另行核对兼容性与回执。

```sh
cd /root/docker/main
docker compose ps bbns-web bbns-worker
docker compose logs --tail=50 bbns-worker
docker compose exec -T bbns-worker node src/scheduler-cli.mjs status
# 手动检查模型：这是实际付费请求，不要作为自动健康检查。
docker compose exec -T bbns-worker node tools/check-provider.mjs
# 回到兼容的旧镜像，不删除数据：
bash bbns/activate-image.sh bbns:<旧版本>
```

备份时停止 worker，确认没有其他写入者，打包整个 `bbns/data`（含 SQLite sidecar）和私有配置，再恢复 worker。读库处于 WAL 模式时网页进程可能需要已有的 SHM 文件；迁移、恢复或启用 v2 时先由 worker/check 初始化数据库再启动网页。离机备份自行保存在私有位置，不上传公共产物。

本机服务在切换后保持停用。若恢复本机，先停止服务器 worker，迁回最新数据及发送回执后再启动，禁止两处同时运行或用旧备份重推。

## 2026-10-28 上线验收

- 首个生产镜像 `bbns:20261028-deploy1`，Node 24；主 Compose 中两个服务均已启动，web 健康。
- 309 个数据文件复制前后 SHA256 一致，SQLite 完整性检查通过；保留今日已成功推送的账本，没有通过迁移重新发送。
- 服务器容器使用实际配置调用 `deepseek-flash` 成功，返回有效 JSON；本次 prompt 63、completion 27、total 90 tokens。
- 外网 HTTPS 首页、健康接口、目录与日报详情均 200；目录可读 7 份日报、不可用 0，最新为 10 月 28 日 18 条。私有文件路径 404，POST 405。
- 网页容器数据只读、无 API/Bot 凭据、无宿主机端口映射；worker 单实例按现有 scheduler 配置运行，v2 未切换。
- 全部 61 测试通过；[首次 GitHub CI](https://github.com/OmniBBFB/BBNS/actions/runs/40631838827) 成功构建并保存镜像产物。
- 服务器首次配置备份：`/root/docker/main/bbns/backups/20261028T035800Z`。本机完整迁移副本：`/tmp/bbns-server-migration-mbxvmrv9`，原始 data 也保留；tmp 副本不作为长期备份。

## 2026-11-02 来源失败隔离上线

- 修复版本 `9fee57b`，生产镜像 `bbns:20261102-source-failures`。68 项测试通过，含真实调度、采集与总结适配器、投递回执的故障注入测试；Node 24 镜像模块加载检查通过。
- [修复版本 GitHub CI](https://github.com/OmniBBFB/BBNS/actions/runs/41377511185) 已成功完成测试、Compose 校验和镜像构建。
- 总结等待来源结束后只使用成功来源材料；失败来源继续保留失败状态，网页和日报推送明确说明原因。每源独立失败通知通过现有企业微信目标发送；通知失败不阻断日报，accepted 和 unknown 均沿用防重发机制。
- 停止 worker 后备份完整数据、配置和凭据至 `/root/docker/main/bbns/backups/source-isolation-20261102T022638Z/data-config.tgz`，主 Compose `.env` 同目录备份；已有归档与采集文件上线后 SHA256 全部一致。
- 显式恢复当天从未启动的 summarize/push，保留来源结果、失败次数、任务 ID 和投递截止时间。11 月 2 日归档已生成且公网 API 可读，GitHub 来源为 TIMEOUT、3 次；其他两源成功但当日条目均为 0。日报推送已超过 10:15，保持 expired，未跨期限补发。
- 独立 GitHub 失败通知成功，渠道回执 accepted 且有 provider_reference；后续 tick 不重发。web healthy，worker 持续运行，公开浏览器状态模块返回 200。11 月 1 日历史任务未改动。
