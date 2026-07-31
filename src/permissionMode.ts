/**
 * permissionMode.ts —— 权限模式状态
 *
 * 解决什么问题：
 *   同一套工具在不同阶段需要不同自由度：计划时只能读，执行时可以改，
 *   本地完全信任时才考虑危险 bypass。Claude Code 把这些叫 PermissionMode。
 *
 * 当前简化版：
 *   default：正常权限规则。
 *   plan：只允许读/搜/只读 Bash，禁止编辑和危险命令。
 *   acceptEdits：自动接受文件编辑，Bash 仍走正常权限规则。
 *   bypassPermissions：定义出来，但必须显式设置环境变量才允许进入。
 */

export type PermissionMode = 'default' | 'plan' | 'acceptEdits' | 'bypassPermissions'

const BYPASS_ENV = 'JESSE_ALLOW_BYPASS_PERMISSIONS'

let currentMode: PermissionMode = 'default'

export function getPermissionMode(): PermissionMode {
  return currentMode
}

export function setPermissionMode(mode: PermissionMode): { ok: true; mode: PermissionMode } | { ok: false; reason: string } {
  if (mode === 'bypassPermissions' && process.env[BYPASS_ENV] !== '1') {
    return {
      ok: false,
      reason: `bypassPermissions 是危险模式；如确实需要，请先设置 ${BYPASS_ENV}=1 后重启 agent。`,
    }
  }

  currentMode = mode
  return { ok: true, mode }
}

export function parsePermissionMode(input: string): PermissionMode | null {
  switch (input.trim().toLowerCase()) {
    case 'default':
      return 'default'
    case 'plan':
      return 'plan'
    case 'acceptedits':
    case 'accept-edits':
    case 'accept_edits':
      return 'acceptEdits'
    case 'bypass':
    case 'bypasspermissions':
    case 'bypass-permissions':
    case 'bypass_permissions':
      return 'bypassPermissions'
    default:
      return null
  }
}

export function permissionModeTitle(mode: PermissionMode = currentMode): string {
  switch (mode) {
    case 'default':
      return 'Default'
    case 'plan':
      return 'Plan'
    case 'acceptEdits':
      return 'Accept Edits'
    case 'bypassPermissions':
      return 'Bypass Permissions'
  }
}

export function permissionModeDescription(mode: PermissionMode = currentMode): string {
  switch (mode) {
    case 'default':
      return '正常权限规则：只读工具自动执行，危险工具按规则放行、拒绝或询问。'
    case 'plan':
      return '计划模式：只能读取、搜索、运行只读 Bash；禁止写文件和危险 Bash。'
    case 'acceptEdits':
      return '自动接受文件编辑；Bash 仍按正常权限规则处理。'
    case 'bypassPermissions':
      return '危险模式：跳过权限确认，仅适合完全信任的本地实验。'
  }
}

export function permissionModeHelp(): string {
  return [
    `当前权限模式：${permissionModeTitle()} - ${permissionModeDescription()}`,
    '可用命令：',
    '  /mode default      正常权限规则',
    '  /mode plan         只读/规划模式',
    '  /mode acceptEdits  自动接受文件编辑，Bash 仍谨慎',
    '  /mode bypass       危险模式；默认禁用，需要 JESSE_ALLOW_BYPASS_PERMISSIONS=1',
  ].join('\n')
}
