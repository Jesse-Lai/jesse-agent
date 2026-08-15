export type ProjectRowAction = 'select' | 'toggle'

export function projectRowAction(
  activeScope: 'project' | 'chat',
  activeProject: string,
  projectPath: string,
): ProjectRowAction {
  return activeScope === 'project' && activeProject === projectPath ? 'toggle' : 'select'
}
