#!/bin/zsh
set -eu
cd "$(dirname "$0")"
PLANBRIDGE_SOURCE="$(cd .. && pwd -P)"
PLANBRIDGE_OUTPUT="$(dirname "$PLANBRIDGE_SOURCE")"
PLANBRIDGE_NODE="${PLANBRIDGE_NODE_BIN:-$(command -v node || true)}"
if [[ "$(/usr/bin/uname -s)" != "Darwin" || "$(/usr/bin/uname -m)" != "arm64" ]]; then
  print -r -- '构建需要 Apple Silicon Mac。' >&2
  exit 1
fi
if [[ -z "$PLANBRIDGE_NODE" || ! -x "$PLANBRIDGE_NODE" ]]; then
  print -r -- '找不到 Node.js；请安装 Node.js 24.5 或更高版本，或设置 PLANBRIDGE_NODE_BIN。' >&2
  exit 1
fi
PLANBRIDGE_NODE_HELP="$("$PLANBRIDGE_NODE" --help)"
if [[ "$PLANBRIDGE_NODE_HELP" != *'--use-env-proxy'* ]]; then
  print -r -- '打包的 Node.js 必须支持 --use-env-proxy（如 Node.js 24.5 或更高版本）。' >&2
  exit 1
fi
if [[ "$("$PLANBRIDGE_NODE" -p 'process.platform + ":" + process.arch')" != "darwin:arm64" ]]; then
  print -r -- '打包的 Node.js 必须是 macOS arm64 运行时。' >&2
  exit 1
fi
if [[ -n "${PLANBRIDGE_LEGACY_DATA_DIR:-}" && "$PLANBRIDGE_LEGACY_DATA_DIR" != /* ]]; then
  print -r -- 'PLANBRIDGE_LEGACY_DATA_DIR 必须是绝对路径。' >&2
  exit 1
fi
PLANBRIDGE_STAGE="$(mktemp -d /private/tmp/planbridge-package.XXXXXX)"
trap 'rm -rf "$PLANBRIDGE_STAGE"' EXIT
PLANBRIDGE_APP="$PLANBRIDGE_STAGE/PlanBridge.app"
PLANBRIDGE_BUILD="$PLANBRIDGE_OUTPUT/.planbridge-build"
mkdir -p "$PLANBRIDGE_BUILD/module-cache" "$PLANBRIDGE_APP/Contents/MacOS" "$PLANBRIDGE_APP/Contents/Resources/runtime" "$PLANBRIDGE_APP/Contents/Resources/server/macos"
/usr/bin/xcrun swiftc -O -swift-version 5 -target arm64-apple-macosx13.0 -module-cache-path "$PLANBRIDGE_BUILD/module-cache" -framework AppKit PlanBridge.swift -o "$PLANBRIDGE_APP/Contents/MacOS/PlanBridge"
/usr/bin/xcrun swiftc -O -swift-version 5 -target arm64-apple-macosx13.0 -module-cache-path "$PLANBRIDGE_BUILD/module-cache" -framework AppKit Icon.swift -o "$PLANBRIDGE_BUILD/render-icon"
"$PLANBRIDGE_BUILD/render-icon" "$PLANBRIDGE_BUILD/icon-pngs"
mkdir -p "$PLANBRIDGE_BUILD/PlanBridge.iconset"
for PLANBRIDGE_SIZE in 16 32 128 256 512; do
  cp "$PLANBRIDGE_BUILD/icon-pngs/$PLANBRIDGE_SIZE.png" "$PLANBRIDGE_BUILD/PlanBridge.iconset/icon_${PLANBRIDGE_SIZE}x${PLANBRIDGE_SIZE}.png"
  PLANBRIDGE_DOUBLE=$((PLANBRIDGE_SIZE * 2))
  cp "$PLANBRIDGE_BUILD/icon-pngs/$PLANBRIDGE_DOUBLE.png" "$PLANBRIDGE_BUILD/PlanBridge.iconset/icon_${PLANBRIDGE_SIZE}x${PLANBRIDGE_SIZE}@2x.png"
done
/usr/bin/iconutil -c icns "$PLANBRIDGE_BUILD/PlanBridge.iconset" -o "$PLANBRIDGE_APP/Contents/Resources/PlanBridge.icns"
cp "$PLANBRIDGE_NODE" "$PLANBRIDGE_APP/Contents/Resources/runtime/node"
for PLANBRIDGE_FILE in server.mjs chat-compat.mjs data-path.mjs launch.mjs start.command stop.command LICENSE; do
  cp "$PLANBRIDGE_SOURCE/$PLANBRIDGE_FILE" "$PLANBRIDGE_APP/Contents/Resources/server/$PLANBRIDGE_FILE"
done
cp app-control.mjs "$PLANBRIDGE_APP/Contents/Resources/server/macos/app-control.mjs"
cp -R "$PLANBRIDGE_SOURCE/public" "$PLANBRIDGE_APP/Contents/Resources/server/"
cp Node-LICENSE.txt "$PLANBRIDGE_APP/Contents/Resources/runtime/LICENSE.txt"
PLANBRIDGE_BUILD_APP="$PLANBRIDGE_APP" /usr/bin/python3 - <<'PY'
import json, os, plistlib
from pathlib import Path
app = Path(os.environ['PLANBRIDGE_BUILD_APP'])
info = {
    'CFBundleName': 'PlanBridge', 'CFBundleDisplayName': 'PlanBridge',
    'CFBundleIdentifier': 'local.planbridge.menubar', 'CFBundleExecutable': 'PlanBridge',
    'CFBundlePackageType': 'APPL', 'CFBundleShortVersionString': '1.1.0',
    'CFBundleVersion': '2', 'CFBundleIconFile': 'PlanBridge',
    'LSUIElement': True, 'LSMinimumSystemVersion': '13.0',
    'NSHighResolutionCapable': True,
    'NSHumanReadableCopyright': 'PlanBridge · MIT License',
}
with (app / 'Contents/Info.plist').open('wb') as out: plistlib.dump(info, out)
installation = {}
# Optional migration is a local build choice. Public builds contain no source path.
legacy = os.environ.get('PLANBRIDGE_LEGACY_DATA_DIR')
if legacy:
    installation['legacyDataDir'] = legacy
(app / 'Contents/Resources/installation.json').write_text(json.dumps(installation))
PY
chmod 755 "$PLANBRIDGE_APP/Contents/MacOS/PlanBridge" "$PLANBRIDGE_APP/Contents/Resources/runtime/node" "$PLANBRIDGE_APP/Contents/Resources/server/start.command" "$PLANBRIDGE_APP/Contents/Resources/server/stop.command"
# Finder metadata copied from source files is not part of a signed application.
/usr/bin/xattr -dr com.apple.FinderInfo "$PLANBRIDGE_APP" 2>/dev/null || true
/usr/bin/xattr -dr com.apple.ResourceFork "$PLANBRIDGE_APP" 2>/dev/null || true
/usr/bin/codesign --force --sign - --identifier local.planbridge.runtime "$PLANBRIDGE_APP/Contents/Resources/runtime/node"
/usr/bin/codesign --force --deep --sign - "$PLANBRIDGE_APP"
/usr/bin/codesign --verify --deep --strict "$PLANBRIDGE_APP"
/usr/bin/ditto -c -k --norsrc --noextattr --keepParent "$PLANBRIDGE_APP" "$PLANBRIDGE_OUTPUT/PlanBridge-macOS-arm64.zip"
print -r -- "已生成：$PLANBRIDGE_OUTPUT/PlanBridge-macOS-arm64.zip"
