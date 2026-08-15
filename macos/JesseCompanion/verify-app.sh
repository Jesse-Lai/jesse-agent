#!/bin/zsh
set -euo pipefail

SCRIPT_DIR="${0:A:h}"
PROJECT_ROOT="${SCRIPT_DIR:h:h}"
APP_ROOT="${1:-$SCRIPT_DIR/build/Jesse Agent.app}"
EXECUTABLE="$APP_ROOT/Contents/MacOS/JesseCompanion"
SERVICE_ROOT="$APP_ROOT/Contents/Resources/AgentService"

[[ -x "$EXECUTABLE" ]]
[[ -x "$SERVICE_ROOT/runtime/node" ]]
[[ -f "$SERVICE_ROOT/dist/desktopServer.js" ]]
[[ -f "$SERVICE_ROOT/dist/ideServer.js" ]]
[[ -f "$SERVICE_ROOT/web/index.html" ]]
[[ -f "$APP_ROOT/Contents/Resources/FluentIcons/ic_fluent_translate_24_regular.svg" ]]

[[ "$(lipo -archs "$SERVICE_ROOT/runtime/node")" == "arm64" ]]
[[ "$($SERVICE_ROOT/runtime/node --version)" == v22.* ]]
codesign --verify --deep --strict "$APP_ROOT"

if otool -L "$EXECUTABLE" | /usr/bin/grep -Eiq 'WebKit|JavaScriptCore'; then
  echo "Native executable must not link WebKit or JavaScriptCore." >&2
  exit 1
fi

if /usr/bin/grep -R -a -F -l "$PROJECT_ROOT" "$APP_ROOT/Contents" >/dev/null; then
  echo "App bundle contains an absolute source checkout path." >&2
  exit 1
fi

echo "Verified self-contained Jesse Agent.app"
