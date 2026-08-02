# Jesse Agent VS Code Extension

First IDE slice for the local Jesse Agent core.

## Run In VS Code

1. Open this folder in VS Code:

   ```bash
   code /Users/jesselai/Desktop/JesseAgent/jesse-agent/vscode-extension
   ```

2. Press `F5` to start an Extension Development Host.

3. In the Extension Development Host, open the project you want Jesse Agent to inspect.

4. Run one of these commands from the Command Palette:

   - `Jesse Agent: Open Chat`
   - `Jesse Agent: Ask About Selection`
   - `Jesse Agent: Ask About Current File`
   - `Jesse Agent: Select Workspace`

By default, requests use `permissionMode=default`. Read-only tools run directly; file edits and other non-read-only tools show an approval card in the Jesse Agent panel before execution.

The chat panel shows a run timeline while the agent works. File edits show an approval card with a diff, and approved `write_file` / `edit_file` calls are summarized at the end of the run.

## Workspace And History

Jesse Agent is workspace-first. History is read from the current workspace's `.jesse/sessions` directory, so different projects keep separate session lists. In a multi-root VS Code window, use `Jesse Agent: Select Workspace` or the `Change` link in the panel to choose which workspace the agent should use.

## Settings

- `jesseAgent.agentRoot`: path to the `jesse-agent` project root. Leave empty for auto-detect during local development.
- `jesseAgent.permissionMode`: `plan`, `default`, or `acceptEdits`. Use `default` for IDE approval cards; `plan` stays read-only; `acceptEdits` skips project-local edit approvals. Reject will stop the current agent run and will not keep asking about the same rejected tool call.
- `jesseAgent.devMode`: show internal developer controls for health, eval, raw diff, and compact. Keep this off for normal use.

## Package

From the repository root:

```bash
npm run package:vscode
```

The packaged extension is written to `dist/jesse-agent-vscode-0.0.5.vsix`.

## Architecture

The extension starts:

```text
npm run ide:server
```

from the Jesse Agent root. `src/ideServer.ts` stays running on `127.0.0.1`, streams JSONL events for `POST /ask`, and accepts `POST /approval` when the user approves or rejects a pending tool request. The one-shot `npm run ide` bridge remains available for scripts and debugging.
