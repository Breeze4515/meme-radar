#!/bin/zsh
set -eu
radar_dir=${0:A:h}
exec /bin/bash "$radar_dir/安装并启动.command" "$@"
