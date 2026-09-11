#!/bin/bash
set -eu
radar_root="$(cd -- "$(dirname -- "$0")" && pwd)"
radar_node="$(/bin/bash "$radar_root/scripts/bootstrap-node.sh")"
exec "$radar_node" "$radar_root/scripts/open.mjs" "$@"
