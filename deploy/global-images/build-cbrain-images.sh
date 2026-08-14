#!/usr/bin/env bash
# 从当前仓库源码构建 Cbrain Core 与 Panel/Knowledge 两个本地镜像。
# 默认要求 Git 工作区干净，使镜像标签可追溯到唯一提交；开发验证可显式设置
# ALLOW_DIRTY=1，并必须自行提供 CBRAIN_IMAGE_TAG。

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
# shellcheck source=./_lib.sh
source "$SCRIPT_DIR/_lib.sh"

load_env

if git -C "$REPO_ROOT" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  git_revision="${CBRAIN_SOURCE_REVISION:-$(git -C "$REPO_ROOT" rev-parse --verify HEAD)}"
  dirty=0
  if [[ -n "$(git -C "$REPO_ROOT" status --porcelain --untracked-files=normal)" ]]; then
    dirty=1
  fi
else
  git_revision="${CBRAIN_SOURCE_REVISION:-}"
  dirty="${CBRAIN_SOURCE_DIRTY:-1}"
  [[ -n "$git_revision" ]] || die "源码快照不含 .git，必须设置 CBRAIN_SOURCE_REVISION。"
  [[ "$dirty" == "0" || "$dirty" == "1" ]] || die "CBRAIN_SOURCE_DIRTY 只能是 0 或 1。"
fi

if (( dirty == 1 )) && [[ "${ALLOW_DIRTY:-0}" != "1" ]]; then
  die "Git 工作区不干净。先提交源码再构建；临时验证必须显式设置 ALLOW_DIRTY=1 和 CBRAIN_IMAGE_TAG。"
fi
if (( dirty == 1 )) && [[ -z "${CBRAIN_IMAGE_TAG:-}" ]]; then
  die "脏工作区构建必须显式设置 CBRAIN_IMAGE_TAG，避免生成不可识别的镜像。"
fi

image_tag="${CBRAIN_IMAGE_TAG:-${git_revision:0:12}}"
if [[ ! "$image_tag" =~ ^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$ ]]; then
  die "CBRAIN_IMAGE_TAG 不是合法 Docker tag: $image_tag"
fi

core_image="${CBRAIN_CORE_IMAGE_REPOSITORY:-cbrain-memory-core}:$image_tag"
hub_image="${CBRAIN_HUB_IMAGE_REPOSITORY:-cbrain-memory-hub}:$image_tag"
build_root="${CBRAIN_BUILD_ROOT:-${TMPDIR:-/tmp}/cbrain-image-build}"

info "构建 Core 镜像: $core_image"
$DOCKER build \
  --label "org.opencontainers.image.revision=$git_revision" \
  --label "io.cbrain.source.dirty=$dirty" \
  -t "$core_image" \
  "$REPO_ROOT/MemoryCore"

info "构建 Panel/Knowledge 镜像: $hub_image"
IMAGE_NAME="${hub_image%:*}" \
IMAGE_TAG="${hub_image##*:}" \
CTX_DIR="$build_root/panel-knowledge" \
CBRAIN_SOURCE_REVISION="$git_revision" \
CBRAIN_SOURCE_DIRTY="$dirty" \
  bash "$REPO_ROOT/deploy/panel-knowledge-combined/build.sh"

cat <<EOF

[ok] Cbrain 源码镜像构建完成
  revision: $git_revision
  dirty:    $dirty
  core:     $core_image
  hub:      $hub_image

将以下值写入 $ENV_FILE 后执行 start-memory-core.sh / start-memory-hub.sh：
  MEMORY_CORE_IMAGE=$core_image
  MEMORY_HUB_IMAGE=$hub_image
EOF
