import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { flushSync } from 'react-dom'
import { getJson, postJson, requestJson, streamRun } from './api'
import { AsciiCurtain, type AsciiCurtainHandle } from './components/AsciiCurtain'
import { Composer } from './components/Composer'
import { Conversation } from './components/Conversation'
import { DailyChangelog } from './components/DailyChangelog'
import { hasOutputsRailContent, OutputsRail } from './components/OutputsRail'
import { RunProgress } from './components/RunProgress'
import { Sidebar, type ThemeMode } from './components/Sidebar'
import { Splitter } from './components/Splitter'
import { WorkspaceHeader } from './components/WorkspaceHeader'
import {
  asRecord,
  formatActivity,
  labelChoice,
  stringArg,
} from './presentation'
import { projectRowAction } from './projectInteraction'
import { dequeuePrompt, enqueuePrompt, MAX_QUEUED_PROMPTS } from './queuedPrompts'
import type {
  ActivityItem,
  AgentRunEnvelope,
  AgentRunSnapshot,
  AgentEvent,
  ApprovalChoice,
  ApprovalRequest,
  BridgeOutput,
  CommandOutput,
  ComposerAnnotation,
  ComposerImageAttachment,
  ConversationItem,
  DesktopProject,
  DailyChangelogSummary,
  OutputFile,
  PendingApproval,
  QueuedComposerItem,
  ImageAttachment,
  RunStep,
  SessionMessage,
  SessionWorkspaceMetadata,
  SessionSummary,
  SourceItem,
  ToolInProgress,
} from './types'

let itemSequence = 0

interface RunConversationTarget {
  clientId: string
  key: string
  projectPath: string
  scope: ConversationScope
  runId?: string
  assistantId: string | null
  assistantText: string
  activityId: string | null
  currentTool: ToolInProgress | null
  userMessageId?: string
}

type DesktopPermissionMode = 'default' | 'plan'
type ConversationScope = 'project' | 'chat'

type ActivityInput = Omit<ActivityItem, 'id' | 'createdAt' | 'status'> & { status?: ActivityItem['status'] }

export function App() {
  const [autoThemeMode, setAutoThemeMode] = useState<ThemeMode>(() => themeModeForCurrentTime())
  const [manualThemeMode, setManualThemeMode] = useState<ThemeMode | null>(null)
  const [projects, setProjects] = useState<DesktopProject[]>([])
  const [chatWorkspaceRoot, setChatWorkspaceRootState] = useState('')
  const [activeScope, setActiveScopeState] = useState<ConversationScope>(readStoredConversationScope)
  const [activeProject, setActiveProject] = useState(() => localStorage.getItem('jesse.activeProject') || '')
  const [expandedProjects, setExpandedProjectsState] = useState(readStoredExpandedProjects)
  const [sessionsByProject, setSessionsByProject] = useState<Map<string, SessionSummary[]>>(() => new Map())
  const [openProjectMenu, setOpenProjectMenu] = useState('')
  const [sessionId, setSessionIdState] = useState<string | null>(null)
  const [activeSessionTitle, setActiveSessionTitle] = useState('')
  const [activeSessionWorkspace, setActiveSessionWorkspace] = useState<SessionWorkspaceMetadata | null>(null)
  const [activeConversationKey, setActiveConversationKeyState] = useState(() => conversationKey(readStoredConversationScope(), activeProject, null))
  const [activeRunRevision, setActiveRunRevision] = useState(0)
  const [draft, setDraft] = useState('')
  const [queuedPrompts, setQueuedPrompts] = useState<QueuedComposerItem[]>([])
  const [queueStatus, setQueueStatus] = useState('')
  const [queueingEnabled, setQueueingEnabled] = useState(true)
  const [permissionMode, setPermissionModeState] = useState<DesktopPermissionMode>(() => readStoredPermissionMode())
  const [composerAnnotations, setComposerAnnotations] = useState<ComposerAnnotation[]>([])
  const [composerAttachments, setComposerAttachments] = useState<ComposerImageAttachment[]>([])
  const [conversation, setConversation] = useState<ConversationItem[]>([])
  const [outputFiles, setOutputFiles] = useState<OutputFile[]>([])
  const [commandOutputs, setCommandOutputs] = useState<CommandOutput[]>([])
  const [sourceItems, setSourceItems] = useState<SourceItem[]>([])
  const [runSteps, setRunSteps] = useState<RunStep[]>(() => createRunSteps())
  const [showRunProgress, setShowRunProgress] = useState(false)
  const [pendingApproval, setPendingApproval] = useState<PendingApproval | null>(null)
  const [dailyChangelogs, setDailyChangelogs] = useState<DailyChangelogSummary[]>([])
  const [changelogProject, setChangelogProject] = useState('')
  const [changelogLoading, setChangelogLoading] = useState(false)

  const activeProjectRef = useRef(activeProject)
  const chatWorkspaceRootRef = useRef(chatWorkspaceRoot)
  const activeScopeRef = useRef(activeScope)
  const expandedProjectsRef = useRef(expandedProjects)
  const sessionIdRef = useRef(sessionId)
  const activeConversationKeyRef = useRef(activeConversationKey)
  const draftRef = useRef(draft)
  const queuedPromptsRef = useRef<QueuedComposerItem[]>(queuedPrompts)
  const queueAdvancePendingRef = useRef(false)
  const permissionModeRef = useRef(permissionMode)
  const composerAnnotationsRef = useRef<ComposerAnnotation[]>(composerAnnotations)
  const composerAttachmentsRef = useRef<ComposerImageAttachment[]>(composerAttachments)
  const activeRunTargetsRef = useRef<Map<string, RunConversationTarget>>(new Map())
  const runTargetsByRunIdRef = useRef<Map<string, RunConversationTarget>>(new Map())
  const locallyStreamedRunIdsRef = useRef<Set<string>>(new Set())
  const approvalRequestsRef = useRef<Map<string, { request: ApprovalRequest; target: RunConversationTarget }>>(new Map())
  const backgroundEventsRef = useRef<Map<string, AgentRunEnvelope[]>>(new Map())
  const backgroundRunsRef = useRef<Map<string, AgentRunSnapshot>>(new Map())
  const backgroundEventKeysRef = useRef<Set<string>>(new Set())
  const sessionBootstrapRef = useRef<Promise<string> | null>(null)
  const sessionRefreshTimersRef = useRef<Map<string, number>>(new Map())
  const changelogRequestRef = useRef(0)
  const asciiCurtainRef = useRef<AsciiCurtainHandle>(null)
  const composerRef = useRef<HTMLFormElement>(null)
  const themeMode = manualThemeMode ?? autoThemeMode
  void activeRunRevision
  const activeConversationRuns = [...activeRunTargetsRef.current.values()]
    .filter(target => target.key === activeConversationKey)
  const running = activeConversationRuns.length > 0

  useEffect(() => {
    void initializeDesktop()
  }, [])

  useEffect(() => {
    if (activeScope !== 'project' || !activeProject) {
      changelogRequestRef.current += 1
      setDailyChangelogs([])
      setChangelogProject('')
      setChangelogLoading(false)
      return
    }
    void loadDailyChangelogs(activeProject)
  }, [activeProject, activeScope])

  useEffect(() => {
    if (activeScope !== 'project' || !activeProject) return
    const refresh = () => {
      if (document.visibilityState === 'visible') void loadDailyChangelogs(activeProject)
    }
    const timer = window.setInterval(refresh, 60_000)
    window.addEventListener('focus', refresh)
    return () => {
      window.clearInterval(timer)
      window.removeEventListener('focus', refresh)
    }
  }, [activeProject, activeScope])

  useEffect(() => {
    let cancelled = false
    let events: EventSource | null = null
    const onRun = (rawEvent: Event) => {
      if (!(rawEvent instanceof MessageEvent) || typeof rawEvent.data !== 'string') return
      try {
        receiveBackgroundEnvelope(JSON.parse(rawEvent.data) as AgentRunEnvelope)
      } catch {
        // A malformed event must not break later reconnects.
      }
    }

    void (async () => {
      let cursor = 0
      try {
        const snapshot = await getJson<{ cursor?: number; runs?: AgentRunSnapshot[] }>('/api/runs')
        if (cancelled) return
        cursor = Number.isSafeInteger(snapshot.cursor) && (snapshot.cursor ?? 0) >= 0 ? snapshot.cursor ?? 0 : 0
        for (const run of snapshot.runs ?? []) {
          backgroundRunsRef.current.set(run.id, run)
          scheduleSessionRefresh(run.workspaceRoot)
        }
      } catch {
        // A newly launched local service may still be starting. EventSource
        // retries on its own, and a fresh service has no in-memory replay log.
      }
      if (cancelled) return
      events = new EventSource(`/api/runs/events?after=${cursor}`)
      events.addEventListener('run', onRun)
    })()

    return () => {
      cancelled = true
      events?.removeEventListener('run', onRun)
      events?.close()
      for (const timer of sessionRefreshTimersRef.current.values()) window.clearTimeout(timer)
      sessionRefreshTimersRef.current.clear()
    }
  }, [])

  useEffect(() => {
    const updateAutoTheme = () => setAutoThemeMode(themeModeForCurrentTime())
    updateAutoTheme()
    const timer = window.setInterval(updateAutoTheme, 60_000)
    return () => window.clearInterval(timer)
  }, [])

  useLayoutEffect(() => {
    document.documentElement.dataset.theme = themeMode
  }, [themeMode])

  const setActiveProjectValue = (value: string) => {
    activeProjectRef.current = value
    setActiveProject(value)
  }

  const setChatWorkspaceRoot = (value: string) => {
    chatWorkspaceRootRef.current = value
    setChatWorkspaceRootState(value)
  }

  const setActiveScope = (value: ConversationScope) => {
    activeScopeRef.current = value
    setActiveScopeState(value)
    localStorage.setItem('jesse.activeScope', value)
  }

  const setSessionId = (value: string | null) => {
    sessionIdRef.current = value
    setSessionIdState(value)
  }

  const setActiveConversationKey = (value: string) => {
    activeConversationKeyRef.current = value
    setActiveConversationKeyState(value)
    refreshVisibleApproval(value)
  }

  const setDraftValue = (value: string) => {
    draftRef.current = value
    setDraft(value)
  }

  const setQueuedPromptsValue = (value: QueuedComposerItem[]) => {
    queuedPromptsRef.current = value
    setQueuedPrompts(value)
  }

  const setPermissionModeValue = (value: DesktopPermissionMode) => {
    permissionModeRef.current = value
    setPermissionModeState(value)
    localStorage.setItem('jesse.permissionMode', value)
  }

  const setComposerAnnotationsValue = (value: ComposerAnnotation[]) => {
    composerAnnotationsRef.current = value
    setComposerAnnotations(value)
  }

  const setComposerAttachmentsValue = (value: ComposerImageAttachment[]) => {
    composerAttachmentsRef.current = value
    setComposerAttachments(value)
  }

  const resetConversationRuntimeState = () => {
    setOutputFiles([])
    setCommandOutputs([])
    setSourceItems([])
    setQueuedPromptsValue([])
    queueAdvancePendingRef.current = false
    setQueueStatus('')
    setQueueingEnabled(true)
    setComposerAnnotationsValue([])
    setComposerAttachmentsValue([])
    setRunSteps(createRunSteps())
    setShowRunProgress(false)
    setPendingApproval(null)
  }

  function createRunTarget(
    scope: ConversationScope,
    projectPath: string,
    key = activeConversationKeyRef.current,
  ): RunConversationTarget {
    return {
      clientId: nextItemId('client-run'),
      key,
      projectPath,
      scope,
      assistantId: null,
      assistantText: '',
      activityId: null,
      currentTool: null,
    }
  }

  function registerRunTarget(target: RunConversationTarget) {
    activeRunTargetsRef.current.set(target.clientId, target)
    if (target.runId) runTargetsByRunIdRef.current.set(target.runId, target)
    setActiveRunRevision(value => value + 1)
  }

  function bindRunTarget(target: RunConversationTarget, run: AgentRunSnapshot) {
    target.runId = run.id
    backgroundRunsRef.current.set(run.id, run)
    runTargetsByRunIdRef.current.set(run.id, target)
    registerRunTarget(target)
  }

  function finishRunTarget(target: RunConversationTarget) {
    activeRunTargetsRef.current.delete(target.clientId)
    if (target.runId) runTargetsByRunIdRef.current.delete(target.runId)
    for (const [approvalId, entry] of approvalRequestsRef.current) {
      if (entry.target === target) approvalRequestsRef.current.delete(approvalId)
    }
    refreshVisibleApproval()
    setActiveRunRevision(value => value + 1)
  }

  function refreshVisibleApproval(targetKey = activeConversationKeyRef.current) {
    const entry = [...approvalRequestsRef.current.values()]
      .find(candidate => candidate.target.key === targetKey)
    setPendingApproval(entry ? {
      request: entry.request,
      status: 'Waiting for approval',
      disabled: false,
    } : null)
  }

  const setExpandedProjects = (value: Set<string>) => {
    expandedProjectsRef.current = value
    setExpandedProjectsState(value)
    localStorage.setItem('jesse.expandedProjects', JSON.stringify([...value]))
  }

  async function initializeDesktop() {
    const [, workspaceRoot] = await Promise.all([
      loadProjects(activeProjectRef.current),
      loadChat(),
    ])
    const deepLink = readSessionDeepLink()
    if (deepLink && workspaceRoot) {
      await resumeChatSession(deepLink)
      window.history.replaceState({}, '', window.location.pathname)
    }
  }

  async function loadProjects(preferredPath: string) {
    const result = await getJson<{ projects?: DesktopProject[] }>('/api/projects')
    const nextProjects = Array.isArray(result.projects) ? result.projects : []
    setProjects(nextProjects)

    let nextActive = activeProjectRef.current
    if (preferredPath && nextProjects.some(project => project.path === preferredPath)) {
      nextActive = preferredPath
    } else if (!nextActive || !nextProjects.some(project => project.path === nextActive)) {
      nextActive = nextProjects[0]?.path || ''
    }

    setActiveProjectValue(nextActive)
    if (activeScopeRef.current === 'project') {
      setActiveConversationKey(conversationKey('project', nextActive, sessionIdRef.current))
    }
    if (!nextActive) return

    localStorage.setItem('jesse.activeProject', nextActive)
    const nextExpanded = new Set(expandedProjectsRef.current)
    nextExpanded.add(nextActive)
    setExpandedProjects(nextExpanded)
    await loadSessions(nextActive)
  }

  async function loadChat(): Promise<string> {
    const result = await getJson<{ workspaceRoot?: string }>('/api/chat')
    const workspaceRoot = typeof result.workspaceRoot === 'string' ? result.workspaceRoot : ''
    setChatWorkspaceRoot(workspaceRoot)
    if (!workspaceRoot) return ''
    await loadSessions(workspaceRoot)
    if (activeScopeRef.current === 'chat') {
      setActiveConversationKey(conversationKey('chat', workspaceRoot, sessionIdRef.current))
    }
    return workspaceRoot
  }

  async function loadSessions(projectPath = activeProjectRef.current): Promise<SessionSummary[]> {
    if (!projectPath) return []
    const query = encodeURIComponent(projectPath)
    const result = await getJson<{ sessions?: SessionSummary[] }>(`/api/sessions?limit=20&workspaceRoot=${query}`)
    const sessions = Array.isArray(result.sessions) ? result.sessions : []
    setSessionsByProject(current => {
      const next = new Map(current)
      next.set(projectPath, sessions)
      return next
    })
    const currentSession = sessions.find(session => session.id === sessionIdRef.current)
    const activeRoot = activeScopeRef.current === 'chat' ? chatWorkspaceRootRef.current : activeProjectRef.current
    if (currentSession && projectPath === activeRoot) {
      setActiveSessionTitle(currentSession.title || '')
      if (currentSession.metadata?.workspace) setActiveSessionWorkspace(currentSession.metadata.workspace)
    }
    return sessions
  }

  async function loadDailyChangelogs(projectPath = activeProjectRef.current): Promise<DailyChangelogSummary[]> {
    if (!projectPath) return []
    const requestId = ++changelogRequestRef.current
    setChangelogLoading(true)
    try {
      const query = new URLSearchParams({ workspaceRoot: projectPath, limit: '5' })
      const result = await getJson<{ changelogs?: DailyChangelogSummary[] }>(`/api/changelogs?${query}`)
      const changelogs = Array.isArray(result.changelogs) ? result.changelogs.slice(0, 5) : []
      if (changelogRequestRef.current === requestId) {
        setDailyChangelogs(changelogs)
        setChangelogProject(projectPath)
      }
      return changelogs
    } catch {
      if (changelogRequestRef.current === requestId) {
        setDailyChangelogs([])
        setChangelogProject(projectPath)
      }
      return []
    } finally {
      if (changelogRequestRef.current === requestId) setChangelogLoading(false)
    }
  }

  function showStartedSession(workspaceRoot: string, nextSessionId: string, firstMessage: string) {
    const message = firstMessage.trim()
    setActiveSessionTitle(previewLine(message, 42) || 'Untitled session')
    setSessionsByProject(current => {
      const next = new Map(current)
      const sessions = next.get(workspaceRoot) ?? []
      const existing = sessions.find(session => session.id === nextSessionId)
      const startedSession: SessionSummary = existing
        ? {
            ...existing,
            title: existing.title || previewLine(message, 42) || 'Untitled session',
            lastUserMessage: message || existing.lastUserMessage,
          }
        : {
            id: nextSessionId,
            title: previewLine(message, 42) || 'Untitled session',
            lastUserMessage: message || null,
          }
      next.set(workspaceRoot, [startedSession, ...sessions.filter(session => session.id !== nextSessionId)])
      return next
    })
  }

  async function addProject() {
    try {
      const result = await postJson<{ canceled?: boolean; projectPath?: string }>('/api/projects/pick', {})
      const projectPath = result.projectPath
      if (result.canceled || !projectPath) return
      await loadProjects(projectPath)
      await selectProject(projectPath)
    } catch (error) {
      addMessage('error', `Could not add project: ${errorMessage(error)}`)
    }
  }

  async function toggleProject(projectPath: string) {
    if (projectRowAction(activeScopeRef.current, activeProjectRef.current, projectPath) === 'select') {
      await selectProject(projectPath, { clearMessages: false })
      return
    }
    const nextExpanded = new Set(expandedProjectsRef.current)
    const expanding = !nextExpanded.has(projectPath)
    if (expanding) nextExpanded.add(projectPath)
    else nextExpanded.delete(projectPath)
    setExpandedProjects(nextExpanded)
    if (expanding) await loadSessions(projectPath)
  }

  async function selectProject(projectPath: string, options: { clearMessages?: boolean } = {}) {
    await postJson('/api/projects/select', { path: projectPath })
    setActiveScope('project')
    setActiveProjectValue(projectPath)
    setSessionId(null)
    setActiveSessionTitle('')
    setActiveSessionWorkspace(null)
    setActiveConversationKey(conversationKey('project', projectPath, null))
    resetConversationRuntimeState()

    const nextExpanded = new Set(expandedProjectsRef.current)
    nextExpanded.add(projectPath)
    setExpandedProjects(nextExpanded)
    localStorage.setItem('jesse.activeProject', projectPath)
    await loadSessions(projectPath)
    if (options.clearMessages !== false) setConversation([])
  }

  async function resumeSession(projectPath: string, nextSessionId: string) {
    if (activeScopeRef.current !== 'project' || activeProjectRef.current !== projectPath) {
      await selectProject(projectPath, { clearMessages: false })
    }
    const result = await postJson<{
      sessionId?: string
      title?: string
      executionRoot?: string
      metadata?: { workspace?: SessionWorkspaceMetadata }
      messages?: SessionMessage[]
    }>('/api/session/read', {
      workspaceRoot: projectPath,
      sessionId: nextSessionId,
    })
    const selectedSessionId = result.sessionId || nextSessionId
    setSessionId(selectedSessionId)
    setActiveSessionTitle(result.title || '')
    setActiveSessionWorkspace(result.metadata?.workspace ?? {
      id: selectedSessionId,
      kind: 'existing',
      path: result.executionRoot || projectPath,
      displayName: projectNameFromPath(result.executionRoot || projectPath),
    })
    setActiveConversationKey(conversationKey('project', projectPath, selectedSessionId))
    resetConversationRuntimeState()
    const loadedAt = new Date().toISOString()
    const loadedConversation = (result.messages ?? []).map(message => createMessageItem(
      message.role,
      message.content,
      message.createdAt || loadedAt,
      undefined,
      [],
      message.attachments ?? [],
    ))
    setConversation(loadedConversation)
    await loadSessions(projectPath)
    await attachToBackgroundRun('project', projectPath, selectedSessionId, loadedConversation)
  }

  async function resumeChatSession(nextSessionId: string) {
    const workspaceRoot = chatWorkspaceRootRef.current
    if (!workspaceRoot) return
    setActiveScope('chat')
    setOpenProjectMenu('')
    resetConversationRuntimeState()
    const result = await postJson<{
      sessionId?: string
      title?: string
      executionRoot?: string
      metadata?: { workspace?: SessionWorkspaceMetadata }
      messages?: SessionMessage[]
    }>('/api/session/read', {
      workspaceRoot,
      sessionId: nextSessionId,
    })
    const selectedSessionId = result.sessionId || nextSessionId
    setSessionId(selectedSessionId)
    setActiveSessionTitle(result.title || '')
    setActiveSessionWorkspace(result.metadata?.workspace ?? (result.executionRoot ? {
      id: selectedSessionId,
      kind: 'existing',
      path: result.executionRoot,
      displayName: projectNameFromPath(result.executionRoot),
    } : null))
    setActiveConversationKey(conversationKey('chat', workspaceRoot, selectedSessionId))
    const loadedAt = new Date().toISOString()
    const loadedConversation = (result.messages ?? []).map(message => createMessageItem(
      message.role,
      message.content,
      message.createdAt || loadedAt,
      undefined,
      [],
      message.attachments ?? [],
    ))
    setConversation(loadedConversation)
    await loadSessions(workspaceRoot)
    await attachToBackgroundRun('chat', workspaceRoot, selectedSessionId, loadedConversation)
  }

  async function attachToBackgroundRun(
    scope: ConversationScope,
    workspaceRoot: string,
    targetSessionId: string,
    loadedConversation: ConversationItem[],
  ) {
    const query = new URLSearchParams({ sessionId: targetSessionId, includeEvents: '1' })
    const result = await getJson<{ runs?: AgentRunSnapshot[]; events?: AgentRunEnvelope[] }>(`/api/runs?${query}`)
    for (const envelope of result.events ?? []) cacheBackgroundEnvelope(envelope)
    const runs = (result.runs ?? []).filter(candidate => isActiveRunStatus(candidate.status))
    if (runs.length === 0) return

    setConversation(loadedConversation)
    startRunProgress()
    const targetKey = conversationKey(scope, workspaceRoot, targetSessionId)
    const envelopes = backgroundEventsRef.current.get(targetSessionId) ?? []
    for (const run of runs) {
      const target = runTargetsByRunIdRef.current.get(run.id)
        ?? createRunTarget(scope, workspaceRoot, targetKey)
      target.key = targetKey
      target.assistantId = null
      target.assistantText = ''
      target.activityId = null
      target.currentTool = null
      bindRunTarget(target, run)
      startActivityStream(target)
      for (const envelope of envelopes.filter(candidate => candidate.run.id === run.id)) {
        if (envelope.output) handleBridgeOutput(envelope.output, target)
      }
    }
    refreshVisibleApproval(targetKey)
  }

  function receiveBackgroundEnvelope(envelope: AgentRunEnvelope, preferredTarget?: RunConversationTarget) {
    if (!preferredTarget && locallyStreamedRunIdsRef.current.has(envelope.run.id)) {
      cacheBackgroundEnvelope(envelope)
      backgroundRunsRef.current.set(envelope.run.id, envelope.run)
      scheduleSessionRefresh(envelope.run.workspaceRoot)
      return
    }
    const key = `${envelope.run.id}:${envelope.cursor}`
    if (backgroundEventKeysRef.current.has(key)) return
    backgroundEventKeysRef.current.add(key)
    if (backgroundEventKeysRef.current.size > 4_000) {
      const oldest = backgroundEventKeysRef.current.values().next().value
      if (typeof oldest === 'string') backgroundEventKeysRef.current.delete(oldest)
    }

    cacheBackgroundEnvelope(envelope)
    backgroundRunsRef.current.set(envelope.run.id, envelope.run)
    scheduleSessionRefresh(envelope.run.workspaceRoot)

    let target = preferredTarget ?? runTargetsByRunIdRef.current.get(envelope.run.id)
    if (!target && isActiveRunStatus(envelope.run.status)) {
      target = [...activeRunTargetsRef.current.values()].find(candidate => (
        !candidate.runId
        && candidate.projectPath === envelope.run.workspaceRoot
        && (candidate.key.endsWith(':session:new') || candidate.key.endsWith(`:session:${envelope.run.sessionId}`))
      ))
    }
    if (target) bindRunTarget(target, envelope.run)

    const activeScope = activeScopeRef.current
    const activeWorkspaceRoot = activeScope === 'chat' ? chatWorkspaceRootRef.current : activeProjectRef.current
    const isVisible = sessionIdRef.current === envelope.run.sessionId
      && activeWorkspaceRoot === envelope.run.workspaceRoot
    if (!isVisible) {
      if (!isActiveRunStatus(envelope.run.status) && target) finishRunTarget(target)
      return
    }

    setActiveSessionWorkspace(envelope.run.workspace ?? {
      id: envelope.run.sessionId,
      kind: 'scratch',
      path: envelope.run.executionRoot,
      displayName: 'Temporary workspace',
    })

    if (!target) {
      target = createRunTarget(
        activeScope,
        envelope.run.workspaceRoot,
        conversationKey(activeScope, envelope.run.workspaceRoot, envelope.run.sessionId),
      )
      bindRunTarget(target, envelope.run)
    }
    if (isActiveRunStatus(envelope.run.status) && !target.activityId) {
      startRunProgress()
      startActivityStream(target)
    }
    if (envelope.output) handleBridgeOutput(envelope.output, target)

    if (envelope.output?.type === 'done' || !isActiveRunStatus(envelope.run.status)) {
      finishRunTarget(target)
    }
  }

  function cacheBackgroundEnvelope(envelope: AgentRunEnvelope) {
    const current = backgroundEventsRef.current.get(envelope.run.sessionId) ?? []
    if (current.some(candidate => candidate.run.id === envelope.run.id && candidate.cursor === envelope.cursor)) return
    backgroundEventsRef.current.set(envelope.run.sessionId, [...current, envelope].slice(-500))
  }

  function scheduleSessionRefresh(workspaceRoot: string) {
    if (!workspaceRoot || sessionRefreshTimersRef.current.has(workspaceRoot)) return
    const timer = window.setTimeout(() => {
      sessionRefreshTimersRef.current.delete(workspaceRoot)
      void loadSessions(workspaceRoot)
    }, 180)
    sessionRefreshTimersRef.current.set(workspaceRoot, timer)
  }

  async function newProjectChat(projectPath = activeProjectRef.current) {
    if (!projectPath) return
    const runNewChat = async () => {
      await selectProject(projectPath, { clearMessages: false })
      setSessionId(null)
      setActiveSessionTitle('')
      setActiveSessionWorkspace(null)
      setActiveConversationKey(conversationKey('project', projectPath, null))
      setConversation([])
      await Promise.all([
        loadSessions(projectPath),
        loadDailyChangelogs(projectPath),
      ])
    }

    if (asciiCurtainRef.current) await asciiCurtainRef.current.transition(runNewChat)
    else await runNewChat()
  }

  async function newChat() {
    const runNewChat = async () => {
      const knownWorkspaceRoot = chatWorkspaceRootRef.current
      setActiveScope('chat')
      setOpenProjectMenu('')
      setSessionId(null)
      setActiveSessionTitle('')
      setActiveSessionWorkspace(null)
      setActiveConversationKey(conversationKey('chat', knownWorkspaceRoot, null))
      resetConversationRuntimeState()
      setConversation([])

      try {
        const workspaceRoot = knownWorkspaceRoot || await loadChat()
        if (!workspaceRoot) throw new Error('Chat workspace is unavailable')
        setActiveConversationKey(conversationKey('chat', workspaceRoot, null))
        if (knownWorkspaceRoot) await loadSessions(workspaceRoot)
      } catch (error) {
        addStatus('error', 'Could not start chat', errorMessage(error))
      }
    }

    if (asciiCurtainRef.current) await asciiCurtainRef.current.transition(runNewChat)
    else await runNewChat()
  }

  async function removeProject(projectPath: string) {
    if (!window.confirm('Remove this project from the sidebar? Files will not be deleted.')) return
    await requestJson('/api/projects', { method: 'DELETE', body: { path: projectPath } })
    const remainingProjects = projects.filter(project => project.path !== projectPath)
    setProjects(remainingProjects)
    setSessionsByProject(current => {
      const next = new Map(current)
      next.delete(projectPath)
      return next
    })

    const nextExpanded = new Set(expandedProjectsRef.current)
    nextExpanded.delete(projectPath)
    setExpandedProjects(nextExpanded)

    if (activeProjectRef.current === projectPath) {
      const nextActive = remainingProjects[0]?.path || ''
      setActiveProjectValue(nextActive)
      localStorage.setItem('jesse.activeProject', nextActive)
      if (nextActive) await loadSessions(nextActive)
      if (activeScopeRef.current === 'project') {
        setSessionId(null)
        setActiveConversationKey(conversationKey('project', nextActive, null))
        setConversation([])
      }
    }
    setOpenProjectMenu('')
  }

  async function renameProject(project: DesktopProject) {
    setOpenProjectMenu('')
    const rawName = window.prompt('Rename project:', project.name || project.path)
    if (rawName === null) return
    const name = rawName.trim()
    if (!name || name === project.name) return

    try {
      const result = await requestJson<{ projects?: DesktopProject[] }>('/api/projects', {
        method: 'PATCH',
        body: { path: project.path, name },
      })
      if (Array.isArray(result.projects)) setProjects(result.projects)
    } catch (error) {
      addMessage('error', `Could not rename project: ${errorMessage(error)}`)
    }
  }

  async function promoteActiveWorkspace() {
    const workspace = activeSessionWorkspace
    const currentSessionId = sessionIdRef.current
    if (!workspace || workspace.kind !== 'scratch' || !currentSessionId) return
    if ([...activeRunTargetsRef.current.values()].some(target => target.key === activeConversationKeyRef.current)) {
      addStatus('warning', 'Wait for the current run to finish before saving this workspace as a project.')
      return
    }

    const suggestedName = activeSessionTitle.trim()
      || (workspace.displayName !== 'Temporary workspace' ? workspace.displayName : '')
      || 'Untitled Project'
    const name = window.prompt('Save temporary workspace as project', suggestedName)?.trim()
    if (!name) return

    try {
      const result = await postJson<{
        executionRoot?: string
        workspace?: SessionWorkspaceMetadata
      }>('/api/workspace/promote', {
        workspaceRoot: chatWorkspaceRootRef.current,
        sessionId: currentSessionId,
        name,
      })
      if (!result.executionRoot || !result.workspace) throw new Error('The project workspace response was incomplete.')
      await postJson('/api/projects', { path: result.executionRoot })
      setActiveSessionWorkspace(result.workspace)
      await Promise.all([
        loadProjects(activeProjectRef.current),
        loadSessions(chatWorkspaceRootRef.current),
      ])
      addStatus('success', 'Saved as project', result.executionRoot)
    } catch (error) {
      addStatus('error', 'Could not save workspace as project', errorMessage(error))
    }
  }

  async function ask() {
    const displayPrompt = draftRef.current.trim()
    const annotations = composerAnnotationsRef.current
    const attachments = composerAttachmentsRef.current
    const prompt = buildPromptWithAnnotations(displayPrompt, annotations)
    await runPrompt(prompt, displayPrompt, annotations, attachments)
  }

  async function runPrompt(
    prompt: string,
    displayPrompt = prompt,
    annotations: ComposerAnnotation[] = [],
    attachments: ImageAttachment[] = [],
  ) {
    const scope = activeScopeRef.current
    const runProject = scope === 'chat' ? chatWorkspaceRootRef.current : activeProjectRef.current
    if ((!prompt && attachments.length === 0) || !runProject) return

    let requestedSessionId = sessionIdRef.current
    let bootstrap: {
      promise: Promise<string>
      resolve: (sessionId: string) => void
      reject: (error: unknown) => void
    } | null = null
    if (!requestedSessionId) {
      if (sessionBootstrapRef.current) {
        try {
          requestedSessionId = await sessionBootstrapRef.current
        } catch (error) {
          addStatus('error', 'Could not create the session', errorMessage(error))
          return
        }
      } else {
        let resolveBootstrap!: (sessionId: string) => void
        let rejectBootstrap!: (error: unknown) => void
        const promise = new Promise<string>((resolve, reject) => {
          resolveBootstrap = resolve
          rejectBootstrap = reject
        })
        bootstrap = { promise, resolve: resolveBootstrap, reject: rejectBootstrap }
        sessionBootstrapRef.current = promise
      }
    }

    const target = createRunTarget(
      scope,
      runProject,
      requestedSessionId
        ? conversationKey(scope, runProject, requestedSessionId)
        : activeConversationKeyRef.current,
    )
    const startsNewSession = requestedSessionId === null

    const composerStartRect = conversation.length === 0 ? composerRef.current?.getBoundingClientRect() : null
    const beginRun = () => {
      registerRunTarget(target)
      setQueueStatus('')
      setQueueingEnabled(true)
      setDraftValue('')
      setComposerAnnotationsValue([])
      setComposerAttachmentsValue([])
      startRunProgress()
      const userMessageId = addMessage('user', displayPrompt, target.key, annotations, attachments)
      if (userMessageId) target.userMessageId = userMessageId
      startActivityStream(target)
    }

    if (composerStartRect) {
      flushSync(beginRun)
      animateComposerMove(composerRef.current, composerStartRect)
    } else {
      beginRun()
    }

    try {
      await streamRun({
        prompt,
        attachments: attachments.length ? attachments.map(attachmentForRequest) : undefined,
        sessionId: requestedSessionId || undefined,
        permissionMode: permissionModeRef.current,
        context: {
          workspaceRoot: runProject,
          origin: 'web',
          ...(scope === 'chat' ? { chatMode: true } : {}),
        },
      }, started => {
        bindRunTarget(target, started.run)
        locallyStreamedRunIdsRef.current.add(started.runId)
        migrateRunTarget(target, started.sessionId)
        bootstrap?.resolve(started.sessionId)
        if (startsNewSession) showStartedSession(runProject, started.sessionId, displayPrompt || prompt || 'Image request')
      }, envelope => {
        receiveBackgroundEnvelope(envelope, target)
      })
      await loadSessions(runProject)
    } catch (error) {
      bootstrap?.reject(error)
      const message = errorMessage(error)
      addActivity(formatActivity({ type: 'run_state', kind: 'error', label: 'Run failed', status: 'error', summary: message }), target)
      finishRunProgress('error')
      addStatus('error', 'Run failed', message, target.key)
      updateCurrentUserMessageEditability(target, true)
    } finally {
      if (target.runId) locallyStreamedRunIdsRef.current.delete(target.runId)
      finishRunTarget(target)
      if (bootstrap && sessionBootstrapRef.current === bootstrap.promise) sessionBootstrapRef.current = null
    }
  }

  async function cancelRun() {
    const targets = [...activeRunTargetsRef.current.values()]
      .filter(target => target.key === activeConversationKeyRef.current && target.runId)
    await Promise.all(targets.map(async target => {
      await postJson('/api/cancel', { runId: target.runId })
      addActivity(
        formatActivity({ type: 'run_state', kind: 'error', label: 'Stop requested', status: 'error' }),
        target,
      )
    }))
    if (targets.length > 0) addStatus('warning', targets.length === 1 ? 'Stop requested' : `Stopping ${targets.length} tasks`)
  }

  /** Keeps follow-ups in FIFO order, matching the single active-run model. */
  function queuePrompt(prompt: string): boolean {
    const text = prompt.trim()
    if (!text) return false
    if (queuedPromptsRef.current.length >= MAX_QUEUED_PROMPTS) {
      setQueueStatus(`Queue is full (${MAX_QUEUED_PROMPTS}/${MAX_QUEUED_PROMPTS})`)
      return false
    }
    const nextQueue = enqueuePrompt(queuedPromptsRef.current, text, nextItemId('queue'))
    if (!nextQueue) return false
    setQueuedPromptsValue(nextQueue)
    setQueueStatus('')
    setDraftValue('')
    return true
  }

  /** Advances exactly one item even when both the event stream and finally block observe completion. */
  function scheduleNextQueuedPrompt(targetKey: string): void {
    if (queueAdvancePendingRef.current || !isActiveConversationTarget(targetKey)) return
    const { prompt: next, remaining } = dequeuePrompt(queuedPromptsRef.current)
    if (!next) return
    queueAdvancePendingRef.current = true
    setQueuedPromptsValue(remaining)
    setQueueStatus('')
    window.setTimeout(() => {
      queueAdvancePendingRef.current = false
      void runPrompt(next.text)
    }, 0)
  }

  function handleBridgeOutput(output: BridgeOutput, target: RunConversationTarget) {
    if (output.type === 'ready') {
      if (output.sessionId) migrateRunTarget(target, output.sessionId)
      if (output.permissionMode === 'default' || output.permissionMode === 'plan') setPermissionModeValue(output.permissionMode)
      if (isActiveConversationTarget(target.key)) {
        const currentSessionId = output.sessionId || sessionIdRef.current
        setSessionId(currentSessionId)
        if (output.workspace) {
          setActiveSessionWorkspace(output.workspace)
        } else if (output.cwd && currentSessionId) {
          setActiveSessionWorkspace({
            id: currentSessionId,
            kind: target.scope === 'chat' ? 'scratch' : 'existing',
            path: output.cwd,
            displayName: target.scope === 'chat' ? 'Temporary workspace' : projectNameFromPath(output.cwd),
          })
        }
      }
      setRunProgressStep('connect')
      addConversationSource(target, output.sessionId || sessionIdRef.current || 'new')
      return
    }
    if (output.type === 'approval_request') {
      approvalRequestsRef.current.set(output.request.id, { request: output.request, target })
      addActivity(formatActivity({ type: 'approval_request', request: output.request }), target)
      setRunProgressStep('approval')
      addApprovalSource(output.request)
      refreshVisibleApproval()
      return
    }
    if (output.type === 'approval_response') {
      const entry = approvalRequestsRef.current.get(output.id)
      approvalRequestsRef.current.delete(output.id)
      refreshVisibleApproval()
      addActivity(formatActivity({ type: 'approval_response', choice: output.choice }), target)
      if (output.choice === 'reject_once') {
        finishRunProgress('error')
      } else {
        if (entry) addApprovedFileOutput(entry.request)
      }
      return
    }
    if (output.type === 'done') {
      if (output.sessionId) migrateRunTarget(target, output.sessionId)
      if (isActiveConversationTarget(target.key)) setSessionId(output.sessionId || sessionIdRef.current)
      updateCurrentUserMessageEditability(target, Boolean(output.cancelled))
      addActivity(formatActivity({
        type: 'run_state',
        kind: output.cancelled ? 'error' : 'done',
        label: output.cancelled ? 'Run cancelled' : 'Run finished',
        status: output.cancelled ? 'error' : 'done',
      }), target)
      finishRunProgress(output.cancelled ? 'error' : 'done')
      addStatus(output.cancelled ? 'warning' : 'success', output.cancelled ? 'Run stopped' : 'Run finished', '', target.key)
      if (target.scope === 'project' && !output.cancelled) void loadDailyChangelogs(target.projectPath)
      return
    }
    if (output.type === 'error') {
      addActivity(formatActivity({ type: 'run_state', kind: 'error', label: 'Run failed', status: 'error', summary: output.error }), target)
      finishRunProgress('error')
      addStatus('error', 'Run failed', output.error, target.key)
      return
    }
    handleAgentEvent(output.event, target)
  }

  function handleAgentEvent(event: AgentEvent, target: RunConversationTarget) {
    if (event.type === 'assistant_delta') appendAssistant(event.text, target)
    if (event.type === 'assistant_text') setAssistant(event.text, target)
    if (event.type === 'assistant_attachment') addAssistantAttachment(event.attachment, target)
    if (event.type === 'turn_start') {
      setRunProgressStep('think')
      addActivity(formatActivity({ type: 'run_state', kind: 'thinking', label: 'Thinking', status: 'running' }), target)
    }
    if (event.type === 'tool_start') {
      if (!isActiveConversationTarget(target.key)) return
      freezeAssistantProgressNote(target)
      const args = asRecord(event.args)
      target.currentTool = { name: event.name, args }
      setRunProgressStep('work')
      addActivity(formatActivity({ type: 'tool_start', name: event.name, args }), target)
    }
    if (event.type === 'tool_result') {
      recordChangedFile(event.name, event.ok, event.content, target)
      recordCommandResult(event.name, event.ok, event.content, target)
      setRunProgressStep('outputs')
      updateLatestActivity(formatActivity({ type: 'tool_result', name: event.name, ok: event.ok, content: event.content }), target)
    }
    if (event.type === 'error') {
      const reason = String(event.reason || 'Unknown error')
      addActivity(formatActivity({ type: 'run_state', kind: 'error', label: 'Run failed', status: 'error', summary: reason }), target)
      finishRunProgress('error')
      addStatus('error', 'Run failed', reason, target.key)
    }
    if (event.type === 'max_turns') {
      addActivity(formatActivity({ type: 'run_state', kind: 'error', label: 'Run paused', status: 'error', summary: 'Reached the turn limit.' }), target)
    }
  }

  async function submitApproval(request: ApprovalRequest, choice: ApprovalChoice) {
    const entry = approvalRequestsRef.current.get(request.id)
    if (!entry || !entry.target.runId || !isActiveConversationTarget(entry.target.key)) return
    setPendingApproval(current => current?.request.id === request.id
      ? { ...current, status: `Submitting: ${labelChoice(choice)}`, disabled: true, error: undefined }
      : current)
    try {
      await postJson('/api/approval', { id: request.id, choice, runId: entry.target.runId })
      approvalRequestsRef.current.delete(request.id)
      refreshVisibleApproval()
    } catch (error) {
      setPendingApproval(current => current?.request.id === request.id
        ? { ...current, status: 'Waiting for approval', disabled: false, error: `Could not submit approval: ${errorMessage(error)}` }
        : current)
    }
  }

  function addMessage(
    role: string,
    text: string,
    targetKey = activeConversationKeyRef.current,
    annotations: ComposerAnnotation[] = [],
    attachments: ImageAttachment[] = [],
  ): string | null {
    if (!isActiveConversationTarget(targetKey)) return null
    const message = createMessageItem(role, text || '', undefined, undefined, annotations, attachments)
    setConversation(current => [...current, message])
    return message.id
  }

  function updateCurrentUserMessageEditability(target: RunConversationTarget, canEdit: boolean) {
    if (!isActiveConversationTarget(target.key)) return
    const messageId = target.userMessageId
    if (!messageId) return
    target.userMessageId = undefined
    setConversation(current => current.map(item => item.type === 'message' && item.id === messageId
      ? { ...item, canEdit: canEdit || undefined }
      : item))
  }

  function addStatus(
    tone: Extract<ConversationItem, { type: 'status' }>['tone'],
    title: string,
    detail = '',
    targetKey = activeConversationKeyRef.current,
  ) {
    if (!isActiveConversationTarget(targetKey)) return
    setConversation(current => [...current, {
      id: nextItemId('status'),
      type: 'status',
      tone,
      title,
      detail,
    }])
  }

  function startRunProgress() {
    setRunSteps(createRunSteps('start'))
    setShowRunProgress(true)
  }

  function setRunProgressStep(stepId: RunStep['id']) {
    setRunSteps(current => advanceRunSteps(current, stepId))
    setShowRunProgress(true)
  }

  function finishRunProgress(status: 'done' | 'error') {
    setRunSteps(current => current.map(step => ({
      ...step,
      status: status === 'done'
        ? 'done'
        : step.status === 'active'
          ? 'error'
          : step.status,
    })))
    setShowRunProgress(true)
  }

  function startActivityStream(target: RunConversationTarget) {
    if (!isActiveConversationTarget(target.key)) return
    const id = nextItemId('activity')
    target.activityId = id
    setConversation(current => [...current, { id, type: 'activity', items: [] }])
  }

  function addActivity(activity: ActivityInput, target: RunConversationTarget) {
    if (!isActiveConversationTarget(target.key)) return
    if (!target.activityId) startActivityStream(target)
    const streamId = target.activityId
    if (!streamId) return
    const nextActivity: ActivityItem = {
      id: nextItemId('activity-event'),
      kind: activity.kind,
      label: activity.label,
      status: activity.status ?? 'running',
      summary: activity.summary,
      target: activity.target,
      createdAt: new Date().toISOString(),
      count: activity.count,
    }
    setConversation(current => current.map(item => item.id === streamId && item.type === 'activity'
      ? { ...item, items: appendOrMergeActivity(item.items, nextActivity) }
      : item))
  }

  function updateLatestActivity(activity: ActivityInput, target: RunConversationTarget) {
    if (!isActiveConversationTarget(target.key)) return
    const streamId = target.activityId
    if (!streamId) return
    setConversation(current => current.map(item => {
      if (item.id !== streamId || item.type !== 'activity' || item.items.length === 0) return item
      const index = findActivityToUpdate(item.items, activity)
      if (index < 0) return item
      const items = [...item.items]
      const existing = items[index]
      items[index] = {
        ...existing,
        status: activity.status ?? existing.status,
        summary: activity.summary ?? existing.summary,
        target: activity.target ?? existing.target,
      }
      return { ...item, items }
    }))
  }

  function freezeAssistantProgressNote(target: RunConversationTarget) {
    if (!isActiveConversationTarget(target.key)) return
    if (!target.assistantId || !target.assistantText.trim()) return
    target.assistantId = null
    target.assistantText = ''
  }

  function appendAssistant(text: string, target: RunConversationTarget) {
    if (!isActiveConversationTarget(target.key)) return
    if (!target.assistantId) {
      const id = nextItemId('assistant')
      target.assistantId = id
      target.assistantText = text || ''
      setConversation(current => [...current, createMessageItem('assistant', text || '', undefined, id)])
      return
    }
    const assistantId = target.assistantId
    target.assistantText += text || ''
    setConversation(current => current.map(item => item.id === assistantId && item.type === 'message'
      ? { ...item, text: item.text + (text || '') }
      : item))
  }

  function setAssistant(text: string, target: RunConversationTarget) {
    if (!isActiveConversationTarget(target.key)) return
    if (!target.assistantId) {
      const id = nextItemId('assistant')
      target.assistantId = id
      target.assistantText = text || ''
      setConversation(current => [...current, createMessageItem('assistant', text || '', undefined, id)])
      return
    }
    const assistantId = target.assistantId
    target.assistantText = text || ''
    setConversation(current => current.map(item => item.id === assistantId && item.type === 'message'
      ? { ...item, text: text || '' }
      : item))
  }

  function addAssistantAttachment(attachment: ImageAttachment, target: RunConversationTarget) {
    if (!isActiveConversationTarget(target.key)) return
    if (!target.assistantId) {
      const id = nextItemId('assistant')
      target.assistantId = id
      target.assistantText = ''
      setConversation(current => [...current, createMessageItem('assistant', '', undefined, id, [], [attachment])])
      return
    }

    const assistantId = target.assistantId
    setConversation(current => current.map(item => {
      if (item.id !== assistantId || item.type !== 'message') return item
      if ((item.attachments ?? []).some(candidate => sameAttachment(candidate, attachment))) return item
      return { ...item, attachments: [...(item.attachments ?? []), attachment] }
    }))
  }

  function recordChangedFile(name: string, ok: boolean, content: string, target: RunConversationTarget) {
    if (!isActiveConversationTarget(target.key)) return
    const currentTool = target.currentTool
    if (!ok || !currentTool || currentTool.name !== name) return
    if (name !== 'write_file' && name !== 'edit_file') return
    if (content.toLowerCase().includes('no actual change')) return
    const filePath = currentTool.args.path
    if (typeof filePath === 'string' && filePath) {
      const file = { path: filePath, action: name === 'write_file' ? 'created/updated' : 'edited' }
      upsertOutputFile(file)
    }
  }

  function recordCommandResult(name: string, ok: boolean, content: string, target: RunConversationTarget) {
    if (!isActiveConversationTarget(target.key)) return
    const currentTool = target.currentTool
    if (!currentTool || currentTool.name !== name) return
    if (name !== 'run_command' && name !== 'run_background_command') return
    const command = stringArg(currentTool.args.command, name)
    const cwd = stringArg(currentTool.args.cwd, '.')
    const output: CommandOutput = {
      id: nextItemId('command-output'),
      command,
      cwd,
      ok,
      content,
    }
    setCommandOutputs(current => [output, ...current].slice(0, 10))
  }

  function upsertOutputFile(file: OutputFile) {
    setOutputFiles(current => {
      const next = new Map(current.map(item => [item.path, item]))
      next.set(file.path, { ...next.get(file.path), ...file })
      return [...next.values()].slice(-20)
    })
  }

  function addApprovedFileOutput(request: ApprovalRequest) {
    if (!request.files?.length) return
    for (const path of request.files) {
      upsertOutputFile({ path, action: 'approved', diff: request.diff })
    }
  }

  function addConversationSource(target: RunConversationTarget, sourceSessionId: string) {
    if (target.scope === 'chat') {
      upsertSource({
        id: 'chat',
        kind: 'Chat',
        label: 'Chat',
        detail: sourceSessionId ? `Session: ${sourceSessionId}` : undefined,
      })
      return
    }
    const projectPath = target.projectPath
    if (!projectPath) return
    const projectName = projectNameFromPath(projectPath)
    upsertSource({
      id: `project:${projectPath}`,
      kind: 'Project',
      label: projectName,
      detail: sourceSessionId ? `Session: ${sourceSessionId}` : projectPath,
    })
  }

  function addApprovalSource(request: ApprovalRequest) {
    if (!request.files?.length) return
    for (const file of request.files) {
      upsertSource({ id: `approval:${request.id}:${file}`, kind: 'Approval', label: file, detail: request.toolName })
    }
  }

  function addSelectedTextSource(text: string) {
    upsertSource({
      id: `selection:${Date.now()}`,
      kind: 'Selection',
      label: previewLine(text, 48),
      detail: text,
    })
  }

  function upsertSource(source: SourceItem) {
    setSourceItems(current => {
      const next = new Map(current.map(item => [item.id, item]))
      next.set(source.id, source)
      return [...next.values()].slice(-20)
    })
  }

  function migrateRunTarget(target: RunConversationTarget, sessionId: string) {
    const nextKey = conversationKey(target.scope, target.projectPath, sessionId)
    if (target.key === nextKey) return

    const previousKey = target.key
    target.key = nextKey
    if (activeConversationKeyRef.current === previousKey || activeConversationKeyRef.current === nextKey) {
      setActiveConversationKey(nextKey)
      setSessionId(sessionId)
    }
    setActiveRunRevision(value => value + 1)
  }

  function isActiveConversationTarget(targetKey: string): boolean {
    return activeConversationKeyRef.current === targetKey
  }

  function copyMessage(item: Extract<ConversationItem, { type: 'message' }>) {
    void navigator.clipboard?.writeText(messageTextForClipboard(item))
  }

  function retryMessage(item: Extract<ConversationItem, { type: 'message' }>) {
    const prompt = retryPromptFor(item)
    if (!prompt) return
    void runPrompt(prompt)
  }

  function editMessage(item: Extract<ConversationItem, { type: 'message' }>) {
    setDraftValue(item.text)
    setComposerAnnotationsValue(item.annotations ?? [])
    setComposerAttachmentsValue(editableComposerAttachments(item.attachments))
  }

  function retryPromptFor(item: Extract<ConversationItem, { type: 'message' }>): string {
    if (item.role === 'user') return item.text
    const index = conversation.findIndex(candidate => candidate.id === item.id)
    for (let i = index - 1; i >= 0; i -= 1) {
      const candidate = conversation[i]
      if (candidate?.type === 'message' && candidate.role === 'user') return candidate.text
    }
    return item.text
  }

  function addSelectionToChat(text: string) {
    const trimmed = text.trim()
    if (!trimmed) return
    const annotation: ComposerAnnotation = {
      id: nextItemId('annotation'),
      text: trimmed,
      label: previewLine(trimmed, 72),
      createdAt: new Date().toISOString(),
    }
    setComposerAnnotationsValue([...composerAnnotationsRef.current, annotation])
  }

  function removeComposerAnnotation(id: string) {
    setComposerAnnotationsValue(composerAnnotationsRef.current.filter(annotation => annotation.id !== id))
  }

  function addComposerAttachments(attachments: ComposerImageAttachment[]) {
    setComposerAttachmentsValue([...composerAttachmentsRef.current, ...attachments])
  }

  function removeComposerAttachment(id: string) {
    setComposerAttachmentsValue(composerAttachmentsRef.current.filter(attachment => attachment.id !== id))
  }

  function queueCurrentDraft() {
    const queued = queuePrompt(buildPromptWithAnnotations(draftRef.current.trim(), composerAnnotationsRef.current))
    if (queued) setComposerAnnotationsValue([])
  }

  function editQueuedMessage(id: string) {
    const item = queuedPromptsRef.current.find(candidate => candidate.id === id)
    if (!item) return
    setDraftValue(item.text)
    setQueuedPromptsValue(queuedPromptsRef.current.filter(candidate => candidate.id !== id))
    setQueueStatus('')
  }

  function deleteQueuedMessage(id: string) {
    setQueuedPromptsValue(queuedPromptsRef.current.filter(candidate => candidate.id !== id))
    setQueueStatus('')
  }

  function steerQueuedMessage(id: string) {
    if (!queuedPromptsRef.current.some(candidate => candidate.id === id)) return
    setQueuedPromptsValue(queuedPromptsRef.current.map(candidate => (
      candidate.id === id ? { ...candidate, mode: 'steer' } : candidate
    )))
    setQueueStatus('Will apply after the current run')
  }

  function turnOffQueueing() {
    setQueueingEnabled(false)
    setQueuedPromptsValue([])
    setQueueStatus('Queueing is off for this run')
  }

  async function renameSession(workspaceRoot: string, targetSessionId: string, currentTitle: string) {
    const rawName = window.prompt('Rename chat:', currentTitle)
    if (rawName === null) return
    const title = rawName.trim()
    if (!title || title === currentTitle) return
    try {
      await requestJson('/api/session/title', {
        method: 'PATCH',
        body: { workspaceRoot, sessionId: targetSessionId, title },
      })
      if (targetSessionId === sessionIdRef.current) setActiveSessionTitle(title)
      await loadSessions(workspaceRoot)
    } catch (error) {
      addStatus('error', 'Could not rename chat', errorMessage(error))
    }
  }

  async function archiveSession(workspaceRoot: string, targetSessionId: string) {
    if (!window.confirm('Archive this chat?')) return
    try {
      await postJson('/api/session/archive', { workspaceRoot, sessionId: targetSessionId })
      const activeWorkspaceRoot = activeScopeRef.current === 'chat'
        ? chatWorkspaceRootRef.current
        : activeProjectRef.current
      if (targetSessionId === sessionIdRef.current && workspaceRoot === activeWorkspaceRoot) {
        setSessionId(null)
        setActiveSessionTitle('')
        setActiveSessionWorkspace(null)
        setConversation([])
        setActiveConversationKey(conversationKey(activeScopeRef.current, workspaceRoot, null))
      }
      await loadSessions(workspaceRoot)
    } catch (error) {
      addStatus('error', 'Could not archive chat', errorMessage(error))
    }
  }

  function copySessionTitle(title: string) {
    void navigator.clipboard?.writeText(title)
  }

  function railSources(): SourceItem[] {
    const projectPath = activeProjectRef.current
    const projectSource: SourceItem[] = activeScopeRef.current === 'project' && projectPath
      ? [{ id: `project:${projectPath}`, kind: 'Project', label: projectNameFromPath(projectPath), detail: projectPath }]
      : []
    const merged = new Map([...projectSource, ...sourceItems].map(item => [item.id, item]))
    return [...merged.values()]
  }

  const isEmptyConversation = conversation.length === 0
  const chatSessions = sessionsByProject.get(chatWorkspaceRoot) ?? []
  const outputsRailSources = railSources()
  const showRail = !isEmptyConversation && hasOutputsRailContent({
    files: outputFiles,
    commands: commandOutputs,
    sources: outputsRailSources,
  })
  const showDailyChangelogs = isEmptyConversation
    && activeScope === 'project'
    && changelogProject === activeProject
    && dailyChangelogs.length > 0
  const showEmptyGreeting = isEmptyConversation && (
    activeScope !== 'project'
    || (!changelogLoading && changelogProject === activeProject && dailyChangelogs.length === 0)
  )
  const showPromoteWorkspaceAction = activeScope === 'chat'
    && activeSessionWorkspace?.kind === 'scratch'
    && Boolean(activeSessionWorkspace.path)

  return (
    <>
      <Sidebar
        projects={projects}
        chatSessions={chatSessions}
        chatWorkspaceRoot={chatWorkspaceRoot}
        activeScope={activeScope}
        activeProject={activeProject}
        expandedProjects={expandedProjects}
        sessionsByProject={sessionsByProject}
        activeSessionId={sessionId}
        openProjectMenu={openProjectMenu}
        themeMode={themeMode}
        onOpenProjectMenu={setOpenProjectMenu}
        onThemeModeChange={setManualThemeMode}
        onAddProject={() => void addProject()}
        onToggleProject={toggleProject}
        onNewChat={newChat}
        onNewProjectChat={newProjectChat}
        onResumeSession={resumeSession}
        onResumeChatSession={resumeChatSession}
        onRenameSession={renameSession}
        onArchiveSession={archiveSession}
        onCopySessionTitle={copySessionTitle}
        onRenameProject={renameProject}
        onRemoveProject={removeProject}
      />
      <Splitter />
      <main className={`main${isEmptyConversation ? ' empty-conversation' : ''}`}>
        <WorkspaceHeader
          showPromoteAction={showPromoteWorkspaceAction}
          onPromoteWorkspace={() => void promoteActiveWorkspace()}
        />
        <Conversation
          items={conversation}
          header={null}
          onCopyMessage={copyMessage}
          onEditMessage={editMessage}
          onAddSelectionToChat={addSelectionToChat}
        />
        {showRail ? <OutputsRail files={outputFiles} commands={commandOutputs} sources={outputsRailSources} /> : null}
        {showDailyChangelogs ? (
          <DailyChangelog
            projectPath={activeProject}
            items={dailyChangelogs}
            onOpenSession={sourceSessionId => void resumeSession(activeProject, sourceSessionId)}
          />
        ) : null}
        {showEmptyGreeting ? <div className="empty-greeting">Jesse, what should we work on?</div> : null}
        <RunProgress
          visible={showRunProgress && !isEmptyConversation}
          steps={runSteps}
          files={outputFiles}
          running={running}
        />
        <Composer
          formRef={composerRef}
          value={draft}
          running={running}
          queuedPrompts={queuedPrompts}
          queueStatus={queueStatus}
          maxQueuedPrompts={MAX_QUEUED_PROMPTS}
          queueingEnabled={queueingEnabled}
          activeProject={activeScope === 'chat' ? chatWorkspaceRoot : activeProject}
          permissionMode={permissionMode}
          annotations={composerAnnotations}
          attachments={composerAttachments}
          pendingApproval={pendingApproval}
          onChange={setDraftValue}
          onPermissionModeChange={setPermissionModeValue}
          onApproval={submitApproval}
          onRemoveAnnotation={removeComposerAnnotation}
          onAddAttachments={addComposerAttachments}
          onRemoveAttachment={removeComposerAttachment}
          onSubmit={() => void ask()}
          onCancel={() => void cancelRun()}
          onQueue={queueCurrentDraft}
          onQueuedEdit={editQueuedMessage}
          onQueuedDelete={deleteQueuedMessage}
          onQueuedSteer={steerQueuedMessage}
          onTurnOffQueueing={turnOffQueueing}
        />
        <AsciiCurtain ref={asciiCurtainRef} />
      </main>
    </>
  )
}

function projectNameFromPath(projectPath: string): string {
  return projectPath.split(/[\\/]/).filter(Boolean).pop() || projectPath
}

function readSessionDeepLink(): string | null {
  const params = new URLSearchParams(window.location.search)
  if (params.get('scope') !== 'chat') return null
  const sessionId = params.get('session')?.trim() ?? ''
  return /^[A-Za-z0-9._-]{1,160}$/.test(sessionId) ? sessionId : null
}

function isActiveRunStatus(status: AgentRunSnapshot['status']): boolean {
  return status === 'queued' || status === 'running' || status === 'waiting_approval'
}

function trimConversationForActiveRun(items: ConversationItem[]): ConversationItem[] {
  let lastUserIndex = -1
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index]
    if (item?.type === 'message' && item.role === 'user') {
      lastUserIndex = index
      break
    }
  }
  return lastUserIndex === -1 ? items : items.slice(0, lastUserIndex + 1)
}

function createMessageItem(
  role: string,
  text: string,
  createdAt = new Date().toISOString(),
  id = nextItemId('message'),
  annotations: ComposerAnnotation[] = [],
  attachments: ImageAttachment[] = [],
): Extract<ConversationItem, { type: 'message' }> {
  return {
    id,
    type: 'message',
    role,
    text: text || '',
    createdAt,
    attachments: attachments.length ? attachments : undefined,
    annotations: annotations.length ? annotations : undefined,
  }
}

function attachmentForRequest(attachment: ImageAttachment): ImageAttachment {
  return {
    type: 'image',
    mimeType: attachment.mimeType,
    dataURL: attachment.dataURL,
    name: attachment.name,
    byteLength: attachment.byteLength,
    width: attachment.width,
    height: attachment.height,
    source: 'user',
  }
}

function editableComposerAttachments(attachments: ImageAttachment[] | undefined): ComposerImageAttachment[] {
  return (attachments ?? []).flatMap(attachment => attachment.dataURL ? [{
    ...attachment,
    id: attachment.id || nextItemId('image'),
    dataURL: attachment.dataURL,
    source: 'user' as const,
  }] : [])
}

function sameAttachment(left: ImageAttachment, right: ImageAttachment): boolean {
  const leftKey = left.assetId || left.dataURL || left.url
  const rightKey = right.assetId || right.dataURL || right.url
  return Boolean(leftKey && rightKey && leftKey === rightKey)
}

function appendOrMergeActivity(items: ActivityItem[], next: ActivityItem): ActivityItem[] {
  const previous = items[items.length - 1]
  if (!previous || !canMergeActivity(previous, next)) return [...items, next]
  const count = (previous.count ?? 1) + 1
  const baseLabel = activityLabelBase(next.label)
  return [
    ...items.slice(0, -1),
    {
      ...previous,
      kind: next.kind,
      label: activityLabelForCount(baseLabel, count),
      status: next.status,
      summary: next.summary ?? previous.summary,
      target: next.target ?? previous.target,
      count,
    },
  ]
}

function findActivityToUpdate(items: ActivityItem[], activity: ActivityInput): number {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const candidate = items[index]
    if (candidate.status === 'running' && activitiesMatch(candidate, activity)) return index
  }
  for (let index = items.length - 1; index >= 0; index -= 1) {
    if (activitiesMatch(items[index], activity)) return index
  }
  return items.length - 1
}

function canMergeActivity(previous: ActivityItem, next: ActivityItem): boolean {
  if (!activitiesMatch(previous, next)) return false
  if (previous.status === 'error' || next.status === 'error') return false
  if (next.kind === 'approval' || next.kind === 'thinking' || next.kind === 'done') return false
  return true
}

function activitiesMatch(left: Pick<ActivityItem, 'kind' | 'label'>, right: Pick<ActivityItem, 'kind' | 'label'>): boolean {
  return left.kind === right.kind && activityLabelBase(left.label) === activityLabelBase(right.label)
}

function activityLabelBase(label: string): string {
  if (label === 'Ran commands') return 'Ran a command'
  if (label === 'Started commands') return 'Started a command'
  if (label === 'Edited files') return 'Edited a file'
  return label
}

function activityLabelForCount(baseLabel: string, count: number): string {
  if (count < 2) return baseLabel
  if (baseLabel === 'Ran a command') return 'Ran commands'
  if (baseLabel === 'Started a command') return 'Started commands'
  if (baseLabel === 'Edited a file') return 'Edited files'
  return baseLabel
}

function messageTextForClipboard(item: Extract<ConversationItem, { type: 'message' }>): string {
  if (!item.annotations?.length) return item.text
  return buildPromptWithAnnotations(item.text, item.annotations)
}

function buildPromptWithAnnotations(prompt: string, annotations: ComposerAnnotation[]): string {
  const body = prompt.trim()
  if (annotations.length === 0) return body
  const quoted = annotations.map((annotation, index) => {
    const quote = annotation.text.split('\n').map(line => '> ' + line).join('\n')
    return 'Annotation ' + (index + 1) + ':\n' + quote
  }).join('\n\n')
  return body
    ? body + '\n\nReferenced annotations:\n' + quoted
    : 'Use the following referenced annotations as context:\n' + quoted
}

function readStoredPermissionMode(): DesktopPermissionMode {
  const value = localStorage.getItem('jesse.permissionMode')
  return value === 'plan' ? 'plan' : 'default'
}

function conversationKey(scope: ConversationScope, projectPath: string, selectedSessionId: string | null): string {
  const owner = scope === 'chat' ? 'global' : projectPath || 'none'
  return `${scope}:${owner}:session:${selectedSessionId || 'new'}`
}

function themeModeForCurrentTime(): ThemeMode {
  const hour = new Date().getHours()
  return hour >= 6 && hour < 18 ? 'light' : 'dark'
}

function readStoredExpandedProjects(): Set<string> {
  try {
    const value = JSON.parse(localStorage.getItem('jesse.expandedProjects') || '[]') as unknown
    return new Set(Array.isArray(value) ? value.filter(item => typeof item === 'string') : [])
  } catch {
    return new Set()
  }
}

function readStoredConversationScope(): ConversationScope {
  return localStorage.getItem('jesse.activeScope') === 'chat' ? 'chat' : 'project'
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function previewLine(text: string, maxChars: number): string {
  const normalized = text.replace(/\s+/g, ' ').trim()
  if (normalized.length <= maxChars) return normalized
  return `${normalized.slice(0, maxChars)}...`
}

function createRunSteps(activeStepId: string | null = null): RunStep[] {
  const steps: RunStep[] = [
    { id: 'start', title: 'Start the run', status: 'pending' },
    { id: 'connect', title: 'Connect to the local agent', status: 'pending' },
    { id: 'think', title: 'Understand the request', status: 'pending' },
    { id: 'work', title: 'Read, edit, or run checks', status: 'pending' },
    { id: 'approval', title: 'Resolve approvals if needed', status: 'pending' },
    { id: 'outputs', title: 'Collect outputs and finish', status: 'pending' },
  ]
  if (!activeStepId) return steps
  return advanceRunSteps(steps, activeStepId)
}

function advanceRunSteps(steps: RunStep[], activeStepId: string): RunStep[] {
  const activeIndex = steps.findIndex(step => step.id === activeStepId)
  if (activeIndex === -1) return steps
  return steps.map((step, index) => {
    if (index < activeIndex) return { ...step, status: step.status === 'error' ? 'error' : 'done' }
    if (index === activeIndex) return { ...step, status: 'active' }
    return { ...step, status: step.status === 'done' ? 'done' : 'pending' }
  })
}

function animateComposerMove(element: HTMLFormElement | null, startRect: DOMRect) {
  if (!element || !element.animate || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
  window.requestAnimationFrame(() => {
    const endRect = element.getBoundingClientRect()
    const deltaX = startRect.left - endRect.left
    const deltaY = startRect.top - endRect.top
    if (Math.abs(deltaX) < 1 && Math.abs(deltaY) < 1) return

    element.animate([
      { transform: `translate(${deltaX}px, ${deltaY}px)` },
      { transform: 'translate(0, 0)' },
    ], {
      duration: 360,
      easing: 'cubic-bezier(0.2, 0, 0, 1)',
    })
  })
}

function nextItemId(prefix: string): string {
  itemSequence += 1
  return `${prefix}-${itemSequence}`
}
