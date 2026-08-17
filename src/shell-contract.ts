export const SHELL_IPC_CHANNELS = Object.freeze({
  command: 'shell:command',
  state: 'shell:state',
} as const)

export const SHELL_COMMAND_CHANNEL = SHELL_IPC_CHANNELS.command
export const SHELL_STATE_CHANNEL = SHELL_IPC_CHANNELS.state

export const SHELL_MENU_IDS = Object.freeze([
  'file',
  'remote',
  'view',
  'window',
  'help',
] as const)

export type ShellMenuId = (typeof SHELL_MENU_IDS)[number]

export const MAX_SHELL_COORDINATE = 100_000
export const MAX_HARNESS_DIMENSION = 100_000
export const DEFAULT_CHROME_HEIGHT = 82

export type ShellCommand =
  | Readonly<{ type: 'menu'; menu: ShellMenuId; x: number; y: number }>
  | Readonly<{ type: 'back' }>
  | Readonly<{ type: 'forward' }>
  | Readonly<{ type: 'toggle-sidebar' }>

export interface ShellState {
  readonly canGoBack: boolean
  readonly canGoForward: boolean
  readonly sidebarOpen: boolean
}

export interface HarnessBounds {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

type UnknownRecord = Record<PropertyKey, unknown>

const menuIds = new Set<string>(SHELL_MENU_IDS)

function asPlainRecord(value: unknown): UnknownRecord | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const prototype = Object.getPrototypeOf(value) as unknown
  if (prototype !== Object.prototype && prototype !== null) return undefined
  return value as UnknownRecord
}

function hasExactOwnKeys(value: UnknownRecord, expectedKeys: readonly string[]): boolean {
  const actualKeys = Reflect.ownKeys(value)
  return actualKeys.length === expectedKeys.length
    && expectedKeys.every((key) => Object.prototype.hasOwnProperty.call(value, key))
}

function isCoordinate(value: unknown): value is number {
  return typeof value === 'number'
    && Number.isFinite(value)
    && Number.isInteger(value)
    && value >= 0
    && value <= MAX_SHELL_COORDINATE
}

export function parseShellCommand(value: unknown): ShellCommand | undefined {
  try {
    const command = asPlainRecord(value)
    if (command === undefined) return undefined
    const type = command.type

    if (type === 'menu') {
      if (!hasExactOwnKeys(command, ['type', 'menu', 'x', 'y'])) return undefined
      const menu = command.menu
      const x = command.x
      const y = command.y
      if (typeof menu !== 'string' || !menuIds.has(menu) || !isCoordinate(x) || !isCoordinate(y)) {
        return undefined
      }
      return { type, menu: menu as ShellMenuId, x, y }
    }

    if (type === 'back' || type === 'forward' || type === 'toggle-sidebar') {
      return hasExactOwnKeys(command, ['type']) ? { type } : undefined
    }
    return undefined
  } catch {
    return undefined
  }
}

function sanitizeDimension(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0
  return Math.min(Math.floor(value), MAX_HARNESS_DIMENSION)
}

export function computeHarnessBounds(
  width: number,
  height: number,
  chromeHeight = DEFAULT_CHROME_HEIGHT,
): HarnessBounds {
  const safeWidth = sanitizeDimension(width)
  const safeHeight = sanitizeDimension(height)
  const safeChromeHeight = Math.min(sanitizeDimension(chromeHeight), safeHeight)
  return {
    x: 0,
    y: safeChromeHeight,
    width: safeWidth,
    height: safeHeight - safeChromeHeight,
  }
}
