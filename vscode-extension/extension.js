const cp = require('node:child_process')
const fs = require('node:fs')
const http = require('node:http')
const path = require('node:path')
const vscode = require('vscode')

let chatPanel = null
let ideServer = null
let ideServerStartPromise = null
let chatMessages = []
let currentSessionId = null
let runInProgress = false

function activate(context) {
  context.subscriptions.push(
    vscode.commands.registerCommand('jesseAgent.openChat', () => openChat(context)),
    vscode.commands.registerCommand('jesseAgent.askSelection', () => askSelection(context)),
    vscode.commands.registerCommand('jesseAgent.askCurrentFile', () => askCurrentFile(context)),
    vscode.commands.registerCommand('jesseAgent.explainDiagnostics', () => explainDiagnostics(context)),
    vscode.commands.registerCommand('jesseAgent.fixDiagnostics', () => fixDiagnostics(context)),
    vscode.commands.registerCommand('jesseAgent.reviewChanges', () => reviewChanges(context)),
  )
}

function deactivate() {
  if (ideServer?.process) ideServer.process.kill()
  ideServer = null
  ideServerStartPromise = null
}

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

async function explainDiagnostics(context) {
  const editor = vscode.window.activeTextEditor
  if (!editor) {
    vscode.window.showInformationMessage('Open a file first, then run Jesse Agent: Explain Diagnostics.')
    return
  }

  const diagnostics = vscode.languages.getDiagnostics(editor.document.uri)
  if (diagnostics.length === 0) {
    vscode.window.showInformationMessage('No diagnostics in the current file.')
    return
  }

  const panel = ensureChatPanel(context)
  panel.reveal(vscode.ViewColumn.Beside)
  await runPromptFromEditor(context, 'Explain the diagnostics in the current file. Identify the likely root cause and suggest the smallest safe fix. Do not edit files yet.', { includeSelection: false })
}

async function fixDiagnostics(context) {
  const editor = vscode.window.activeTextEditor
  if (!editor) {
    vscode.window.showInformationMessage('Open a file first, then run Jesse Agent: Fix Diagnostics.')
    return
  }

  const diagnostics = vscode.languages.getDiagnostics(editor.document.uri)
  if (diagnostics.length === 0) {
    vscode.window.showInformationMessage('No diagnostics in the current file.')
    return
  }

  const panel = ensureChatPanel(context)
  panel.reveal(vscode.ViewColumn.Beside)
  await runPromptFromEditor(context, 'Fix the diagnostics in the current file. Read the relevant code first, make the smallest safe edit, then verify if a local check command is obvious.', { includeSelection: false })
}

async function reviewChanges(context) {
  const panel = ensureChatPanel(context)
  panel.reveal(vscode.ViewColumn.Beside)
  await runPromptFromEditor(context, 'Review the current git changes in this workspace. Start with git status and git diff. Focus on bugs, regressions, risky assumptions, and missing tests. Do not edit files unless I explicitly ask.', { includeSelection: false })
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
  setTimeout(() => {
    chatPanel?.webview.postMessage({
      type: 'serverState',
      workspaceRoot: workspaceRequest().workspaceRoot,
      sessionId: currentSessionId,
    })
  }, 0)
  chatPanel.onDidDispose(() => {
    chatPanel = null
  })

  chatPanel.webview.onDidReceiveMessage(async message => {
    if (message?.type === 'ask') {
      await runPromptFromEditor(context, String(message.prompt || ''), { includeSelection: true })
      return
    }

    if (message?.type === 'approval') {
      await submitApproval(context, message)
      return
    }

    if (message?.type === 'newSession') {
      await newSession(context)
      return
    }

    if (message?.type === 'showSessions') {
      await showSessions(context)
      return
    }

    if (message?.type === 'resumeSession') {
      await resumeSession(context, String(message.sessionId || ''))
      return
    }

    if (message?.type === 'cancel') {
      await cancelRun(context)
      return
    }

    if (message?.type === 'openFile') {
      await openFileFromWebview(message)
    }
  })

  return chatPanel
}

async function runPromptFromEditor(context, prompt, options) {
  if (!prompt.trim()) return
  if (runInProgress) {
    chatPanel?.webview.postMessage({ type: 'error', text: 'A Jesse Agent run is already in progress. Stop it or wait for it to finish.' })
    return
  }

  const panel = ensureChatPanel(context)
  const editorContext = collectEditorContext(options)
  panel.webview.postMessage({ type: 'user', text: prompt, context: summarizeContext(editorContext) })
  panel.webview.postMessage({ type: 'runState', state: 'running' })
  runInProgress = true

  try {
    const result = await runAgentBridge(context, {
      prompt,
      context: editorContext,
      permissionMode: getPermissionMode(),
      maxTurns: 8,
      sessionId: currentSessionId || undefined,
    }, output => {
      panel.webview.postMessage(output)
      if (output.sessionId) currentSessionId = output.sessionId
    })
    if (result.assistantText.trim()) {
      chatMessages.push({ role: 'user', content: prompt })
      chatMessages.push({ role: 'assistant', content: result.assistantText.trim() })
      chatMessages = chatMessages.slice(-12)
    }
  } catch (error) {
    panel.webview.postMessage({ type: 'error', text: error instanceof Error ? error.message : String(error) })
  } finally {
    runInProgress = false
    panel.webview.postMessage({ type: 'runState', state: 'idle' })
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
  return vscode.workspace.getConfiguration('jesseAgent').get('permissionMode', 'default')
}

async function runAgentBridge(context, request, onOutput) {
  const server = await ensureIdeServer(context)
  return await postAgentRequest(server, request, onOutput)
}

async function submitApproval(context, message) {
  const id = String(message.approvalId || '')
  const choice = String(message.choice || '')
  if (!id || !isApprovalChoice(choice)) return

  try {
    const server = await ensureIdeServer(context)
    await postApprovalRequest(server, { id, choice })
    chatPanel?.webview.postMessage({ type: 'approvalSubmitted', id, choice })
  } catch (error) {
    chatPanel?.webview.postMessage({ type: 'error', text: error instanceof Error ? error.message : String(error) })
  }
}

async function newSession(context) {
  try {
    const server = await ensureIdeServer(context)
    const result = await postJson(server, '/session/new', workspaceRequest())
    loadSessionIntoPanel(result, 'New chat started')
  } catch (error) {
    chatPanel?.webview.postMessage({ type: 'error', text: error instanceof Error ? error.message : String(error) })
  }
}

async function resumeSession(context, sessionId) {
  try {
    const server = await ensureIdeServer(context)
    const result = await postJson(server, '/session/resume', { ...workspaceRequest(), sessionId: sessionId || undefined })
    loadSessionIntoPanel(result, sessionId ? 'Session resumed' : 'Latest session resumed')
  } catch (error) {
    chatPanel?.webview.postMessage({ type: 'error', text: error instanceof Error ? error.message : String(error) })
  }
}

async function showSessions(context) {
  try {
    const server = await ensureIdeServer(context)
    const workspaceRoot = encodeURIComponent(workspaceRequest().workspaceRoot || '')
    const result = await getJson(server, `/sessions?limit=20&workspaceRoot=${workspaceRoot}`)
    chatPanel?.webview.postMessage({ type: 'sessions', sessions: Array.isArray(result.sessions) ? result.sessions : [] })
  } catch (error) {
    chatPanel?.webview.postMessage({ type: 'error', text: error instanceof Error ? error.message : String(error) })
  }
}

async function cancelRun(context) {
  try {
    const server = await ensureIdeServer(context)
    await postJson(server, '/cancel', {})
    chatPanel?.webview.postMessage({ type: 'status', text: 'Cancel requested.' })
  } catch (error) {
    chatPanel?.webview.postMessage({ type: 'error', text: error instanceof Error ? error.message : String(error) })
  }
}

async function openFileFromWebview(message) {
  const filePath = String(message.filePath || '')
  if (!filePath) return
  const line = Number.isInteger(message.line) ? message.line : Number(message.line || 0)
  const column = Number.isInteger(message.column) ? message.column : Number(message.column || 0)
  const resolved = resolveWorkspacePath(filePath)
  try {
    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(resolved))
    const editor = await vscode.window.showTextDocument(document, { preview: false })
    if (line > 0) {
      const position = new vscode.Position(Math.max(0, line - 1), Math.max(0, column - 1))
      editor.selection = new vscode.Selection(position, position)
      editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenter)
    }
  } catch (error) {
    vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error))
  }
}

function loadSessionIntoPanel(result, label) {
  currentSessionId = typeof result.sessionId === 'string' ? result.sessionId : null
  chatMessages = Array.isArray(result.messages) ? result.messages.slice(-12) : []
  chatPanel?.webview.postMessage({
    type: 'sessionLoaded',
    label,
    sessionId: currentSessionId,
    messageCount: result.messageCount,
    messages: Array.isArray(result.messages) ? result.messages : [],
    workspaceRoot: result.workspaceRoot,
  })
}

function workspaceRequest() {
  return { workspaceRoot: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath }
}

function resolveWorkspacePath(filePath) {
  if (path.isAbsolute(filePath)) return filePath
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
  return workspaceRoot ? path.join(workspaceRoot, filePath) : filePath
}

function isApprovalChoice(value) {
  return value === 'allow_once' || value === 'allow_for_session' || value === 'reject_once'
}

async function ensureIdeServer(context) {
  if (ideServer?.port && ideServer.process.exitCode === null) return Promise.resolve(ideServer)
  if (ideServerStartPromise) return ideServerStartPromise

  ideServerStartPromise = new Promise((resolve, reject) => {
    const agentRoot = resolveAgentRoot(context)
    if (!agentRoot) {
      reject(new Error('Could not find jesse-agent root. Set jesseAgent.agentRoot in VS Code settings.'))
      return
    }

    const child = cp.spawn(npmCommand(), ['run', 'ide:server', '--silent'], {
      cwd: agentRoot,
      env: { ...process.env, FORCE_COLOR: '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    let stdoutBuffer = ''
    let stderrText = ''
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error(stderrText.trim() || 'Timed out starting Jesse Agent server.'))
    }, 15_000)

    child.stdout.on('data', chunk => {
      stdoutBuffer += chunk.toString('utf8')
      const lines = stdoutBuffer.split('\n')
      stdoutBuffer = lines.pop() || ''
      for (const line of lines) {
        if (!line.trim()) continue
        try {
          const message = JSON.parse(line)
          if (message.type === 'server_ready') {
            clearTimeout(timer)
            ideServer = { process: child, host: message.host || '127.0.0.1', port: message.port, agentRoot }
            resolve(ideServer)
          }
        } catch (error) {
          // Keep waiting for a valid ready message.
        }
      }
    })

    child.stderr.on('data', chunk => {
      stderrText += chunk.toString('utf8')
    })

    child.on('error', error => {
      clearTimeout(timer)
      reject(error)
    })
    child.on('close', code => {
      clearTimeout(timer)
      if (ideServer?.process === child) ideServer = null
      ideServerStartPromise = null
      if (!ideServer && code !== 0) {
        reject(new Error(stderrText.trim() || `Jesse Agent bridge exited with code ${code}`))
      }
    })
  })

  try {
    return await ideServerStartPromise
  } finally {
    ideServerStartPromise = null
  }
}

function postAgentRequest(server, request, onOutput) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(request)
    const httpRequest = http.request({
      host: server.host,
      port: server.port,
      path: '/ask',
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body),
      },
    }, response => {
      let buffer = ''
      let errorBody = ''
      let assistantDeltaText = ''
      let assistantFinalText = ''

      response.on('data', chunk => {
        const text = chunk.toString('utf8')
        if (response.statusCode !== 200) {
          errorBody += text
          return
        }

        buffer += text
        const lines = buffer.split('\n')
        buffer = lines.pop() || ''
        for (const line of lines) {
          if (!line.trim()) continue
          try {
            const output = JSON.parse(line)
            const event = output.type === 'agent_event' ? output.event : null
            if (event?.type === 'assistant_delta') assistantDeltaText += event.text
            if (event?.type === 'assistant_text') assistantFinalText = event.text
            onOutput(mapBridgeOutput(output))
          } catch {
            onOutput({ type: 'log', text: line })
          }
        }
      })

      response.on('end', () => {
        if (response.statusCode !== 200) {
          reject(new Error(parseHttpError(errorBody) || `Jesse Agent server returned HTTP ${response.statusCode}`))
          return
        }
        if (buffer.trim()) {
          try {
            const output = JSON.parse(buffer.trim())
            const event = output.type === 'agent_event' ? output.event : null
            if (event?.type === 'assistant_delta') assistantDeltaText += event.text
            if (event?.type === 'assistant_text') assistantFinalText = event.text
            onOutput(mapBridgeOutput(output))
          } catch {
            onOutput({ type: 'log', text: buffer.trim() })
          }
        }
        resolve({ assistantText: assistantFinalText || assistantDeltaText })
      })
    })

    httpRequest.on('error', error => {
      ideServer = null
      reject(error)
    })
    httpRequest.end(body)
  })
}

function postApprovalRequest(server, request) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(request)
    const httpRequest = http.request({
      host: server.host,
      port: server.port,
      path: '/approval',
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body),
      },
    }, response => {
      let responseBody = ''
      response.on('data', chunk => {
        responseBody += chunk.toString('utf8')
      })
      response.on('end', () => {
        if (response.statusCode !== 200) {
          reject(new Error(parseHttpError(responseBody) || `Jesse Agent approval returned HTTP ${response.statusCode}`))
          return
        }
        resolve()
      })
    })

    httpRequest.on('error', reject)
    httpRequest.end(body)
  })
}

function postJson(server, route, request = {}) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(request)
    const httpRequest = http.request({
      host: server.host,
      port: server.port,
      path: route,
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body),
      },
    }, response => {
      let responseBody = ''
      response.on('data', chunk => {
        responseBody += chunk.toString('utf8')
      })
      response.on('end', () => {
        if (response.statusCode !== 200) {
          reject(new Error(parseHttpError(responseBody) || `Jesse Agent server returned HTTP ${response.statusCode}`))
          return
        }
        try {
          resolve(responseBody.trim() ? JSON.parse(responseBody) : {})
        } catch (error) {
          reject(error)
        }
      })
    })

    httpRequest.on('error', reject)
    httpRequest.end(body)
  })
}

function getJson(server, route) {
  return new Promise((resolve, reject) => {
    const httpRequest = http.request({
      host: server.host,
      port: server.port,
      path: route,
      method: 'GET',
    }, response => {
      let responseBody = ''
      response.on('data', chunk => {
        responseBody += chunk.toString('utf8')
      })
      response.on('end', () => {
        if (response.statusCode !== 200) {
          reject(new Error(parseHttpError(responseBody) || `Jesse Agent server returned HTTP ${response.statusCode}`))
          return
        }
        try {
          resolve(responseBody.trim() ? JSON.parse(responseBody) : {})
        } catch (error) {
          reject(error)
        }
      })
    })

    httpRequest.on('error', reject)
    httpRequest.end()
  })
}

function parseHttpError(body) {
  try {
    const value = JSON.parse(body)
    return value.error
  } catch {
    return body.trim()
  }
}

function mapBridgeOutput(output) {
  if (output.type === 'ready') {
    return {
      type: 'serverState',
      state: 'running',
      text: `Connected (${output.permissionMode})`,
      sessionId: output.sessionId,
      messageCount: output.messageCount,
      workspaceRoot: output.workspaceRoot,
      cwd: output.cwd,
      permissionMode: output.permissionMode,
    }
  }
  if (output.type === 'approval_request') return { type: 'approvalRequest', request: output.request }
  if (output.type === 'approval_response') return { type: 'approvalResolved', id: output.id, choice: output.choice }
  if (output.type === 'done') return {
    type: 'done',
    text: `${output.cancelled ? 'Cancelled' : 'Done'}. Messages: ${output.messageCount}`,
    sessionId: output.sessionId,
    messageCount: output.messageCount,
    cancelled: output.cancelled === true,
  }
  if (output.type === 'error') return { type: 'error', text: output.error }
  if (output.type !== 'agent_event') return { type: 'log', text: JSON.stringify(output) }

  const event = output.event
  if (event.type === 'assistant_delta') return { type: 'assistantDelta', text: event.text }
  if (event.type === 'assistant_text') return { type: 'assistantText', text: event.text }
  if (event.type === 'turn_start') return { type: 'status', text: `Turn ${event.turn}` }
  if (event.type === 'tool_start') return { type: 'toolStart', name: event.name, args: event.args }
  if (event.type === 'tool_result') return { type: 'toolResult', name: event.name, ok: event.ok, content: event.content }
  if (event.type === 'max_turns') return { type: 'error', text: 'Reached max turns.' }
  if (event.type === 'error') {
    const text = normalizeAgentError(event.reason)
    return isAbortLikeError(text) ? { type: 'status', text } : { type: 'error', text }
  }
  return { type: 'log', text: JSON.stringify(event) }
}

function normalizeAgentError(reason) {
  return isAbortLikeError(reason) ? 'Run cancelled by user.' : String(reason || 'Unknown agent error')
}

function isAbortLikeError(reason) {
  const normalized = String(reason || '').toLowerCase()
  return normalized.includes('cancelled') || normalized.includes('canceled') || normalized.includes('aborted')
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
    .toolbar { position: sticky; top: 0; z-index: 2; display: flex; gap: 6px; flex-wrap: wrap; padding-bottom: 10px; background: var(--vscode-editor-background); border-bottom: 1px solid var(--vscode-panel-border); }
    .toolbar button, .composer-actions button { margin-top: 0; padding: 5px 9px; }
    .workspace-strip { display: grid; gap: 3px; margin: 10px 0 12px; color: var(--vscode-descriptionForeground); font-size: 11px; }
    .workspace-strip strong { color: var(--vscode-foreground); font-weight: 600; }
    .messages { display: flex; flex-direction: column; gap: 12px; padding-bottom: 118px; }
    .msg { border: 1px solid var(--vscode-panel-border); border-radius: 6px; padding: 10px 12px; white-space: pre-wrap; overflow-wrap: anywhere; }
    .user { background: var(--vscode-input-background); }
    .assistant { background: var(--vscode-editor-inactiveSelectionBackground); }
    .tool, .status, .error, .log { font-size: 12px; color: var(--vscode-descriptionForeground); }
    .tool-card details, .sessions-card details { margin: 0; }
    .tool-card summary, .sessions-card summary { cursor: pointer; user-select: none; font-weight: 600; }
    .tool-result { max-height: 220px; overflow: auto; margin-top: 8px; padding: 8px; border: 1px solid var(--vscode-panel-border); background: var(--vscode-editor-background); white-space: pre-wrap; font-family: var(--vscode-editor-font-family); font-size: var(--vscode-editor-font-size); }
    .link-button { color: var(--vscode-textLink-foreground); background: none; border: 0; padding: 0; margin: 0; cursor: pointer; font: inherit; text-align: left; }
    .link-button:hover { text-decoration: underline; background: none; }
    .session-row { display: grid; gap: 3px; padding: 8px 0; border-top: 1px solid var(--vscode-panel-border); }
    .session-row:first-of-type { border-top: 0; }
    .session-meta { color: var(--vscode-descriptionForeground); font-size: 11px; }
    .session-preview { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .error { color: var(--vscode-errorForeground); }
    .approval { border-color: var(--vscode-editorWarning-foreground); background: var(--vscode-input-background); }
    .approval.resolved { border-color: var(--vscode-panel-border); opacity: 0.78; }
    .approval.resolved .approval-actions { display: none; }
    .approval-title { font-weight: 600; margin-bottom: 6px; }
    .approval-meta { color: var(--vscode-descriptionForeground); font-size: 12px; margin-bottom: 10px; }
    .approval-summary { display: inline-flex; gap: 10px; align-items: center; margin-bottom: 10px; color: var(--vscode-descriptionForeground); font-size: 12px; }
    .approval-summary .added { color: var(--vscode-gitDecoration-addedResourceForeground); }
    .approval-summary .deleted { color: var(--vscode-gitDecoration-deletedResourceForeground); }
    .approval-raw { margin: 8px 0 10px; color: var(--vscode-descriptionForeground); }
    .approval-raw summary { cursor: pointer; user-select: none; font-size: 12px; }
    .approval-detail { max-height: 180px; overflow: auto; margin: 8px 0 0; padding: 8px; border: 1px solid var(--vscode-panel-border); background: var(--vscode-editor-background); white-space: pre; font-family: var(--vscode-editor-font-family); font-size: var(--vscode-editor-font-size); color: var(--vscode-foreground); }
    .approval-review { border: 1px solid var(--vscode-panel-border); background: var(--vscode-editor-background); margin: 8px 0 12px; max-height: 360px; overflow: auto; }
    .review-file-header { padding: 7px 10px; border-bottom: 1px solid var(--vscode-panel-border); background: var(--vscode-sideBar-background); font-size: 12px; font-weight: 600; }
    .diff-table { width: 100%; overflow: auto; font-family: var(--vscode-editor-font-family); font-size: var(--vscode-editor-font-size); }
    .diff-row { display: grid; grid-template-columns: 42px 42px 18px minmax(0, 1fr); min-height: 20px; line-height: 20px; }
    .diff-row.add { background: rgba(46, 160, 67, 0.18); }
    .diff-row.del { background: rgba(248, 81, 73, 0.18); }
    .diff-row.hunk { color: var(--vscode-textLink-foreground); background: var(--vscode-editor-lineHighlightBackground); }
    .diff-row.truncated { color: var(--vscode-descriptionForeground); font-style: italic; }
    .diff-line-no, .diff-sign { color: var(--vscode-descriptionForeground); text-align: right; padding: 0 6px; user-select: none; }
    .diff-code { white-space: pre-wrap; overflow-wrap: anywhere; padding-right: 10px; }
    .approval-actions { display: flex; gap: 8px; flex-wrap: wrap; }
    .approval-actions button.reject { background: var(--vscode-inputValidation-errorBackground); color: var(--vscode-button-foreground); }
    .approval-status { margin-top: 8px; color: var(--vscode-descriptionForeground); font-size: 12px; }
    .composer { position: fixed; left: 0; right: 0; bottom: 0; padding: 12px 16px; background: var(--vscode-editor-background); border-top: 1px solid var(--vscode-panel-border); }
    textarea { box-sizing: border-box; width: 100%; min-height: 64px; resize: vertical; color: var(--vscode-input-foreground); background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border); padding: 8px; font-family: var(--vscode-font-family); }
    button { margin-top: 8px; color: var(--vscode-button-foreground); background: var(--vscode-button-background); border: none; padding: 6px 12px; cursor: pointer; }
    button:hover { background: var(--vscode-button-hoverBackground); }
    button:disabled { opacity: 0.65; cursor: default; }
    .composer-actions { display: flex; gap: 8px; align-items: center; margin-top: 8px; }
    .composer-actions .stop { background: var(--vscode-inputValidation-errorBackground); }
    .context { margin-top: 6px; color: var(--vscode-descriptionForeground); font-size: 11px; }
  </style>
</head>
<body>
  <div class="toolbar">
    <button id="new-chat">New Chat</button>
    <button id="sessions">History</button>
  </div>
  <div class="workspace-strip">
    <div><strong>Workspace</strong>: <span id="workspace">detecting...</span></div>
    <div><strong>Session</strong>: <span id="session">none</span> · <strong>Status</strong>: <span id="run-status">idle</span></div>
  </div>
  <div id="messages" class="messages"></div>
  <div class="composer">
    <textarea id="prompt" placeholder="Ask Jesse Agent about the current file or selection..."></textarea>
    <div class="composer-actions">
      <button id="ask">Ask</button>
    </div>
  </div>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const messages = document.getElementById('messages');
    const prompt = document.getElementById('prompt');
    const askButton = document.getElementById('ask');
    const workspaceLabel = document.getElementById('workspace');
    const sessionLabel = document.getElementById('session');
    const runStatus = document.getElementById('run-status');
    let currentAssistant = null;
    let lastToolCard = null;
    let isRunning = false;

    askButton.addEventListener('click', () => isRunning ? vscode.postMessage({ type: 'cancel' }) : ask());
    document.getElementById('new-chat').addEventListener('click', () => vscode.postMessage({ type: 'newSession' }));
    document.getElementById('sessions').addEventListener('click', () => vscode.postMessage({ type: 'showSessions' }));
    prompt.addEventListener('keydown', event => {
      if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && !isRunning) ask();
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
      if (message.type === 'serverState') updateServerState(message);
      if (message.type === 'runState') setRunState(message.state);
      if (message.type === 'sessionLoaded') loadSession(message);
      if (message.type === 'sessions') addSessions(message.sessions || []);
      if (message.type === 'approvalRequest') addApproval(message.request);
      if (message.type === 'approvalSubmitted') markApproval(message.id, 'Submitted: ' + labelChoice(message.choice));
      if (message.type === 'approvalResolved') markApproval(message.id, 'Resolved: ' + labelChoice(message.choice));
      if (message.type === 'toolStart') addToolStart(message.name, message.args);
      if (message.type === 'toolResult') addToolResult(message.name, message.ok, message.content);
      if (message.type === 'status') addMessage('status', message.text);
      if (message.type === 'done') {
        finalizeAssistantLinks();
        updateServerState(message);
        addMessage('status', message.text);
      }
      if (message.type === 'error') addMessage('error', message.text);
      if (message.type === 'log') addMessage('log', message.text);
    });

    function appendAssistant(text) {
      if (!currentAssistant) currentAssistant = addMessage('assistant', '');
      currentAssistant.firstChild.textContent += text;
      window.scrollTo(0, document.body.scrollHeight);
    }

    function finalizeAssistantLinks() {
      const body = currentAssistant?.firstChild;
      if (!body) return;
      const text = body.textContent || '';
      body.textContent = '';
      renderLinkedText(body, text);
    }

    function updateServerState(message) {
      if (message.workspaceRoot) workspaceLabel.textContent = message.workspaceRoot;
      if (message.cwd && !message.workspaceRoot) workspaceLabel.textContent = message.cwd;
      if (message.sessionId) sessionLabel.textContent = message.sessionId + (message.messageCount ? ' · ' + message.messageCount + ' messages' : '');
    }

    function setRunState(state) {
      isRunning = state === 'running';
      runStatus.textContent = isRunning ? 'running' : 'idle';
      askButton.textContent = isRunning ? 'Stop' : 'Ask';
      askButton.classList.toggle('stop', isRunning);
      prompt.disabled = isRunning;
    }

    function loadSession(message) {
      messages.textContent = '';
      currentAssistant = null;
      lastToolCard = null;
      updateServerState(message);
      addMessage('status', message.label + ': ' + (message.sessionId || 'new session'));
      for (const item of message.messages || []) addMessage(item.role, item.content);
    }

    function addSessions(sessions) {
      const item = document.createElement('div');
      item.className = 'msg sessions-card';
      const title = document.createElement('div');
      title.className = 'approval-title';
      title.textContent = sessions.length ? 'Recent Sessions' : 'No sessions found';
      item.appendChild(title);
      for (const session of sessions) {
        const row = document.createElement('div');
        row.className = 'session-row';
        const button = document.createElement('button');
        button.className = 'link-button';
        button.textContent = session.title || session.lastUserMessage || 'Untitled session';
        button.addEventListener('click', () => vscode.postMessage({ type: 'resumeSession', sessionId: session.id }));
        row.appendChild(button);
        const meta = document.createElement('div');
        meta.className = 'session-meta';
        meta.textContent = [session.updatedAt, (session.messageCount || 0) + ' messages'].filter(Boolean).join(' · ');
        row.appendChild(meta);
        if (session.lastUserMessage) {
          const last = document.createElement('div');
          last.className = 'session-preview';
          last.textContent = session.lastUserMessage;
          row.appendChild(last);
        }
        item.appendChild(row);
      }
      messages.appendChild(item);
      window.scrollTo(0, document.body.scrollHeight);
    }

    function addToolStart(name, args) {
      const item = document.createElement('div');
      item.className = 'msg tool tool-card';
      const details = document.createElement('details');
      const summary = document.createElement('summary');
      summary.textContent = 'Tool: ' + name;
      details.appendChild(summary);
      const input = document.createElement('pre');
      input.className = 'tool-result';
      input.textContent = previewJson(args);
      details.appendChild(input);
      item.appendChild(details);
      messages.appendChild(item);
      lastToolCard = { name, details };
      window.scrollTo(0, document.body.scrollHeight);
    }

    function addToolResult(name, ok, content) {
      const target = lastToolCard && lastToolCard.name === name ? lastToolCard.details : null;
      if (!target) {
        addMessage('tool', 'Tool result: ' + name + ' ' + (ok ? 'ok' : 'error') + ' (' + String(content || '').length + ' chars)');
        return;
      }
      const result = document.createElement('pre');
      result.className = 'tool-result';
      result.textContent = (ok ? 'ok' : 'error') + '\\n' + previewText(content || '', 1200);
      target.appendChild(result);
      target.querySelector('summary').textContent = 'Tool: ' + name + ' · ' + (ok ? 'ok' : 'error') + ' · ' + String(content || '').length + ' chars';
      window.scrollTo(0, document.body.scrollHeight);
    }

    function addApproval(request) {
      const item = document.createElement('div');
      item.className = 'msg approval';
      item.dataset.approvalId = request.id;

      const title = document.createElement('div');
      title.className = 'approval-title';
      title.textContent = request.title || ('Approve ' + request.toolName);
      item.appendChild(title);

      const meta = document.createElement('div');
      meta.className = 'approval-meta';
      meta.textContent = request.files && request.files.length ? 'Files: ' + request.files.join(', ') : 'Tool: ' + request.toolName;
      item.appendChild(meta);

      if (request.previewError) {
        const previewError = document.createElement('div');
        previewError.className = 'error';
        previewError.textContent = 'Preview warning: ' + request.previewError;
        item.appendChild(previewError);
      }

      if (!request.diff && request.args && request.args.command) {
        item.appendChild(createCommandReview(request.args));
      }

      if (request.diff) {
        item.appendChild(createDiffSummary(request.diff, request.files));
        item.appendChild(createDiffReview(request.diff, request.files));
      }

      if (request.detail) {
        const raw = document.createElement('details');
        raw.className = 'approval-raw';
        const summary = document.createElement('summary');
        summary.textContent = 'Tool request details';
        raw.appendChild(summary);
        const detail = document.createElement('pre');
        detail.className = 'approval-detail';
        detail.textContent = request.detail;
        raw.appendChild(detail);
        item.appendChild(raw);
      }

      const actions = document.createElement('div');
      actions.className = 'approval-actions';
      actions.appendChild(approvalButton('Allow once', 'allow_once', request.id));
      actions.appendChild(approvalButton('Allow for session', 'allow_for_session', request.id));
      actions.appendChild(approvalButton('Reject', 'reject_once', request.id, 'reject'));
      item.appendChild(actions);

      const status = document.createElement('div');
      status.className = 'approval-status';
      status.textContent = 'Waiting for approval';
      item.appendChild(status);

      messages.appendChild(item);
      window.scrollTo(0, document.body.scrollHeight);
    }

    function createDiffSummary(diffText, files) {
      const counts = countDiffLines(diffText);
      const summary = document.createElement('div');
      summary.className = 'approval-summary';
      const fileCount = files && files.length ? files.length : Math.max(1, counts.files);
      summary.appendChild(textSpan(fileCount + ' file' + (fileCount === 1 ? '' : 's')));
      summary.appendChild(textSpan('+' + counts.added, 'added'));
      summary.appendChild(textSpan('-' + counts.deleted, 'deleted'));
      return summary;
    }

    function createDiffReview(diffText, files) {
      const review = document.createElement('div');
      review.className = 'approval-review';
      const lines = String(diffText || '').split('\\n');
      let currentFile = null;
      let table = null;
      let oldLine = 0;
      let newLine = 0;
      let pendingOldPath = files && files[0] ? files[0] : 'changes';

      for (const line of lines) {
        if (line.startsWith('--- ')) {
          pendingOldPath = cleanDiffPath(line.slice(4));
          continue;
        }
        if (line.startsWith('+++ ')) {
          currentFile = cleanDiffPath(line.slice(4)) || pendingOldPath;
          table = appendDiffFile(review, currentFile);
          continue;
        }
        if (!table) table = appendDiffFile(review, currentFile || pendingOldPath);

        if (line.startsWith('@@')) {
          const hunk = parseHunkHeader(line);
          if (hunk) {
            oldLine = hunk.oldStart;
            newLine = hunk.newStart;
          }
          appendDiffRow(table, 'hunk', '', '', '', line);
          continue;
        }

        if (line === '... diff truncated ...' || line === '(no content changes)') {
          appendDiffRow(table, 'truncated', '', '', '', line);
          continue;
        }

        const prefix = line[0] || ' ';
        const content = line.length > 0 ? line.slice(1) : '';
        if (prefix === '+') {
          appendDiffRow(table, 'add', '', String(newLine), '+', content);
          newLine += 1;
        } else if (prefix === '-') {
          appendDiffRow(table, 'del', String(oldLine), '', '-', content);
          oldLine += 1;
        } else {
          appendDiffRow(table, 'context', String(oldLine), String(newLine), '', prefix === ' ' ? content : line);
          oldLine += 1;
          newLine += 1;
        }
      }

      return review;
    }

    function appendDiffFile(review, filePath) {
      const header = document.createElement('div');
      header.className = 'review-file-header';
      const button = document.createElement('button');
      button.className = 'link-button';
      button.textContent = filePath || 'changes';
      button.addEventListener('click', () => vscode.postMessage({ type: 'openFile', filePath }));
      header.appendChild(button);
      review.appendChild(header);
      const table = document.createElement('div');
      table.className = 'diff-table';
      review.appendChild(table);
      return table;
    }

    function createCommandReview(args) {
      const block = document.createElement('div');
      block.className = 'approval-review';
      const header = document.createElement('div');
      header.className = 'review-file-header';
      header.textContent = 'Shell command';
      block.appendChild(header);
      const command = document.createElement('pre');
      command.className = 'tool-result';
      command.textContent = String(args.command || '');
      block.appendChild(command);
      if (args.cwd) {
        const cwd = document.createElement('div');
        cwd.className = 'approval-meta';
        cwd.textContent = 'cwd: ' + args.cwd;
        block.appendChild(cwd);
      }
      return block;
    }

    function appendDiffRow(table, kind, oldNo, newNo, sign, code) {
      const row = document.createElement('div');
      row.className = 'diff-row ' + kind;
      row.appendChild(lineCell(oldNo));
      row.appendChild(lineCell(newNo));
      const signCell = document.createElement('div');
      signCell.className = 'diff-sign';
      signCell.textContent = sign;
      row.appendChild(signCell);
      const codeCell = document.createElement('div');
      codeCell.className = 'diff-code';
      codeCell.textContent = code;
      row.appendChild(codeCell);
      table.appendChild(row);
    }

    function lineCell(text) {
      const cell = document.createElement('div');
      cell.className = 'diff-line-no';
      cell.textContent = text;
      return cell;
    }

    function textSpan(text, className) {
      const span = document.createElement('span');
      if (className) span.className = className;
      span.textContent = text;
      return span;
    }

    function countDiffLines(diffText) {
      const counts = { files: 0, added: 0, deleted: 0 };
      for (const line of String(diffText || '').split('\\n')) {
        if (line.startsWith('+++ ')) counts.files += 1;
        else if (line.startsWith('+')) counts.added += 1;
        else if (line.startsWith('-') && !line.startsWith('--- ')) counts.deleted += 1;
      }
      return counts;
    }

    function parseHunkHeader(line) {
      const match = /^@@ -(\\d+)(?:,\\d+)? \\+(\\d+)(?:,\\d+)? @@/.exec(line);
      if (!match) return null;
      return { oldStart: Number(match[1]), newStart: Number(match[2]) };
    }

    function cleanDiffPath(path) {
      return String(path || '').replace(/^[ab]\\//, '').trim();
    }

    function approvalButton(label, choice, approvalId, extraClass) {
      const button = document.createElement('button');
      button.textContent = label;
      if (extraClass) button.className = extraClass;
      button.addEventListener('click', () => {
        setApprovalButtonsDisabled(approvalId, true);
        markApproval(approvalId, 'Submitting: ' + labelChoice(choice));
        vscode.postMessage({ type: 'approval', approvalId, choice });
      });
      return button;
    }

    function setApprovalButtonsDisabled(id, disabled) {
      const item = document.querySelector('[data-approval-id="' + id + '"]');
      if (!item) return;
      item.querySelectorAll('button').forEach(button => { button.disabled = disabled; });
    }

    function markApproval(id, text) {
      const item = document.querySelector('[data-approval-id="' + id + '"]');
      if (!item) return;
      item.classList.add('resolved');
      item.querySelectorAll('button').forEach(button => { button.disabled = true; });
      const status = item.querySelector('.approval-status');
      if (status) status.textContent = text;
    }

    function labelChoice(choice) {
      if (choice === 'allow_once') return 'Allow once';
      if (choice === 'allow_for_session') return 'Allow for session';
      if (choice === 'reject_once') return 'Reject';
      return String(choice || 'unknown');
    }

    function addMessage(kind, text, context) {
      const item = document.createElement('div');
      item.className = 'msg ' + kind;
      const body = document.createElement('div');
      renderLinkedText(body, text || '');
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

    function renderLinkedText(container, text) {
      const pattern = new RegExp('((?:\\\\/|\\\\.\\\\/|\\\\.\\\\.\\\\/)?[A-Za-z0-9_@.\\\\/-]+\\\\.(?:ts|tsx|js|jsx|json|md|css|html|py|sh|yml|yaml))(?:[:#](\\\\d+))?', 'g');
      let lastIndex = 0;
      let match;
      while ((match = pattern.exec(text)) !== null) {
        if (match.index > lastIndex) container.appendChild(document.createTextNode(text.slice(lastIndex, match.index)));
        const filePath = match[1];
        const line = match[2] ? Number(match[2]) : undefined;
        const button = document.createElement('button');
        button.className = 'link-button';
        button.textContent = match[0];
        button.addEventListener('click', () => vscode.postMessage({ type: 'openFile', filePath, line }));
        container.appendChild(button);
        lastIndex = pattern.lastIndex;
      }
      if (lastIndex < text.length) container.appendChild(document.createTextNode(text.slice(lastIndex)));
    }

    function previewJson(value) {
      try {
        return previewText(JSON.stringify(value, null, 2), 1400);
      } catch {
        return String(value);
      }
    }

    function previewText(value, maxChars) {
      const text = String(value || '');
      if (text.length <= maxChars) return text;
      return text.slice(0, maxChars) + '... (' + text.length + ' chars total)';
    }
  </script>
</body>
</html>`
}

module.exports = { activate, deactivate }
