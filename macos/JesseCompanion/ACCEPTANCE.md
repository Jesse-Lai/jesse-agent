# Jesse Agent for macOS Acceptance

## Implemented scope

- Global `Option-J` hotkey with `Option-Space` fallback and a cursor-adjacent multi-display panel.
- AppKit system shell with a native SwiftUI main window plus the nonactivating command-ring `NSPanel`.
- macOS 26 Liquid Glass for the command ring and popovers, with system typography, SF Symbols, adaptive light/dark appearance, native hover states, edge highlights, and restrained shadows.
- Selection capture through Accessibility with clipboard-preserving fallback.
- Active Chrome/Safari URL capture through Accessibility with an Apple Events fallback; no browser extension is required.
- Do Anything creates a persistent full-Agent Chat Session with its own execution workspace, live tool progress, approvals, scoped stop control, and a deep link into the same Session in the native main window.
- Follow-up turns from the shortcut or Web reuse the same Session history and workspace; hiding the shortcut never cancels the server-side run.
- Polish, translate, summarize, and question actions with streaming results.
- Interactive region screenshot through ScreenCaptureKit; pixels are sent directly to the multimodal model without OCR.
- Large Retina selections are downscaled proportionally to a 4096-pixel maximum dimension before upload.
- Responses image-generation tool, PNG result shelf, clipboard copy, and insertion after the original selection.
- Image insertion collapses an opaque rich-text selection to its end when the editor does not expose an Accessibility range, avoiding replacement of the source paragraph.
- Automatic writeback only while the original app, element, text, and range still match.
- Text and image writeback revalidate the original selection after returning to the source app; failed tasks can never be written back.
- Per-task original target retention; a later invocation cannot redirect an old result into the new cursor location.
- Persistent recent results and generated-image files; interrupted tasks become failed results after restart.
- Quick-task progress plus full Jesse Agent busy/approval/session status.
- Task status refreshes every two seconds while the progress surface is visible; concurrent stream updates do not steal the active result surface.
- Menu bar controls, permission entry point, app icon, launch-at-login toggle, and a native UI with no WebView. Browser assets are bundled only for the separately rendered Web client.

## Automated evidence

```bash
npm run typecheck
npm run desktop:build
npm run test:quick
cd macos/JesseCompanion
xcodebuild -scheme JesseCompanion -destination 'platform=macOS' \
  -derivedDataPath .derivedData-tests test
cd ../..
npm run companion:package
codesign --verify --deep --strict 'macos/JesseCompanion/build/Jesse Agent.app'
otool -L 'macos/JesseCompanion/build/Jesse Agent.app/Contents/MacOS/JesseCompanion'
```

The latest verification passed all 83 native Swift tests, 38 service tests, and 6 Web tests. Coverage includes the shared protocol fixture, persistent Run/SSE startup and cursor reconnection, run-scoped approval and cancellation, product-data migration, attachment limits and clipboard images, login-item window policy, Session deep links, Markdown code/table parsing, direct multimodal image payloads, native streaming, model errors, SwiftUI state transitions, nonactivating-panel focus, result persistence, ring placement, multi-display screenshot coordinates, and large Retina capture sizing.

Native QA must verify the main project/session window, conversation composer,
approval cards, output inspector, command ring, result detail, recent results,
and task progress surfaces in light and dark mode. Browser assets live under
`Contents/Resources/AgentService/web`; the native executable must not link
WebKit and must never render those assets in-process.

## System-gated verification

These checks require the final app to be granted macOS permissions and cannot be automated before the user grants them:

1. Open the final app and grant Accessibility from the inline authorization button.
2. Select text in Teams and WeChat; verify polish replaces the selection without sending the message.
3. Start a transform, switch apps, then use Recent Results to return to the original target or copy when it changed.
4. Use Screenshot, grant Screen Recording, drag a region, and verify multimodal analysis.
5. Select a Notion paragraph, generate an image, and verify it inserts after the paragraph when unchanged.
6. Toggle launch at login from the menu bar and verify the displayed shortcut after the next login (`Option-J`, or `Option-Space` when it is occupied).
7. Verify first-click button activation, text focus, Enter/Shift-Enter behavior, Escape, panel dragging, outside-click dismissal, and result-height changes on each native surface.
8. From a Chrome GitHub page, open Do Anything and verify the URL context card appears without an extension; start a task, close the panel, and verify the same Session continues in JesseAgent Web.

The final artifact is `macos/JesseCompanion/build/Jesse Agent.app` and is ad-hoc signed for this Mac. It contains a signed Node runtime, compiled Agent Service, and browser client, and must start without a repository checkout or system Node/npm.
