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

## CI、升级与回滚

GitHub Actions 在 main push、PR 和手动运行时执行 npm ci、完整测试、Compose 校验和 Docker 构建。main/手动运行保留 `bbns-image-<commit>` 镜像下载产物 7 天；CI 不读取生产凭据，也不会自动替换服务器。下载产物后 `gzip -dc bbns-image.tar.gz | docker load`；镜像名为 `bbns:<完整提交号>`。

本地一键构建、上传并激活（该命令真实替换服务）：

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
