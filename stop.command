#!/bin/zsh
set -eu
cd "$(dirname "$0")"
exec ./start.command stop
