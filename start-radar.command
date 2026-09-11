#!/bin/zsh
set -eu

radar_dir=${0:A:h}
node_bin="$(/bin/bash "$radar_dir/scripts/bootstrap-node.sh")"
"$node_bin" "$radar_dir/scripts/setup.mjs"

exec "$node_bin" --use-env-proxy "$radar_dir/src/main.mjs" "$@"
