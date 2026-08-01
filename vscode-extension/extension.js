const cp = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const vscode = require('vscode')

let chatPanel = null

function activate(context) {
  context.subscriptions.push(
    vscode.commands.registerCommand('jesseAgent.openChat', () => openChat(context)),
    vscode.commands.registerCommand('jesseAgent.askSelection', () => askSelection(context)),
    vscode.commands.registerCommand('jesseAgent.askCurrentFile', () => askCurrentFile(context)),
  )
}

function deactivate() {}

function openChat(context) {
  const panel = ensureChatPanel(context)
  panel.reveal(vscode.ViewColumn.Beside)
}

async function askSelection(context) {
  const editor = vscode.window.activeTextEditor
  if (!editor || editor.selection.isEmpty) {
    vscode.window.showInformationMessage('Select code first, then run Jesse Agent: Ask About Selection.')
    return
  }

  const prompt = await vscode.window.showInputBox({
    title: 'Ask Jesse Agent about the selection',
    prompt: 'What should Jesse Agent do with the selected code?',
    value: 'Explain this selected code and point out any risks.',
  })
  if (!prompt) return

  const panel = ensureChatPanel(context)
  panel.reveal(vscode.ViewColumn.Beside)
  await runPromptFromEditor(context, prompt, { includeSelection: true })
}

async function askCurrentFile(context) {
  const editor = vscode.window.activeTextEditor
  if (!editor) {
    vscode.window.showInformationMessage('Open a file first, then run Jesse Agent: Ask About Current File.')
    return
  }

  const prompt = await vscode.window.showInputBox({
    title: 'Ask Jesse Agent about the current file',
    prompt: 'What should Jesse Agent do with the current file?',
    value: 'Summarize this file and explain the most important code paths.',
  })
  if (!prompt) return

  const panel = ensureChatPanel(context)
  panel.reveal(vscode.ViewColumn.Beside)
  await runPromptFromEditor(context, prompt, { includeSelection: false })
}

function ensureChatPanel(context) {
  if (chatPanel) return chatPanel

  chatPanel = vscode.window.createWebviewPanel(
    'jesseAgentChat',
    'Jesse Agent',
    vscode.ViewColumn.Beside,
    { enableScripts: true, retainContextWhenHidden: true },
  )
  chatPanel.webview.html = renderChatHtml(chatPanel.webview)
  chatPanel.onDidDispose(() => {
    chatPanel = null
  })

  chatPanel.webview.onDidReceiveMessage(async message => {
    if (message?.type === 'ask') {
      await runPromptFromEditor(context, String(message.prompt || ''), { includeSelection: true })
    }
  })

  return chatPanel
}

async function runPromptFromEditor(context, prompt, options) {
  if (!prompt.trim()) return

  const panel = ensureChatPanel(context)
  const editorContext = collectEditorContext(options)
  panel.webview.postMessage({ type: 'user', text: prompt, context: summarizeContext(editorContext) })

  try {
    await runAgentBridge(context, {
      prompt,
      context: editorContext,
      permissionMode: getPermissionMode(),
      maxTurns: 8,
    }, output => {
      panel.webview.postMessage(output)
    })
  } catch (error) {
    panel.webview.postMessage({ type: 'error', text: error instanceof Error ? error.message : String(error) })
  }
}

function collectEditorContext(options) {
  const editor = vscode.window.activeTextEditor
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
  if (!editor) return { workspaceRoot }

  const document = editor.document
  const activeFile = document.uri.scheme === 'file' ? document.uri.fsPath : undefined
  const selectedText = options.includeSelection && !editor.selection.isEmpty
    ? document.getText(editor.selection)
    : undefined
  const diagnostics = activeFile ? formatDiagnostics(document.uri) : undefined

  return {
    workspaceRoot,
    activeFile,
    activeFileLanguage: document.languageId,
    selectedText,
    diagnostics,
  }
}

function formatDiagnostics(uri) {
  const diagnostics = vscode.languages.getDiagnostics(uri).slice(0, 20)
  if (diagnostics.length === 0) return undefined
  return diagnostics.map(item => {
    const start = item.range.start
    const severity = ['Error', 'Warning', 'Information', 'Hint'][item.severity] || 'Diagnostic'
    return `${severity} ${start.line + 1}:${start.character + 1} ${item.message}`
  }).join('\n')
}

function summarizeContext(context) {
  const parts = []
  if (context.workspaceRoot) parts.push(`workspace: ${context.workspaceRoot}`)
  if (context.activeFile) parts.push(`file: ${context.activeFile}`)
  if (context.selectedText) parts.push(`${context.selectedText.length} selected chars`)
  if (context.diagnostics) parts.push('diagnostics attached')
  return parts.join(' | ')
}

function getPermissionMode() {
  return vscode.workspace.getConfiguration('jesseAgent').get('permissionMode', 'plan')
}

function runAgentBridge(context, request, onOutput) {
  return new Promise((resolve, reject) => {
    const agentRoot = resolveAgentRoot(context)
    if (!agentRoot) {
      reject(new Error('Could not find jesse-agent root. Set jesseAgent.agentRoot in VS Code settings.'))
      return
    }

    const child = cp.spawn(npmCommand(), ['run', 'ide', '--silent'], {
      cwd: agentRoot,
      env: { ...process.env, FORCE_COLOR: '0' },
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    let stdoutBuffer = ''
    let stderrText = ''

    child.stdout.on('data', chunk => {
      stdoutBuffer += chunk.toString('utf8')
      const lines = stdoutBuffer.split('\n')
      stdoutBuffer = lines.pop() || ''
      for (const line of lines) {
        if (!line.trim()) continue
        try {
          onOutput(mapBridgeOutput(JSON.parse(line)))
        } catch (error) {
          onOutput({ type: 'log', text: line })
        }
      }
    })

    child.stderr.on('data', chunk => {
      stderrText += chunk.toString('utf8')
    })

    child.on('error', reject)
    child.on('close', code => {
      if (stdoutBuffer.trim()) {
        try {
          onOutput(mapBridgeOutput(JSON.parse(stdoutBuffer.trim())))
        } catch {
          onOutput({ type: 'log', text: stdoutBuffer.trim() })
        }
      }
      if (code === 0) {
        resolve()
      } else {
        reject(new Error(stderrText.trim() || `Jesse Agent bridge exited with code ${code}`))
      }
    })

    child.stdin.end(JSON.stringify(request))
  })
}

function mapBridgeOutput(output) {
  if (output.type === 'ready') return { type: 'status', text: `Connected (${output.permissionMode})` }
  if (output.type === 'done') return { type: 'done', text: `Done. Messages: ${output.messageCount}` }
  if (output.type === 'error') return { type: 'error', text: output.error }
  if (output.type !== 'agent_event') return { type: 'log', text: JSON.stringify(output) }

  const event = output.event
  if (event.type === 'assistant_delta') return { type: 'assistantDelta', text: event.text }
  if (event.type === 'assistant_text') return { type: 'assistantText', text: event.text }
  if (event.type === 'turn_start') return { type: 'status', text: `Turn ${event.turn}` }
  if (event.type === 'tool_start') return { type: 'tool', text: `Tool: ${event.name}` }
  if (event.type === 'tool_result') return { type: 'tool', text: `Tool result: ${event.name} ${event.ok ? 'ok' : 'error'} (${event.content.length} chars)` }
  if (event.type === 'max_turns') return { type: 'error', text: 'Reached max turns.' }
  if (event.type === 'error') return { type: 'error', text: event.reason }
  return { type: 'log', text: JSON.stringify(event) }
}

function resolveAgentRoot(context) {
  const configured = vscode.workspace.getConfiguration('jesseAgent').get('agentRoot', '')
  const candidates = [
    configured,
    vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
    path.resolve(context.extensionPath, '..'),
  ].filter(Boolean)

  for (const candidate of candidates) {
    if (hasIdeBridge(candidate)) return candidate
  }
  return undefined
}

function hasIdeBridge(root) {
  return fs.existsSync(path.join(root, 'package.json')) && fs.existsSync(path.join(root, 'src', 'ideBridge.ts'))
}

function npmCommand() {
  return process.platform === 'win32' ? 'npm.cmd' : 'npm'
}

function renderChatHtml(webview) {
  const nonce = String(Date.now())
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
  <title>Jesse Agent</title>
  <style>
    body { margin: 0; padding: 16px; font-family: var(--vscode-font-family); color: var(--vscode-foreground); background: var(--vscode-editor-background); }
    .messages { display: flex; flex-direction: column; gap: 12px; padding-bottom: 96px; }
    .msg { border: 1px solid var(--vscode-panel-border); border-radius: 6px; padding: 10px 12px; white-space: pre-wrap; overflow-wrap: anywhere; }
    .user { background: var(--vscode-input-background); }
    .assistant { background: var(--vscode-editor-inactiveSelectionBackground); }
    .tool, .status, .error, .log { font-size: 12px; color: var(--vscode-descriptionForeground); }
    .error { color: var(--vscode-errorForeground); }
    .composer { position: fixed; left: 0; right: 0; bottom: 0; padding: 12px 16px; background: var(--vscode-editor-background); border-top: 1px solid var(--vscode-panel-border); }
    textarea { box-sizing: border-box; width: 100%; min-height: 64px; resize: vertical; color: var(--vscode-input-foreground); background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border); padding: 8px; font-family: var(--vscode-font-family); }
    button { margin-top: 8px; color: var(--vscode-button-foreground); background: var(--vscode-button-background); border: none; padding: 6px 12px; cursor: pointer; }
    button:hover { background: var(--vscode-button-hoverBackground); }
    .context { margin-top: 6px; color: var(--vscode-descriptionForeground); font-size: 11px; }
  </style>
</head>
<body>
  <div id="messages" class="messages"></div>
  <div class="composer">
    <textarea id="prompt" placeholder="Ask Jesse Agent about the current file or selection..."></textarea>
    <button id="ask">Ask</button>
  </div>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const messages = document.getElementById('messages');
    const prompt = document.getElementById('prompt');
    let currentAssistant = null;

    document.getElementById('ask').addEventListener('click', () => ask());
    prompt.addEventListener('keydown', event => {
      if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) ask();
    });

    function ask() {
      const text = prompt.value.trim();
      if (!text) return;
      prompt.value = '';
      currentAssistant = null;
      vscode.postMessage({ type: 'ask', prompt: text });
    }

    window.addEventListener('message', event => {
      const message = event.data;
      if (message.type === 'user') addMessage('user', message.text, message.context);
      if (message.type === 'assistantDelta') appendAssistant(message.text);
      if (message.type === 'assistantText' && !currentAssistant) addMessage('assistant', message.text);
      if (message.type === 'tool') addMessage('tool', message.text);
      if (message.type === 'status') addMessage('status', message.text);
      if (message.type === 'done') addMessage('status', message.text);
      if (message.type === 'error') addMessage('error', message.text);
      if (message.type === 'log') addMessage('log', message.text);
    });

    function appendAssistant(text) {
      if (!currentAssistant) currentAssistant = addMessage('assistant', '');
      currentAssistant.firstChild.textContent += text;
      window.scrollTo(0, document.body.scrollHeight);
    }

    function addMessage(kind, text, context) {
      const item = document.createElement('div');
      item.className = 'msg ' + kind;
      const body = document.createElement('div');
      body.textContent = text;
      item.appendChild(body);
      if (context) {
        const meta = document.createElement('div');
        meta.className = 'context';
        meta.textContent = context;
        item.appendChild(meta);
      }
      messages.appendChild(item);
      window.scrollTo(0, document.body.scrollHeight);
      return item;
    }
  </script>
</body>
</html>`
}

module.exports = { activate, deactivate }
