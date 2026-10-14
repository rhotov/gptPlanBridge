#!/bin/zsh
set -eu
cd "$(dirname "$0")"
if [[ -z "${PLANBRIDGE_NODE_BIN:-}" ]]; then
  PLANBRIDGE_NODE_BIN="$(command -v node || true)"
fi
if [[ -z "$PLANBRIDGE_NODE_BIN" || ! -x "$PLANBRIDGE_NODE_BIN" ]]; then
  echo '请先安装 Node.js 24.5 或更高版本，或用 PLANBRIDGE_NODE_BIN 指定 Node.js 路径。'
  exit 1
fi
PLANBRIDGE_NODE_HELP="$("$PLANBRIDGE_NODE_BIN" --help)"
if [[ "${1:-start}" == "stop" ]]; then
  export NO_PROXY="${NO_PROXY:-${no_proxy:-}},127.0.0.1,localhost"
  export no_proxy="$NO_PROXY"
  export NODE_USE_ENV_PROXY=0
  if [[ "$PLANBRIDGE_NODE_HELP" == *'--use-env-proxy'* ]]; then
    exec "$PLANBRIDGE_NODE_BIN" --no-use-env-proxy launch.mjs stop
  fi
  exec "$PLANBRIDGE_NODE_BIN" launch.mjs stop
fi
PLANBRIDGE_PROXY_MODE="${PLANBRIDGE_USE_ENV_PROXY:-auto}"
if [[ "$PLANBRIDGE_PROXY_MODE" == "auto" ]]; then
  PLANBRIDGE_PROXY_MODE=0
  PLANBRIDGE_PROXY_SETTINGS="$(/usr/sbin/scutil --proxy 2>/dev/null || true)"
  PLANBRIDGE_HTTP_ENABLED="$(print -r -- "$PLANBRIDGE_PROXY_SETTINGS" | awk '$1 == "HTTPEnable" {print $3}')"
  PLANBRIDGE_HTTPS_ENABLED="$(print -r -- "$PLANBRIDGE_PROXY_SETTINGS" | awk '$1 == "HTTPSEnable" {print $3}')"
  PLANBRIDGE_HTTP_HOST="$(print -r -- "$PLANBRIDGE_PROXY_SETTINGS" | awk '$1 == "HTTPProxy" {print $3}')"
  PLANBRIDGE_HTTP_PORT="$(print -r -- "$PLANBRIDGE_PROXY_SETTINGS" | awk '$1 == "HTTPPort" {print $3}')"
  PLANBRIDGE_HTTPS_HOST="$(print -r -- "$PLANBRIDGE_PROXY_SETTINGS" | awk '$1 == "HTTPSProxy" {print $3}')"
  PLANBRIDGE_HTTPS_PORT="$(print -r -- "$PLANBRIDGE_PROXY_SETTINGS" | awk '$1 == "HTTPSPort" {print $3}')"
  if [[ "$PLANBRIDGE_HTTP_ENABLED" == "1" && -n "$PLANBRIDGE_HTTP_HOST" && "$PLANBRIDGE_HTTP_PORT" == <-> ]]; then
    [[ "$PLANBRIDGE_HTTP_HOST" != *:* ]] || PLANBRIDGE_HTTP_HOST="[$PLANBRIDGE_HTTP_HOST]"
    export HTTP_PROXY="http://$PLANBRIDGE_HTTP_HOST:$PLANBRIDGE_HTTP_PORT"
    export http_proxy="$HTTP_PROXY"
    PLANBRIDGE_PROXY_MODE=1
  fi
  if [[ "$PLANBRIDGE_HTTPS_ENABLED" == "1" && -n "$PLANBRIDGE_HTTPS_HOST" && "$PLANBRIDGE_HTTPS_PORT" == <-> ]]; then
    [[ "$PLANBRIDGE_HTTPS_HOST" != *:* ]] || PLANBRIDGE_HTTPS_HOST="[$PLANBRIDGE_HTTPS_HOST]"
    export HTTPS_PROXY="http://$PLANBRIDGE_HTTPS_HOST:$PLANBRIDGE_HTTPS_PORT"
    export https_proxy="$HTTPS_PROXY"
    PLANBRIDGE_PROXY_MODE=1
  fi
  if [[ -n "${HTTPS_PROXY:-${https_proxy:-}}" || -n "${HTTP_PROXY:-${http_proxy:-}}" ]]; then
    PLANBRIDGE_PROXY_MODE=1
  fi
fi
if [[ "$PLANBRIDGE_PROXY_MODE" == "1" ]]; then
  if [[ "$PLANBRIDGE_NODE_HELP" != *'--use-env-proxy'* ]]; then
    echo '当前 Node.js 不支持代理启动，请使用支持 --use-env-proxy 的版本（如 Node.js 24.5 或更新版本）。'
    exit 1
  fi
  export NO_PROXY="${NO_PROXY:-${no_proxy:-}},127.0.0.1,localhost"
  export no_proxy="$NO_PROXY"
  exec "$PLANBRIDGE_NODE_BIN" --use-env-proxy launch.mjs "${1:-start}"
fi
if [[ "$PLANBRIDGE_PROXY_MODE" != "0" ]]; then
  echo 'PLANBRIDGE_USE_ENV_PROXY 只支持 auto、0 或 1。'
  exit 1
fi
export NODE_USE_ENV_PROXY=0
if [[ "$PLANBRIDGE_NODE_HELP" == *'--use-env-proxy'* ]]; then
  exec "$PLANBRIDGE_NODE_BIN" --no-use-env-proxy launch.mjs "${1:-start}"
fi
exec "$PLANBRIDGE_NODE_BIN" launch.mjs "${1:-start}"
