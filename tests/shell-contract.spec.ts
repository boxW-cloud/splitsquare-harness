import { describe, expect, it } from 'vitest'
import {
  DEFAULT_CHROME_HEIGHT,
  MAX_HARNESS_DIMENSION,
  MAX_SHELL_COORDINATE,
  SHELL_COMMAND_CHANNEL,
  SHELL_IPC_CHANNELS,
  SHELL_MENU_IDS,
  SHELL_STATE_CHANNEL,
  computeHarnessBounds,
  parseShellCommand,
  type ShellState,
} from '../src/shell-contract.js'

describe('shell IPC contract', () => {
  it('uses fixed channels', () => {
    expect(SHELL_IPC_CHANNELS).toEqual({ command: 'shell:command', state: 'shell:state' })
    expect(SHELL_COMMAND_CHANNEL).toBe('shell:command')
    expect(SHELL_STATE_CHANNEL).toBe('shell:state')
  })

  it.each(SHELL_MENU_IDS)('accepts the %s menu', (menu) => {
    expect(parseShellCommand({ type: 'menu', menu, x: 12, y: 34 }))
      .toEqual({ type: 'menu', menu, x: 12, y: 34 })
  })

  it.each(['back', 'forward', 'toggle-sidebar'] as const)('accepts %s', (type) => {
    expect(parseShellCommand({ type })).toEqual({ type })
  })

  it.each([
    null,
    undefined,
    'back',
    [],
    {},
    { type: 'unknown' },
    { type: 'menu', menu: 'edit', x: 0, y: 0 },
    { type: 'menu', menu: 'file', x: -1, y: 0 },
    { type: 'menu', menu: 'file', x: 0.5, y: 0 },
    { type: 'menu', menu: 'file', x: 0, y: MAX_SHELL_COORDINATE + 1 },
    { type: 'menu', menu: 'file', x: 0 },
    { type: 'back', extra: true },
  ])('rejects malformed input: %p', (input) => {
    expect(parseShellCommand(input)).toBeUndefined()
  })

  it('rejects inherited or symbolic extras', () => {
    expect(parseShellCommand(Object.create({ type: 'back' }))).toBeUndefined()
    expect(parseShellCommand({ type: 'back', [Symbol('extra')]: true })).toBeUndefined()
  })

  it('describes shell state', () => {
    const state: ShellState = { canGoBack: true, canGoForward: false, sidebarOpen: true }
    expect(state.sidebarOpen).toBe(true)
  })
})

describe('computeHarnessBounds', () => {
  it('places the Harness below the custom chrome', () => {
    expect(computeHarnessBounds(1280, 720)).toEqual({
      x: 0,
      y: DEFAULT_CHROME_HEIGHT,
      width: 1280,
      height: 638,
    })
  })

  it('clips and sanitizes invalid dimensions', () => {
    expect(computeHarnessBounds(640, 60)).toEqual({ x: 0, y: 60, width: 640, height: 0 })
    expect(computeHarnessBounds(Number.POSITIVE_INFINITY, 100, -1))
      .toEqual({ x: 0, y: 0, width: 0, height: 100 })
    expect(computeHarnessBounds(
      MAX_HARNESS_DIMENSION + 1,
      MAX_HARNESS_DIMENSION + 1,
      MAX_HARNESS_DIMENSION + 1,
    )).toEqual({
      x: 0,
      y: MAX_HARNESS_DIMENSION,
      width: MAX_HARNESS_DIMENSION,
      height: 0,
    })
  })
})
