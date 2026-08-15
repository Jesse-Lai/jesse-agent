---
name: visual-qa
description: Enforce agent-owned screenshot-based visual QA for Jesse Agent UI work. Use for every change that affects rendered macOS or Web UI, including layout, spacing, typography, icon size, color, materials, hover/selected/menu states, animations, and interaction visuals; require Codex to capture and inspect a live screenshot itself before reporting completion to the user.
---

# Jesse Agent Visual QA Gate

Treat a visual change as incomplete until the changed state has been captured from the freshly built product and inspected against the user's reference or stated acceptance criteria.

## Required workflow

1. Extract the observable acceptance criteria before editing: target surface, state (default, hover, selected, open menu, scrolling, etc.), reference image, and any requested measurements.
2. Implement the smallest scoped change. Do not substitute code values or unit-test assertions for visual evidence.
3. Quit the prior `com.jesse.agent.companion` process, then run the relevant tests and package the exact Mac app the user will open. Never rebuild a bundle in place while it is running, because macOS can retain stale executable metadata:

   ```zsh
   cd /Users/jesselai/Desktop/JesseAgent/jesse-agent
   osascript -e 'tell application id "com.jesse.agent.companion" to quit'
   npm run companion:package
   ```

4. Launch `macos/JesseCompanion/build/Jesse Agent.app` and confirm its running executable path is inside that freshly packaged bundle. Do not inspect an older running bundle.
5. Put the live product into the exact state being changed. For transient UI, capture every relevant state while it is visible: for example, hover a row before capturing hover, and leave a native menu open before capturing its menu.
6. Capture a live image with `scripts/capture-jesse-ui.sh`. Use `--screen --keep-focus` for popovers, menus, hover states, and anything that would disappear when the app is activated. Save each artifact under `/private/tmp/jesse-visual-qa/` with a meaningful feature and state name.
7. Use the image-viewing tool to open and inspect the image yourself. Compare it directly with the supplied screenshot or Web reference. Check the requested visual property and nearby alignment, clipping, spacing, contrast, and state behavior. Do not delegate this check to the user.
8. If the screenshot is wrong, iterate from step 2. Only report the result after the final screenshot is correct.

## Evidence and handoff

In the final handoff, state the exact state you inspected and link or embed the final screenshot when practical. Mention relevant test results separately. Never claim that a UI change is visually verified merely because it compiled, packaged, or passed a source-level test. The user may review the result, but is never responsible for the acceptance check.

If a live screenshot cannot be produced because Screen Recording or Accessibility permission is unavailable, stop before claiming the visual work is done. Report that specific blocker and request the needed permission. A bitmap rendered in a unit test is supplemental evidence only; it cannot verify native menus, system materials, hover treatment, or the running app bundle.

## Native UI constraints

- Use macOS-native material and glass APIs for native glass/edge effects when requested; do not imitate them with a fixed-color gradient, mask, or synthetic shadow.
- Validate actual drawn size for icons, not only the SwiftUI source frame: native menu rendering may transform source labels.
- Preserve unrelated dirty working-tree changes. Do not reset, clean, or overwrite files outside the requested visual scope.
