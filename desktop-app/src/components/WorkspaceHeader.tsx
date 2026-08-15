interface WorkspaceHeaderProps {
  showPromoteAction: boolean
  onPromoteWorkspace: () => void
}

export function WorkspaceHeader({
  showPromoteAction,
  onPromoteWorkspace,
}: WorkspaceHeaderProps) {
  if (!showPromoteAction) return null

  return (
    <header className="workspace-header">
      <button className="workspace-header-promote" type="button" onClick={onPromoteWorkspace}>
        Save as project
      </button>
    </header>
  )
}
