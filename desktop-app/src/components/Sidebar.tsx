import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import jesseMarkUrl from '../../assets/jesse-mark.png'
import type { DesktopProject, SessionRunStatus, SessionSummary } from '../types'

const SESSION_PREVIEW_LIMIT = 5

export type ThemeMode = 'light' | 'dark'

interface SidebarProps {
  projects: DesktopProject[]
  chatSessions: SessionSummary[]
  chatWorkspaceRoot: string
  activeScope: 'project' | 'chat'
  activeProject: string
  expandedProjects: Set<string>
  sessionsByProject: Map<string, SessionSummary[]>
  activeSessionId: string | null
  openProjectMenu: string
  themeMode: ThemeMode
  onOpenProjectMenu: (projectPath: string) => void
  onThemeModeChange: (themeMode: ThemeMode) => void
  onAddProject: () => void
  onToggleProject: (projectPath: string) => Promise<void>
  onNewProjectChat: (projectPath: string) => Promise<void>
  onNewChat: () => Promise<void>
  onResumeSession: (projectPath: string, sessionId: string) => Promise<void>
  onResumeChatSession: (sessionId: string) => Promise<void>
  onRenameSession: (projectPath: string, sessionId: string, currentTitle: string) => Promise<void>
  onArchiveSession: (projectPath: string, sessionId: string) => Promise<void>
  onCopySessionTitle: (title: string) => void
  onRenameProject: (project: DesktopProject) => Promise<void>
  onRemoveProject: (projectPath: string) => Promise<void>
}

interface SessionMenuProps {
  openSessionMenu: string
  onOpenSessionMenu: (menuKey: string) => void
}

export function Sidebar(props: SidebarProps) {
  const [expandedSessionProjects, setExpandedSessionProjects] = useState<Set<string>>(() => new Set())
  const [settingsMenuOpen, setSettingsMenuOpen] = useState(false)
  const [openSessionMenu, setOpenSessionMenu] = useState('')

  useEffect(() => {
    setExpandedSessionProjects(new Set())
  }, [props.activeProject, props.activeScope])

  useEffect(() => {
    if (!props.openProjectMenu) return
    const closeMenu = (event: MouseEvent) => {
      const target = event.target
      if (target instanceof Element && target.closest('.project-menu, .project-menu-button')) return
      props.onOpenProjectMenu('')
    }
    document.addEventListener('click', closeMenu)
    return () => document.removeEventListener('click', closeMenu)
  }, [props.openProjectMenu, props.onOpenProjectMenu])

  useEffect(() => {
    if (!openSessionMenu) return
    const closeMenu = (event: MouseEvent) => {
      const target = event.target
      if (target instanceof Element && target.closest('.session-menu, .session-menu-button')) return
      setOpenSessionMenu('')
    }
    document.addEventListener('click', closeMenu)
    return () => document.removeEventListener('click', closeMenu)
  }, [openSessionMenu])

  useEffect(() => {
    if (!settingsMenuOpen) return
    const closeMenu = (event: MouseEvent) => {
      const target = event.target
      if (target instanceof Element && target.closest('.settings-menu, .settings-button')) return
      setSettingsMenuOpen(false)
    }
    document.addEventListener('click', closeMenu)
    return () => document.removeEventListener('click', closeMenu)
  }, [settingsMenuOpen])

  return (
    <aside className="sidebar">
      <div className="sidebar-header">
        <div className="brand" aria-label="JesseAgent">
          <span className="brand-mark-frame" aria-hidden="true">
            <img className="brand-mark" src={jesseMarkUrl} alt="" />
          </span>
          <span>JesseAgent</span>
        </div>
      </div>
      <div className="sidebar-scroll">
        <div className="sidebar-section-header">
          <span>Projects</span>
          <button className="project-add-button" type="button" title="Add project" aria-label="Add project" onClick={props.onAddProject}>
            <span className="fluent-icon icon-add" aria-hidden="true" />
          </button>
        </div>
        <div className="project-list">
          {props.projects.map(project => (
            <ProjectItem
              key={project.path}
              project={project}
              expandedSessionProjects={expandedSessionProjects}
              onShowMoreSessions={projectPath => setExpandedSessionProjects(current => new Set(current).add(projectPath))}
              onResetSessionPreview={projectPath => setExpandedSessionProjects(current => {
                if (!current.has(projectPath)) return current
                const next = new Set(current)
                next.delete(projectPath)
                return next
              })}
              openSessionMenu={openSessionMenu}
              onOpenSessionMenu={setOpenSessionMenu}
              {...props}
            />
          ))}
        </div>

        <div className="sidebar-section-header chat-section-header">
          <span>Chat</span>
          <button
            className="project-add-button"
            type="button"
            title="New chat"
            aria-label="New chat"
            onClick={() => {
              props.onOpenProjectMenu('')
              props.onNewChat()
            }}
          >
            <span className="fluent-icon icon-add" aria-hidden="true" />
          </button>
        </div>
        <ChatList
          {...props}
          expanded={expandedSessionProjects.has('chat')}
          onShowMore={() => setExpandedSessionProjects(current => new Set(current).add('chat'))}
          openSessionMenu={openSessionMenu}
          onOpenSessionMenu={setOpenSessionMenu}
        />
      </div>
      <div className="sidebar-footer">
        {settingsMenuOpen && (
          <div className="settings-menu" role="menu">
            <ThemeButton themeMode="light" currentThemeMode={props.themeMode} onSelect={selectThemeMode} />
            <ThemeButton themeMode="dark" currentThemeMode={props.themeMode} onSelect={selectThemeMode} />
          </div>
        )}
        <button
          className={`settings-button${settingsMenuOpen ? ' active' : ''}`}
          type="button"
          aria-expanded={settingsMenuOpen}
          aria-haspopup="menu"
          onClick={() => setSettingsMenuOpen(open => !open)}
        >
          <span className="settings-icon-slot" aria-hidden="true">
            <span className="fluent-icon icon-settings" />
          </span>
          <span className="settings-label">Settings</span>
        </button>
      </div>
    </aside>
  )

  function selectThemeMode(themeMode: ThemeMode) {
    props.onThemeModeChange(themeMode)
    setSettingsMenuOpen(false)
  }
}

function ThemeButton({
  themeMode,
  currentThemeMode,
  onSelect,
}: {
  themeMode: ThemeMode
  currentThemeMode: ThemeMode
  onSelect: (themeMode: ThemeMode) => void
}) {
  const selected = themeMode === currentThemeMode
  return (
    <button
      className={`theme-menu-item${selected ? ' active' : ''}`}
      type="button"
      role="menuitemradio"
      aria-checked={selected}
      onClick={() => onSelect(themeMode)}
    >
      <span>{themeMode === 'light' ? 'Light mode' : 'Dark mode'}</span>
      <span className="theme-check" aria-hidden="true">{selected ? '✓' : ''}</span>
    </button>
  )
}

function ProjectItem(props: SidebarProps & SessionMenuProps & {
  project: DesktopProject
  expandedSessionProjects: Set<string>
  onShowMoreSessions: (projectPath: string) => void
  onResetSessionPreview: (projectPath: string) => void
}) {
  const { project } = props
  const expanded = props.expandedProjects.has(project.path)
  const menuOpen = props.openProjectMenu === project.path
  const sessions = props.sessionsByProject.get(project.path) ?? []
  const showAllSessions = props.expandedSessionProjects.has(project.path)
  const visibleSessions = showAllSessions ? sessions : sessions.slice(0, SESSION_PREVIEW_LIMIT)
  const hiddenSessionCount = sessions.length - visibleSessions.length

  return (
    <div className={`project-shell${menuOpen ? ' menu-open' : ''}`}>
      <div className={`project-row${props.activeScope === 'project' && project.path === props.activeProject && props.activeSessionId === null ? ' active' : ''}`} title={project.path}>
        <button
          className="project-main-button"
          type="button"
          aria-expanded={expanded}
          onClick={() => {
            if (expanded) props.onResetSessionPreview(project.path)
            void props.onToggleProject(project.path)
          }}
        >
          <span className="project-icon-slot" aria-hidden="true">
            <span className={`fluent-icon project-folder-icon ${expanded ? 'icon-folder-open' : 'icon-folder'}`} />
          </span>
          <span className="project-name">{project.name || project.path}</span>
        </button>
        <div className="project-actions">
          <button
            className="project-new-chat-button"
            type="button"
            title="New chat"
            aria-label="New chat"
            onClick={event => {
              event.stopPropagation()
              props.onOpenSessionMenu('')
              props.onOpenProjectMenu('')
              void props.onNewProjectChat(project.path)
            }}
          >
            <span className="fluent-icon icon-add" aria-hidden="true" />
          </button>
          <button
            className="project-menu-button"
            type="button"
            title="Project menu"
            aria-label="Project menu"
            onClick={event => {
              event.stopPropagation()
              props.onOpenSessionMenu('')
              props.onOpenProjectMenu(menuOpen ? '' : project.path)
            }}
          >
            <span className="fluent-icon icon-more-vertical" aria-hidden="true" />
          </button>
        </div>
      </div>

      <div className="project-menu">
        <MenuButton label="Rename project" icon="icon-rename" onClick={() => void props.onRenameProject(project)} />
        <MenuButton label="Remove project" icon="icon-delete" onClick={() => void props.onRemoveProject(project.path)} />
        <div className="project-menu-divider" role="separator" />
        <div className="project-menu-path" title={project.path} aria-label={project.path}>
          {project.path}
        </div>
      </div>

      {expanded && (
        <div className="project-sessions">
          {sessions.length === 0 ? (
            <div className="session show-more-sessions empty-sessions">
              <span className="session-title">No sessions</span>
            </div>
          ) : (
            <>
              {visibleSessions.map(session => (
                <SessionItem
                  key={session.id}
                  session={session}
                  active={props.activeScope === 'project' && session.id === props.activeSessionId}
                  menuOpen={props.openSessionMenu === sessionMenuKey('project', project.path, session.id)}
                  onResume={() => void props.onResumeSession(project.path, session.id)}
                  onOpenMenu={() => props.onOpenSessionMenu(props.openSessionMenu === sessionMenuKey('project', project.path, session.id) ? '' : sessionMenuKey('project', project.path, session.id))}
                  onCloseMenu={() => props.onOpenSessionMenu('')}
                  onRename={(title) => void props.onRenameSession(project.path, session.id, title)}
                  onArchive={() => void props.onArchiveSession(project.path, session.id)}
                  onCopyTitle={props.onCopySessionTitle}
                />
              ))}
              {hiddenSessionCount > 0 && (
                <button
                  className="session show-more-sessions"
                  type="button"
                  onClick={() => props.onShowMoreSessions(project.path)}
                >
                  <span className="session-title">Show more</span>
                </button>
              )}
            </>
          )}
        </div>
      )}
    </div>
  )
}

function ChatList(props: SidebarProps & SessionMenuProps & {
  expanded: boolean
  onShowMore: () => void
}) {
  const visibleSessions = props.expanded
    ? props.chatSessions
    : props.chatSessions.slice(0, SESSION_PREVIEW_LIMIT)
  const hiddenSessionCount = props.chatSessions.length - visibleSessions.length

  return (
    <div className="chat-list">
      {props.chatSessions.length === 0 ? (
        <div className="empty-chats">No chats yet</div>
      ) : (
        <>
          {visibleSessions.map(session => (
            <SessionItem
              key={session.id}
              session={session}
              showRunDetails={false}
              active={props.activeScope === 'chat' && session.id === props.activeSessionId}
              menuOpen={props.openSessionMenu === sessionMenuKey('chat', 'chat', session.id)}
              onResume={() => void props.onResumeChatSession(session.id)}
              onOpenMenu={() => props.onOpenSessionMenu(props.openSessionMenu === sessionMenuKey('chat', 'chat', session.id) ? '' : sessionMenuKey('chat', 'chat', session.id))}
              onCloseMenu={() => props.onOpenSessionMenu('')}
              onRename={title => void props.onRenameSession(props.chatWorkspaceRoot, session.id, title)}
              onArchive={() => void props.onArchiveSession(props.chatWorkspaceRoot, session.id)}
              onCopyTitle={props.onCopySessionTitle}
            />
          ))}
          {hiddenSessionCount > 0 && (
            <button className="session show-more-sessions" type="button" onClick={props.onShowMore}>
              <span className="session-title">Show more</span>
            </button>
          )}
        </>
      )}
    </div>
  )
}

function SessionItem({
  session,
  showRunDetails = true,
  active,
  menuOpen,
  onResume,
  onOpenMenu,
  onCloseMenu,
  onRename,
  onArchive,
  onCopyTitle,
}: {
  session: SessionSummary
  showRunDetails?: boolean
  active: boolean
  menuOpen: boolean
  onResume: () => void
  onOpenMenu: () => void
  onCloseMenu: () => void
  onRename: (title: string) => void
  onArchive: () => void
  onCopyTitle: (title: string) => void
}) {
  const rowRef = useRef<HTMLDivElement>(null)
  const menuButtonRef = useRef<HTMLButtonElement>(null)
  const [menuPosition, setMenuPosition] = useState<{ left: number; top: number } | null>(null)
  const title = session.title || session.lastUserMessage || 'Untitled session'
  const isShortcutSession = session.metadata?.origin === 'shortcut'
  const status = session.lastRun?.status
  const source = shortcutSourceLabel(session)

  useLayoutEffect(() => {
    if (!menuOpen) {
      setMenuPosition(null)
      return
    }

    const updateMenuPosition = () => {
      const anchor = menuButtonRef.current ?? rowRef.current
      if (!anchor) return
      const rect = anchor.getBoundingClientRect()
      const menuWidth = 172
      const menuHeight = 132
      const viewportPadding = 8
      const left = Math.max(viewportPadding, Math.min(rect.right - menuWidth, window.innerWidth - menuWidth - viewportPadding))
      const preferredTop = rect.bottom + 4
      const top = preferredTop + menuHeight > window.innerHeight - viewportPadding
        ? Math.max(viewportPadding, rect.top - menuHeight - 4)
        : preferredTop
      setMenuPosition({ left, top })
    }

    updateMenuPosition()
    window.addEventListener('resize', updateMenuPosition)
    window.addEventListener('scroll', updateMenuPosition, true)
    return () => {
      window.removeEventListener('resize', updateMenuPosition)
      window.removeEventListener('scroll', updateMenuPosition, true)
    }
  }, [menuOpen])

  return (
    <div ref={rowRef} className={`session${showRunDetails && isShortcutSession ? ' shortcut-session' : ''}${active ? ' active' : ''}${menuOpen ? ' menu-open' : ''}`} title={title}>
      <button className="session-main-button" type="button" onClick={onResume}>
        <span className="session-copy">
          <span className="session-title">{title}</span>
          {showRunDetails && isShortcutSession ? (
            <span className="session-meta">{[source || 'Shortcut', runStatusLabel(status)].filter(Boolean).join(' · ')}</span>
          ) : null}
        </span>
      </button>
      <div className="session-trailing">
        {showRunDetails && status ? <span className={`session-status-dot ${status}`} aria-label={status} /> : null}
        <button
          ref={menuButtonRef}
          className={`session-menu-button${menuOpen ? ' active' : ''}`}
          type="button"
          aria-label="Chat menu"
          aria-expanded={menuOpen}
          aria-haspopup="menu"
          title="Chat menu"
          onClick={event => {
            event.stopPropagation()
            onOpenMenu()
          }}
        >
          <span className="fluent-icon icon-more-vertical" aria-hidden="true" />
        </button>
      </div>
      {menuOpen && menuPosition ? createPortal(
        <div className="session-menu" role="menu" style={{ left: menuPosition.left, top: menuPosition.top }}>
          <SessionMenuButton label="Rename chat" onClick={run(() => onRename(title))} />
          <SessionMenuButton label="Archive chat" onClick={run(onArchive)} />
          <div className="session-menu-divider" role="separator" />
          <SessionMenuButton label="Copy title" onClick={run(() => onCopyTitle(title))} />
        </div>,
        document.body,
      ) : null}
    </div>
  )

  function run(action: () => void): () => void {
    return () => {
      onCloseMenu()
      action()
    }
  }
}

function shortcutSourceLabel(session: SessionSummary): string {
  const source = session.metadata?.source
  if (source?.url) {
    try {
      const url = new URL(source.url)
      if (url.hostname === 'github.com') {
        const [owner, repo] = url.pathname.split('/').filter(Boolean)
        if (owner && repo) return `${owner}/${repo}`
      }
      return url.hostname || source.app || 'Shortcut'
    } catch {
      return source.app || 'Shortcut'
    }
  }
  return source?.app || 'Shortcut'
}

function runStatusLabel(status: SessionRunStatus | undefined): string {
  switch (status) {
    case 'queued': return 'Queued'
    case 'running': return 'Running'
    case 'waiting_approval': return 'Needs approval'
    case 'completed': return 'Completed'
    case 'failed': return 'Failed'
    case 'cancelled': return 'Stopped'
    default: return ''
  }
}

function SessionMenuButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button type="button" role="menuitem" onClick={onClick}>
      <span>{label}</span>
    </button>
  )
}

function sessionMenuKey(kind: 'project' | 'chat', ownerId: string, sessionId: string): string {
  return `${kind}:${ownerId}:${sessionId}`
}

function MenuButton({ label, icon, onClick }: { label: string; icon: string; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick}>
      <span className={`fluent-icon ${icon}`} aria-hidden="true" />
      <span className="menu-label">{label}</span>
    </button>
  )
}
