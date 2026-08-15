#!/bin/zsh
set -euo pipefail

SCRIPT_DIR="${0:A:h}"
BUILD_ROOT="$SCRIPT_DIR/build"
APP_ROOT="$BUILD_ROOT/Jesse Agent.app"
LEGACY_APP_ROOT="$BUILD_ROOT/Jesse Companion.app"
SWIFT_BUILD_ROOT="$SCRIPT_DIR/.build"
SWIFT_MODULE_CACHE="$SWIFT_BUILD_ROOT/module-cache"
PROJECT_ROOT="${SCRIPT_DIR:h:h}"
SERVICE_ROOT="$APP_ROOT/Contents/Resources/AgentService"

mkdir -p "$SWIFT_MODULE_CACHE"
export CLANG_MODULE_CACHE_PATH="$SWIFT_MODULE_CACHE"
export SWIFTPM_MODULECACHE_OVERRIDE="$SWIFT_MODULE_CACHE"

if [[ "${JESSE_SKIP_NATIVE_BUILD:-0}" != "1" ]]; then
  (cd "$PROJECT_ROOT" && npm run build && npm run desktop:build)
  swift build \
    --package-path "$SCRIPT_DIR" \
    --scratch-path "$SWIFT_BUILD_ROOT" \
    --configuration release
fi

# Jesse Companion was the old product name.  It is now only a feature inside
# Jesse Agent, so never leave a second launchable bundle beside the product.
rm -rf "$APP_ROOT" "$LEGACY_APP_ROOT"
mkdir -p "$APP_ROOT/Contents/MacOS" "$APP_ROOT/Contents/Resources"
cp "$SWIFT_BUILD_ROOT/release/JesseCompanion" "$APP_ROOT/Contents/MacOS/JesseCompanion"
strip -S "$APP_ROOT/Contents/MacOS/JesseCompanion"
cp "$SCRIPT_DIR/Info.plist" "$APP_ROOT/Contents/Info.plist"
cp "$SCRIPT_DIR/AppIcon.png" "$APP_ROOT/Contents/Resources/AppIcon.png"
cp "$PROJECT_ROOT/desktop-app/assets/jesse-mark.png" "$APP_ROOT/Contents/Resources/JesseMark.png"
mkdir -p "$APP_ROOT/Contents/Resources/Fonts"
cp "$PROJECT_ROOT"/desktop-app/fonts/GoogleSansFlex-*.ttf "$APP_ROOT/Contents/Resources/Fonts/"
cp -R \
  "$SCRIPT_DIR/Sources/JesseCompanion/Resources/FluentIcons" \
  "$APP_ROOT/Contents/Resources/FluentIcons"

if [[ "${JESSE_SKIP_SERVICE_BUNDLE:-0}" != "1" ]]; then
  NODE_BINARY="${JESSE_NODE_BINARY:-$(command -v node)}"
  if [[ -z "$NODE_BINARY" || ! -x "$NODE_BINARY" ]]; then
    echo "A Node 22 executable is required to bundle AgentService." >&2
    exit 1
  fi
  mkdir -p "$SERVICE_ROOT/runtime" "$SERVICE_ROOT/dist" "$SERVICE_ROOT/web"
  cp -L "$NODE_BINARY" "$SERVICE_ROOT/runtime/node"
  NODE_ARCHS="$(lipo -archs "$SERVICE_ROOT/runtime/node")"
  if [[ "$NODE_ARCHS" == *"arm64"* && "$NODE_ARCHS" == *" "* ]]; then
    lipo \
      "$SERVICE_ROOT/runtime/node" \
      -thin arm64 \
      -output "$SERVICE_ROOT/runtime/node.arm64"
    mv "$SERVICE_ROOT/runtime/node.arm64" "$SERVICE_ROOT/runtime/node"
  fi
  chmod 755 "$SERVICE_ROOT/runtime/node"
  cp -R "$PROJECT_ROOT/dist/." "$SERVICE_ROOT/dist/"
  find "$SERVICE_ROOT/dist" -type f \( \
    -name '*.map' -o \
    -name '*.test.js' -o \
    -name '*.vsix' \
  \) -delete
  cp -R "$PROJECT_ROOT/desktop-app/dist/." "$SERVICE_ROOT/web/"
  cp "$PROJECT_ROOT/package.json" "$PROJECT_ROOT/package-lock.json" "$SERVICE_ROOT/"
  cp -R "$PROJECT_ROOT/node_modules" "$SERVICE_ROOT/node_modules"
fi

if [[ -n "${JESSE_CODESIGN_IDENTITY:-}" ]]; then
  if [[ -x "$SERVICE_ROOT/runtime/node" ]]; then
    codesign --force --sign "$JESSE_CODESIGN_IDENTITY" "$SERVICE_ROOT/runtime/node"
  fi
  codesign --force --deep --sign "$JESSE_CODESIGN_IDENTITY" "$APP_ROOT"
else
  if [[ -x "$SERVICE_ROOT/runtime/node" ]]; then
    codesign --force --sign - "$SERVICE_ROOT/runtime/node"
  fi
  # Keep the designated requirement stable so local rebuilds retain TCC permissions.
  codesign \
    --force \
    --deep \
    --sign - \
    --requirements '=designated => identifier "com.jesse.agent.companion"' \
    "$APP_ROOT"
fi
plutil -lint "$APP_ROOT/Contents/Info.plist"
codesign --verify --deep --strict "$APP_ROOT"
zsh "$SCRIPT_DIR/verify-app.sh" "$APP_ROOT"
echo "$APP_ROOT"
