#!/bin/bash
set -eu
umask 077

radar_root="$(cd -- "$(dirname -- "$0")/.." && pwd)"
radar_version='v22.23.1'
radar_platform="$(uname -s)"
radar_arch="$(uname -m)"
case "$radar_platform" in Darwin) radar_platform='darwin' ;; Linux) radar_platform='linux' ;; *) printf '%s\n' '请安装 Node.js 22.23+ 后运行 npm run open。' >&2; exit 1 ;; esac
case "$radar_arch" in arm64|aarch64) radar_arch='arm64' ;; x86_64) radar_arch='x64' ;; *) printf '%s\n' '暂不支持此 CPU 架构。' >&2; exit 1 ;; esac
radar_dist="node-${radar_version}-${radar_platform}-${radar_arch}"
radar_runtime="$radar_root/.runtime/$radar_dist"

for radar_candidate in "${RADAR_NODE_BIN:-}" "$radar_runtime/bin/node" "$(command -v node || true)" "${HOME}/.local/bin/node" /opt/homebrew/bin/node /usr/local/bin/node /usr/bin/node; do
  if [ "${RADAR_USE_BUNDLED_NODE:-0}" = '1' ] && [ "$radar_candidate" != "$radar_runtime/bin/node" ]; then continue; fi
  if [ -n "$radar_candidate" ] && [ -x "$radar_candidate" ] && "$radar_candidate" -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a===22&&b>=23||a===24&&b>=5||a>24?0:1)' 2>/dev/null; then
    printf '%s\n' "$radar_candidate"
    exit 0
  fi
done

printf '%s\n' '首次运行：正在从 nodejs.org 准备本项目专用运行环境……' >&2
mkdir -p "$radar_root/.runtime"
radar_temp="$(mktemp -d "$radar_root/.runtime/.node-download.XXXXXX")"
radar_archive="$radar_dist.tar.gz"
radar_base="https://nodejs.org/dist/$radar_version"
curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 --connect-timeout 20 --max-time 300 --retry 2 "$radar_base/$radar_archive" -o "$radar_temp/$radar_archive"
curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 --connect-timeout 20 --max-time 60 --retry 2 "$radar_base/SHASUMS256.txt" -o "$radar_temp/SHASUMS256.txt"
radar_expected="$(awk -v name="$radar_archive" '$2 == name { print $1 }' "$radar_temp/SHASUMS256.txt")"
if command -v shasum >/dev/null 2>&1; then
  radar_actual="$(shasum -a 256 "$radar_temp/$radar_archive" | awk '{print $1}')"
else
  radar_actual="$(sha256sum "$radar_temp/$radar_archive" | awk '{print $1}')"
fi
if [ "${#radar_expected}" -ne 64 ] || [ "$radar_expected" != "$radar_actual" ]; then
  printf '%s\n' '下载校验失败，请检查网络并重新运行安装入口。' >&2
  exit 1
fi
tar -xzf "$radar_temp/$radar_archive" -C "$radar_temp"
"$radar_temp/$radar_dist/bin/node" --version >&2
if [ -e "$radar_runtime" ]; then
  printf '%s\n' '本地运行环境目录已存在，请检查后重试。' >&2
  exit 1
fi
mv "$radar_temp/$radar_dist" "$radar_runtime"
rm -- "$radar_temp/$radar_archive" "$radar_temp/SHASUMS256.txt"
rmdir "$radar_temp"
printf '%s\n' "$radar_runtime/bin/node"
