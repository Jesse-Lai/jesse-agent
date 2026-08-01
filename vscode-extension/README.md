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

By default, requests use `permissionMode=default`. Read-only tools run directly; file edits and other non-read-only tools show an approval card in the Jesse Agent panel before execution.

## Settings

- `jesseAgent.agentRoot`: path to the `jesse-agent` project root. Leave empty for auto-detect during local development.
- `jesseAgent.permissionMode`: `plan`, `default`, or `acceptEdits`. Use `default` for IDE approval cards; `plan` stays read-only; `acceptEdits` skips project-local edit approvals. Reject will stop the current agent run and will not keep asking about the same rejected tool call.

## Architecture

The extension starts:

```text
npm run ide:server
```

from the Jesse Agent root. `src/ideServer.ts` stays running on `127.0.0.1`, streams JSONL events for `POST /ask`, and accepts `POST /approval` when the user approves or rejects a pending tool request. The one-shot `npm run ide` bridge remains available for scripts and debugging.
