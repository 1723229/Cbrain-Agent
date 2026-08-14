# TDAI 全局镜像本地部署

全局三件套镜像的本地拉起脚本 —— `memory-core` + `memory-hub` + `proxy`，可各自独立运行，也能一条命令全部启动。

## 组件与端口

| 组件 | 容器名 | 镜像（Docker Hub 公开） | 宿主机端口 | 用途 |
|---|---|---|---|---|
| **memory-core** | `tdai-memory-core` | [`agentmemory/memory-core`](https://hub.docker.com/r/agentmemory/memory-core) | `8420` | 内核 gateway，记忆读写、鉴权、skill/RAG 数据面 |
| **memory-hub**  | `tdai-memory-hub`  | [`agentmemory/memory-hub`](https://hub.docker.com/r/agentmemory/memory-hub)   | `8125` / `8424` | 管理面板 (Panel) + 知识服务 (Knowledge) 合并镜像 |
| **proxy**       | `tdai-proxy`       | [`agentmemory/memory-proxy`](https://hub.docker.com/r/agentmemory/memory-proxy) | `8096` | LLM 请求转发代理，coding agent 的 API 入口 |

> 三个镜像都发布在 Docker Hub 的 [`agentmemory`](https://hub.docker.com/u/agentmemory) 命名空间下，
> 多架构（`linux/amd64` + `linux/arm64`），公开可拉、无需登录。想固定版本时把 `.env` 里的 tag 从
> `:latest` 换成具体版本即可，例如 `:1.0.0-beta.1`。
>
> 腾讯内部同事也可以覆盖到内网私仓 `mirrors.tencent.com/memory-team-control/` —— 见 `.env.example` 里
> 注释掉的备选块。

## 环境要求

- macOS / Linux
- Docker（Docker Desktop / colima / OrbStack 任一）
- `bash` 4+（macOS 自带 3.2 也能跑）

## 快速开始

### 从当前源码构建 Cbrain 镜像

LDAP、Web Session、Cbrain 品牌页面或本地插件安装包等源码能力需要使用本仓库构建的镜像，不能回退到上游公开旧镜像：

```bash
cd deploy/global-images
bash ./build-cbrain-images.sh
```

脚本默认要求 Git 工作区干净，并以提交 SHA 作为镜像标签。构建完成后，将输出的 `MEMORY_CORE_IMAGE` 和 `MEMORY_HUB_IMAGE` 写入 `.env`，再执行 `./start-all.sh`。开发中的脏工作区只能显式使用 `ALLOW_DIRTY=1 CBRAIN_IMAGE_TAG=<tag>`，生成的镜像会标记 `io.cbrain.source.dirty=1`，不得当作正式发布镜像。

Core、Panel/Knowledge 和 Proxy 默认使用 `unless-stopped` 自动重启策略；可通过 `.env` 的 `DOCKER_RESTART_POLICY` 覆盖。已有部署若使用 `cbrain` 作为面板容器名，可设置 `MEMORY_HUB_CONTAINER=cbrain`。

```bash
# 1) 准备 .env
cp .env.example .env

# 2) 编辑 .env，把两组 LLM 参数填成真值
#    - MEMORY_LLM_*   → memory-core + memory-hub 内部用
#    - PROXY_UPSTREAM_* → proxy 转发到的上游 LLM
$EDITOR .env

# 3) 干跑校验（不启动容器）
#    默认会同时校验 LLM 通路 —— 提前验证 API key/URL/模型名，避免起服务后才发现配错
./verify.sh
# 不希望发外部请求（离线环境等）：./verify.sh --skip-llm

# 4) 一键拉起三件套
./start-all.sh
```

## LLM 通路预检

`verify.sh` 默认会预检两组 LLM 通路（`--skip-llm` 关掉）：

- **OpenAI 兼容协议**：`GET {base}/models`，只验证 API key + URL，**不消耗任何 token**
- **Anthropic 协议**：`POST {base}/v1/messages` 发 `max_tokens=1` 的最小消息，消耗 ≤ 10 token
- **memory 组** 与 **proxy 组** 独立验；若两组配置完全相同，自动跳过重复检查
- **容器已运行时**，额外从容器内 exec 一次 curl，验证"容器 → LLM"的网络可达性（一些企业代理/DNS 隔离环境下宿主机可达但容器不可达）

失败例子：

```
[error] memory 组 API key 无效（HTTP 401）：https://api.deepseek.com/v1/models
{"error":{"message":"Authentication Fails, Your api key: ****abcd is invalid",...}}
```

—— API key 错、URL 错、模型名错都会在启动前拦下，不会等到 wiki ingest / chat 时才 401。

启动完成后：

- Panel UI：<http://localhost:8125/>
- Knowledge API：<http://localhost:8424/v3/>
- Knowledge Swagger：<http://localhost:8424/docs>
- Memory Gateway：<http://localhost:8420/>
- Proxy：<http://localhost:8096/>

## 两组独立参数

**这是脚本设计的核心** —— memory 组和 proxy 组的 LLM 完全独立，可以指向不同供应商 / 不同模型。

### memory 组（memory-core + memory-hub 使用）

内核记忆 embed/summarize、knowledge 的 wiki ingest / 总结走这组配置。

| 变量 | 说明 | 示例 |
|---|---|---|
| `MEMORY_LLM_BASE_URL` | OpenAI 兼容 base URL | `https://api.deepseek.com/v1` |
| `MEMORY_LLM_API_KEY` | 上述端点的 API Key | `sk-xxxxxxxx` |
| `MEMORY_LLM_MODEL` | 模型 ID | `deepseek-chat` |
| `MEMORY_LLM_PROTOCOL` | `openai` 或 `anthropic`，默认 `openai` | `openai` |

### proxy 组（proxy 使用）

proxy 接到用户请求后转发到这组端点。

| 变量 | 说明 | 示例 |
|---|---|---|
| `PROXY_UPSTREAM_URL` | 转发目标 base URL | `https://api.deepseek.com/v1` |
| `PROXY_UPSTREAM_API_KEY` | 转发用 API Key | `sk-xxxxxxxx` |
| `PROXY_UPSTREAM_MODEL` | 面向用户的模型 ID | `deepseek-chat` |

> memory 与 proxy 两组可以填相同值，也可以完全不同。Embedding 通过独立的
> `MEMORY_EMBEDDING_*` 参数配置，不复用对话模型地址；未配置时继续使用 BM25。

参数缺失时脚本会**在启动前一次性列出所有缺失项**并 `exit 1`，不会跑到一半才失败。

## 内部凭据（生产环境必看）

三件套之间用 `MEMORY_CORE_GATEWAY_API_KEY` 互相认证，首次启动还会通过
`init-admin` 建一个 `system_admin` 账户。为了**零配置本地体验**，脚本默认值是：

| 变量 | 默认值 | 用途 |
|---|---|---|
| `MEMORY_CORE_GATEWAY_API_KEY` | `local` | memory-hub / proxy → memory-core 的 Bearer |
| `MEMORY_CORE_ADMIN_USERNAME` | `admin` | 初始化的 system_admin 用户名 |
| `MEMORY_CORE_ADMIN_USER_KEY` | `admin` | 该 admin 用户的登录 key |

> 这三个默认值只适合个人本地跑通流程。**生产/联调/公网暴露前必须替换成随机长串**，
> 否则任何拿到端口的人都能拿到 system_admin 权限。
>
> 在 `.env` 里取消对应三行的注释并覆盖即可（`_lib.sh` 会 `require_vars`
> 校验其他必填项，但这三个变量因为有默认兜底，脚本会在启动时打 `[warn]` 提醒你换）。

## Cbrain 后台 LDAP 登录

LDAP 是后台普通用户的主登录方式。Web 登录成功后使用 HttpOnly Session Cookie；普通用户的 Agent API Key 只供 Codex Plugin、Claude Code Plugin 使用，不能登录后台。LDAP 故障时，system_admin 的有效 API Key 可用于管理员应急登录。

1. 在 LDAP 创建独立只读账号 `cbrain-bind`，只授予检索人员目录所需权限。
2. 将 bind 密码保存到宿主机文件并设为 `0600`，在 `.env` 配置 `CBRAIN_LDAP_BIND_PASSWORD_HOST_FILE`。
3. 配置 `.env` 中 `CBRAIN_LDAP_*` 和 `CBRAIN_SESSION_*`；正式环境必须启用 Cbrain HTTPS、`CBRAIN_SESSION_COOKIE_SECURE=true`、LDAP StartTLS 与 CA 校验。
4. 执行 `./start-memory-hub.sh`。脚本会校验 secret 文件并只读挂载，不把 LDAP 密码放进容器环境变量。

管理员应急登录只接受有效、未过期、未吊销且归属 `system_admin` 的 API Key；普通用户 API Key 会被拒绝。隔离内网 POC 若暂时没有 TLS，必须显式设置 `CBRAIN_LDAP_ALLOW_INSECURE_POC=true` 和 `CBRAIN_SESSION_COOKIE_SECURE=false`，且只能使用一次性测试账号。

## 独立使用每个组件

三个脚本可以单独执行，方便调试或只需要部分能力时：

```bash
./start-memory-core.sh       # 只跑内核 gateway（8420）
./start-memory-hub.sh   # 只跑面板 + 知识（8125 + 8424）；需要 MEMORY_LLM_* 参数
./start-proxy.sh        # 只跑 proxy（8096）；需要 PROXY_UPSTREAM_* 参数
```

依赖关系：

- **memory-core**：无外部依赖，可以独立起
- **memory-hub**：能独立启动（LLM_MODE=custom 直连 LLM），但内部 knowledge 调 memory-core 做 RAG 时会失败 → 建议 memory-core 先起
- **proxy**：能独立启动（cost-guard 不可用时自动降级 passthrough，直接转发），但 auth / tdai memory / skill 注入需要 memory-core 才有效

任意组件缺失时脚本会 `warn` 提醒但不阻塞。

## 数据持久化

- `tdai-memory-core-data`（named volume）→ memory-core 的 SQLite / 记忆数据
- `tdai-panel-data`（named volume）→ memory-hub 里 knowledge 的 SQLite / git clone / wiki 文件

`docker volume rm` 之前数据一直保留。改名可在 `.env` 里改 `MEMORY_CORE_VOLUME` / `PANEL_VOLUME`。

## 停止 / 清理

```bash
./stop-all.sh            # 停容器，保留 volume（下次启动数据还在）
./stop-all.sh --purge    # 停容器 + 删 volume + 删网络（彻底清理）
```

## 查看日志

```bash
docker logs -f tdai-memory-core
docker logs -f tdai-memory-hub
docker logs -f tdai-proxy
```

memory-hub 内部有两个进程（panel + knowledge），日志分别在容器内 `/data/knowledge/logs/panel.log` 和 `.../knowledge.log`。

## 端口冲突

如果 `8125` / `8420` / `8424` / `8096` 与本地已有服务冲突，直接在 `.env` 改：

```bash
MEMORY_CORE_PORT=18420
PANEL_PORT=18125
KNOWLEDGE_PORT=18424
PROXY_PORT=18096
# knowledge 对外可达地址要跟着 KNOWLEDGE_PORT 走
KNOWLEDGE_PUBLIC_BASE_URL=http://host.docker.internal:18424/v3
```

## 使用 proxy 作为 coding agent 的 API base

以 Claude Code 为例：

```bash
export ANTHROPIC_BASE_URL=http://localhost:8096
export ANTHROPIC_API_KEY=any-string-if-auth-disabled
# 使用 openai 协议的客户端类似：OPENAI_BASE_URL=http://localhost:8096/v1
```

Panel UI "客户端接入地址" 卡片会自动拼上宿主机的 LAN IP + `PROXY_PORT`（例如
`http://192.168.1.100:8096/codebuddy/default`），别人的电脑复制过去就能直接连过来。
由 `MEMORY_HUB_PROXY_PUBLIC_URL`（未设时脚本用 `hostname -I` / macOS `ipconfig getifaddr en0`
自动探测，探不到才回落 `localhost`）注入到 memory-hub 里的 `metadata-instances.json.proxy_endpoint`。
Panel 后端 → Kernel 的转发不受此变量影响（始终走 `REMOTE_INSTANCE_URL` → memory-core:8420）。
自动探测的地址不对时（多网卡 / 公网域名 / 反代前置），在 `.env` 显式设
`MEMORY_HUB_PROXY_PUBLIC_URL=http://<真值>:8096`。想让 UI 卡片走老行为（回落到
gateway_endpoint）就把 `MEMORY_HUB_PROXY_PUBLIC_URL` 显式设为空字符串。

Codex / Claude Code Plugin 不走模型代理，而是连接独立的 Cbrain Agent Gateway。
在 `.env` 配置 `REMOTE_AGENT_GATEWAY_URL=http://<宿主机可达地址>:8430` 后，API Key
页面会显示两类客户端的一键安装命令；未配置时该卡片隐藏。

`proxy` 默认关闭 `auth` / `sessionInit` / `costGuard`（这些依赖内部服务），只做纯转发 + `tdai-memory` 上下文注入（injector 名称，非容器名）。要开启完整流水线，需要另行配置 —— 参见 `context_proxy/config.example.yaml`。

## 常见问题

**Q: `./start-all.sh` 卡在 wait_healthy？**
镜像可能还在拉取。用 `docker pull <IMAGE>` 手动预拉一次再跑脚本。

**Q: memory-hub 起来但 Panel 打不开？**

检查 `.env` 里 `KNOWLEDGE_PUBLIC_BASE_URL` 是不是含 `/v3` —— 缺 `/v3` panel 会报错。

**Q: proxy 转发返回 401？**
`PROXY_UPSTREAM_API_KEY` 无效或 `PROXY_UPSTREAM_URL` 不匹配。用 `docker logs tdai-proxy` 看错误。

**Q: 如何在容器外访问宿主机上其它服务（Ollama、Langfuse 等）？**
脚本已默认 `--add-host=host.docker.internal:host-gateway`。容器内用 `http://host.docker.internal:<port>` 即可。
