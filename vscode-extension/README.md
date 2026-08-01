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

By default, requests use `permissionMode=plan`, so this first slice is read-only and cannot block on terminal confirmations.

## Settings

- `jesseAgent.agentRoot`: path to the `jesse-agent` project root. Leave empty for auto-detect during local development.
- `jesseAgent.permissionMode`: `plan`, `default`, or `acceptEdits`. Keep `plan` for the current prototype.

## Architecture

The extension calls:

```text
npm run ide
```

from the Jesse Agent root and sends a JSON request over stdin. `src/ideBridge.ts` streams JSONL events back over stdout. The bridge reuses the existing agent core instead of driving the terminal REPL.
