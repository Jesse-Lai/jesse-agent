import { useEffect, useState } from 'react'

interface ThreadHeaderProps {
  title: string
  subtitle: string
  running: boolean
  canManageSession: boolean
  onRename: () => void
  onArchive: () => void
  onCopyTitle: () => void
}

export function ThreadHeader({
  title,
  subtitle,
  running,
  canManageSession,
  onRename,
  onArchive,
  onCopyTitle,
}: ThreadHeaderProps) {
  const [menuOpen, setMenuOpen] = useState(false)

  useEffect(() => {
    if (!menuOpen) return
    const close = (event: MouseEvent) => {
      const target = event.target
      if (target instanceof Element && target.closest('.thread-menu, .thread-menu-button')) return
      setMenuOpen(false)
    }
    document.addEventListener('click', close)
    return () => document.removeEventListener('click', close)
  }, [menuOpen])

  return (
    <header className="thread-header">
      <div className="thread-title-group">
        <div className="thread-title-row">
          <span className={`thread-run-dot${running ? ' running' : ''}`} aria-hidden="true" />
          <h1>{title || 'New chat'}</h1>
        </div>
        <div className="thread-subtitle">{subtitle}</div>
      </div>
      <div className="thread-actions">
        <button
          className={`thread-menu-button${menuOpen ? ' active' : ''}`}
          type="button"
          aria-label="Chat menu"
          aria-expanded={menuOpen}
          aria-haspopup="menu"
          onClick={() => setMenuOpen(open => !open)}
        >
          <span className="fluent-icon icon-more-vertical" aria-hidden="true" />
        </button>
        {menuOpen ? (
          <div className="thread-menu" role="menu">
            <ThreadMenuButton label="Rename chat" disabled={!canManageSession} onClick={run(onRename)} />
            <ThreadMenuButton label="Archive chat" disabled={!canManageSession} onClick={run(onArchive)} />
            <div className="thread-menu-divider" role="separator" />
            <ThreadMenuButton label="Copy title" onClick={run(onCopyTitle)} />
          </div>
        ) : null}
      </div>
    </header>
  )

  function run(action: () => void): () => void {
    return () => {
      setMenuOpen(false)
      action()
    }
  }
}

function ThreadMenuButton({ label, disabled, onClick }: { label: string; disabled?: boolean; onClick: () => void }) {
  return (
    <button type="button" role="menuitem" disabled={disabled} onClick={onClick}>
      <span>{label}</span>
    </button>
  )
}
