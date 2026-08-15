# Jesse Agent agent instructions

For every user-visible visual change, load and follow [`.agents/skills/visual-qa/SKILL.md`](.agents/skills/visual-qa/SKILL.md) before reporting completion. This includes layout, typography, icons, colors, materials, hover/selected/menu states, and interaction visuals in the macOS App or Web client.

Codex itself must capture and inspect a live screenshot of the freshly packaged app in the changed state before calling a visual change complete; never ask the user to perform that acceptance check. If screenshot capture is unavailable, state the blocker instead of claiming visual verification.
