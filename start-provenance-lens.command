#!/bin/zsh

set -eu

repository_dir="${0:A:h}"
exec /usr/bin/env node "$repository_dir/scripts/start-extension.mjs" "$@"
