#!/usr/bin/env bash
# 构建 panel + knowledge 合并镜像。
#
# 用法（在 deploy/panel-knowledge-combined/ 下执行）：
#   ./build.sh                              # 用默认路径 + 默认 tag
#   TMC_DIR=/path/to/MemoryPanel ./build.sh # 自定义 panel 源码目录
#   KNOWLEDGE_DIR=/path/to/MemoryKnowledge ./build.sh
#   IMAGE_TAG=my-tag ./build.sh             # 自定义 tag
#   CTX_DIR=/tmp/my-ctx ./build.sh          # 自定义临时 context 目录
#   KEEP_CTX=1 ./build.sh                    # 不清理 context（调试用）
#   PREPARE_ONLY=1 ./build.sh                # 只 rsync context，不 docker build（供 publish.sh）
#
# 默认源码均在本仓库根下：
#   memory-tencentdb/
#   ├── MemoryPanel/                         # panel 后端 + web 前端
#   ├── MemoryKnowledge/                     # knowledge service
#   └── deploy/panel-knowledge-combined/     # 本配方
#
# 输出镜像名：team-memory-panel-knowledge:${TAG}（默认 tag=amd64）

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"          # memory-tencentdb 根
WORKSPACE_ROOT="$(dirname "$REPO_ROOT")"               # 上一级（默认 CTX_DIR 落点）

TMC_DIR="${TMC_DIR:-$REPO_ROOT/MemoryPanel}"
KNOWLEDGE_DIR="${KNOWLEDGE_DIR:-$REPO_ROOT/MemoryKnowledge}"
CBRAIN_AGENT_PACKAGE_DIR="${CBRAIN_AGENT_PACKAGE_DIR:-$REPO_ROOT/packages/cbrain-agent}"
IMAGE_NAME="${IMAGE_NAME:-team-memory-panel-knowledge}"
IMAGE_TAG="${IMAGE_TAG:-amd64}"
CTX_DIR="${CTX_DIR:-$WORKSPACE_ROOT/panel-knowledge-builder}"
KEEP_CTX="${KEEP_CTX:-0}"
PREPARE_ONLY="${PREPARE_ONLY:-0}"
PLATFORM="${PLATFORM:-linux/amd64}"
CBRAIN_SOURCE_REVISION="${CBRAIN_SOURCE_REVISION:-unknown}"
CBRAIN_SOURCE_DIRTY="${CBRAIN_SOURCE_DIRTY:-unknown}"

err() { echo "[build-combined] error: $*" >&2; exit 1; }

copy_tree() {
  local source="$1" destination="$2"
  shift 2
  case "$destination/" in
    "$CTX_DIR"/*) ;;
    *) err "拒绝清理构建上下文之外的目录: $destination" ;;
  esac
  rm -rf -- "$destination"
  mkdir -p "$destination"
  local tar_args=()
  local pattern
  for pattern in "$@"; do tar_args+=(--exclude "$pattern"); done
  (cd "$source" && tar -cf - "${tar_args[@]}" .) | (cd "$destination" && tar -xf -)
}

[[ -d "$TMC_DIR/package.json" || -f "$TMC_DIR/package.json" ]] \
  || err "MemoryPanel 不在 $TMC_DIR（设 TMC_DIR=<path> 指定）"
[[ -f "$KNOWLEDGE_DIR/package.json" ]] \
  || err "MemoryKnowledge 不在 $KNOWLEDGE_DIR（设 KNOWLEDGE_DIR=<path> 指定）"
[[ -f "$CBRAIN_AGENT_PACKAGE_DIR/package.json" ]] \
  || err "Cbrain Agent 安装器不在 $CBRAIN_AGENT_PACKAGE_DIR"
[[ -f "$SCRIPT_DIR/Dockerfile" ]] || err "Dockerfile 不在 $SCRIPT_DIR"
[[ -f "$SCRIPT_DIR/start-combined.sh" ]] || err "start-combined.sh 不在 $SCRIPT_DIR"

echo "[build-combined] panel  (MemoryPanel): $TMC_DIR"
echo "[build-combined] knowledge:            $KNOWLEDGE_DIR"
echo "[build-combined] installer:            $CBRAIN_AGENT_PACKAGE_DIR"
echo "[build-combined] context dir:                 $CTX_DIR"
echo "[build-combined] image:                       $IMAGE_NAME:$IMAGE_TAG"
echo ""

# 清理旧 context（KEEP_CTX=1 时跳过）
if [[ "$KEEP_CTX" == "1" ]]; then
  echo "[build-combined] KEEP_CTX=1 → 保留旧 context"
else
  rm -rf "$CTX_DIR"
fi
mkdir -p "$CTX_DIR"

# 复制 panel（builder stage 编译需要 src/ + web/ + package*.json + tsconfig.json，
# 排除敏感真值 config/*.json、文档、测试、.claude、docker 配置等非必要文件）
echo "[build-combined] copy panel → $CTX_DIR/panel/"
copy_tree "$TMC_DIR" "$CTX_DIR/panel" \
  .git node_modules web/node_modules dist build coverage data .claude \
  .env '.env.*' config/metadata-instances.json 'config/*.yaml' 'config/*.yml' \
  docs tests scripts docker 'e2e-*.sh' '*.md' pnpm-lock.yaml pnpm-workspace.yaml vitest.config.ts

# 复制 knowledge（builder stage 编译需要 src/ + package*.json + tsconfig.json + tsdown.config.ts，
# runtime 需要包根的 openapi.yaml（Swagger UI）。排除文档、测试、.claude、docker 配置等）
echo "[build-combined] copy knowledge → $CTX_DIR/knowledge/"
copy_tree "$KNOWLEDGE_DIR" "$CTX_DIR/knowledge" \
  .git node_modules dist coverage data .claude .env '.env.*' bin docs __tests__ docker \
  'docker-compose*.yml' Dockerfile .dockerignore '*.md' pnpm-lock.yaml vitest.config.ts start.sh

# 安装器由 Cbrain 自身托管，页面命令不依赖 npm 发布状态。
copy_tree "$CBRAIN_AGENT_PACKAGE_DIR" "$CTX_DIR/cbrain-agent-package" \
  node_modules dist test scripts

# 拷 Dockerfile + start-combined.sh + .dockerignore + README（rsync 已过滤敏感文件，.dockerignore 作兜底）
cp "$SCRIPT_DIR/Dockerfile" "$CTX_DIR"/
cp "$SCRIPT_DIR/start-combined.sh" "$CTX_DIR"/
cp "$SCRIPT_DIR/README.md" "$CTX_DIR"/
if [[ -f "$SCRIPT_DIR/.dockerignore" ]]; then
  cp "$SCRIPT_DIR/.dockerignore" "$CTX_DIR"/
fi

if [[ "$PREPARE_ONLY" == "1" ]]; then
  echo ""
  echo "[build-combined] PREPARE_ONLY=1 → context 已就绪: $CTX_DIR"
  exit 0
fi

# build
echo "[build-combined] docker build --platform $PLATFORM -t $IMAGE_NAME:$IMAGE_TAG $CTX_DIR"
docker build --platform "$PLATFORM" \
  --label "org.opencontainers.image.revision=$CBRAIN_SOURCE_REVISION" \
  --label "io.cbrain.source.dirty=$CBRAIN_SOURCE_DIRTY" \
  -t "$IMAGE_NAME:$IMAGE_TAG" "$CTX_DIR"

echo ""
echo "[build-combined] ✅ done: $IMAGE_NAME:$IMAGE_TAG"
echo "[build-combined] context 保留在 $CTX_DIR（KEEP_CTX=0 时下次会清掉）"
