#!/bin/zsh
# Capture a live Jesse Agent UI state for the mandatory visual-QA gate.
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: capture-jesse-ui.sh --output /absolute/path.png [--screen] [--keep-focus]

  Default: capture the Jesse Agent main window only.
  --screen: capture display 1, required for native menus/popovers/hover states.
  --keep-focus: do not activate Jesse Agent before capture; use with transient UI.
EOF
}

output=""
screen_capture=0
keep_focus=0

while (( $# > 0 )); do
  case "$1" in
    --output)
      (( $# >= 2 )) || { usage >&2; exit 64; }
      output="$2"
      shift 2
      ;;
    --screen)
      screen_capture=1
      shift
      ;;
    --keep-focus)
      keep_focus=1
      shift
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      print -u2 "Unknown option: $1"
      usage >&2
      exit 64
      ;;
  esac
done

[[ -n "$output" ]] || { usage >&2; exit 64; }
[[ "$output" = /* ]] || { print -u2 "--output must be an absolute path"; exit 64; }
[[ "$output" = *.png ]] || { print -u2 "--output must end in .png"; exit 64; }

mkdir -p "${output:h}"

if (( ! keep_focus )); then
  osascript -e 'tell application id "com.jesse.agent.companion" to activate'
  sleep 1
fi

if (( screen_capture )); then
  screencapture -x -D 1 "$output"
else
  window_number="$(osascript <<'APPLESCRIPT'
tell application "System Events"
  set targetProcess to first application process whose bundle identifier is "com.jesse.agent.companion"
  tell targetProcess
    set frontWindow to window 1
    return value of attribute "AXWindowNumber" of frontWindow
  end tell
end tell
APPLESCRIPT
)"
  [[ "$window_number" = <-> ]] || {
    print -u2 "Could not resolve the Jesse Agent window number. Use --screen for menu/popover capture."
    exit 1
  }
  screencapture -x -l "$window_number" "$output"
fi

[[ -s "$output" ]] || { print -u2 "Screen capture did not produce an image: $output"; exit 1; }
sips -g pixelWidth -g pixelHeight "$output" >/dev/null
print "Captured live Jesse Agent UI: $output"
