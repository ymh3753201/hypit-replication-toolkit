#!/bin/sh
set -eu
umask 022
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$ROOT"
if [ "${1:-}" = "--help" ]; then
  echo '用法：sh scripts/install.sh [--check|--with-oss]；默认安装不需要 OSS，不提交模型任务。'
  exit 0
fi
case "${1:-}" in ''|--check|--with-oss) ;; *) echo '未知参数；使用 --help 查看。' >&2; exit 1;; esac
missing=0
for c in curl tar python3 ffmpeg ffprobe; do
  if ! command -v "$c" >/dev/null 2>&1; then echo "缺少系统工具：$c" >&2; missing=1; fi
done
[ "$missing" -eq 0 ] || { echo '请让 AI 按安装指南先补齐系统工具。' >&2; exit 1; }
python3 -c 'import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)' || { echo '基础 Python 至少需要 3.10。' >&2; exit 1; }
if [ "${1:-}" = "--check" ]; then
  python3 scripts/install-skills.py --check
else
  python3 scripts/install-skills.py
fi
case "$(uname -s)" in Darwin) os=darwin;; Linux) os=linux;; *) echo '请在 macOS、Linux 或 Windows WSL2 中运行。' >&2; exit 1;; esac
case "$(uname -m)" in arm64|aarch64) arch=arm64;; x86_64|amd64) arch=x64;; *) echo '不支持当前 CPU 架构。' >&2; exit 1;; esac
[ "${1:-}" != "--check" ] || { echo "系统工具齐备：${os}/${arch}。尚未安装依赖或连接 API。"; exit 0; }
version=v24.14.1
node_home="$ROOT/.toolchain/node-$version"
if [ ! -x "$node_home/bin/node" ]; then
  stage=$(mktemp -d)
  trap 'rm -rf "$stage"' EXIT HUP INT TERM
  archive="node-$version-$os-$arch.tar.gz"
  curl --fail --location --proto '=https' --tlsv1.2 "https://nodejs.org/dist/$version/$archive" -o "$stage/$archive"
  curl --fail --location --proto '=https' --tlsv1.2 "https://nodejs.org/dist/$version/SHASUMS256.txt" -o "$stage/SHASUMS256.txt"
  python3 - "$stage" "$archive" <<'CHECKSUM'
import hashlib, pathlib, sys
root=pathlib.Path(sys.argv[1]); name=sys.argv[2]
expected=next((line.split()[0] for line in (root/'SHASUMS256.txt').read_text().splitlines() if line.split()[-1]==name),None)
if expected is None or hashlib.sha256((root/name).read_bytes()).hexdigest()!=expected: raise SystemExit('Node 下载校验失败，停止安装')
CHECKSUM
  tar -xzf "$stage/$archive" -C "$stage"
  mkdir -p "$ROOT/.toolchain"
  mv "$stage/node-$version-$os-$arch" "$node_home"
fi
export PATH="$node_home/bin:$PATH"
[ "$(node --version)" = "$version" ] || { echo '项目 Node 版本错误。' >&2; exit 1; }
# Install the pinned package manager locally; system Node and global packages stay unchanged.
npm install --prefix "$ROOT/.toolchain/pnpm" --no-audit --no-fund pnpm@10.33.0
cd "$ROOT/hypit"
node "$ROOT/.toolchain/pnpm/node_modules/pnpm/bin/pnpm.cjs" install --frozen-lockfile --config.confirmModulesPurge=false
cd "$ROOT"
# Only explicitly selected legacy/OSS transport needs this optional SDK.
if [ "${1:-}" = "--with-oss" ]; then
  python3 -m venv hypit/packages/provider-cangyuan/runtime/.venv
  hypit/packages/provider-cangyuan/runtime/.venv/bin/python -m pip install -r hypit/packages/provider-cangyuan/runtime/requirements.txt
fi
# Reuse an existing local Chrome when available; no personal path is shipped.
python3 - "$ROOT" <<'BROWSER'
from pathlib import Path
import json,shutil,sys
root=Path(sys.argv[1])
candidates=['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',shutil.which('google-chrome'),shutil.which('chromium'),shutil.which('chromium-browser')]
chrome=next((p for p in candidates if p and Path(p).is_file()),None)
if chrome:
 for rel in ('hypit/hypit.runtime.cangyuan.json','config/hypit.runtime.local.json'):
  f=root/rel;d=json.loads(f.read_text());d['endpoints']['hyperframes.local']['config'].setdefault('chromePath',chrome)
  f.write_text(json.dumps(d,ensure_ascii=False,indent=2)+'\n')
 print('已配置本机现有 Chrome，用于免费本地渲染。')
BROWSER
chmod +x bin/hypit bin/replicate bin/test-replication scripts/*.sh
./bin/hypit version
./bin/replicate help
printf '%s\n' '基础依赖安装完成。下一步：配置自己的视频 API，准备渲染浏览器。官方 H3 默认无需 OSS；此时尚未完成真实出片验证。'
