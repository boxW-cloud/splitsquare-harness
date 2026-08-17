import { describe, expect, it, vi } from 'vitest'
import {
  canonicalHarnessOrigin,
  isExactHarnessOrigin,
  isExactMainFrameRequest,
  permissionDisposition,
  safeDialogLabel,
  SessionGrantLedger,
} from '../src/capability-policy.js'

describe('desktop capability policy', () => {
  const origin = 'http://127.0.0.1:43127'

  it('recognizes only an explicit loopback origin with a port', () => {
    expect(canonicalHarnessOrigin(origin)).toBe(origin)
    expect(canonicalHarnessOrigin(`${origin}/some/path`)).toBe(origin)
    expect(canonicalHarnessOrigin('http://127.0.0.1')).toBeUndefined()
    expect(canonicalHarnessOrigin('http://localhost:43127')).toBeUndefined()
    expect(canonicalHarnessOrigin('https://127.0.0.1:43127')).toBeUndefined()
    expect(canonicalHarnessOrigin('http://user@127.0.0.1:43127')).toBeUndefined()
  })

  it.each([
    'http://127.0.0.1:43128/',
    'http://localhost:43127/',
    'https://127.0.0.1:43127/',
    'http://127.0.0.1.evil.test:43127/',
    'http://127.0.0.1:43127.evil.test/',
    'http://127.0.0.1:43127@evil.test/',
    'http://user@127.0.0.1:43127/',
    'file:///C:/Windows/System32/calc.exe',
    'data:text/html,hello',
    'not a url',
  ])('rejects an origin-confusion candidate: %s', (candidate) => {
    expect(isExactHarnessOrigin(candidate, origin)).toBe(false)
  })

  it('accepts paths only when their parsed origin is exact', () => {
    expect(isExactHarnessOrigin(`${origin}/api/items?q=1#result`, origin)).toBe(true)
  })

  it('binds requests to the exact WebContents and main frame', () => {
    const trustedContents = {}
    const base = {
      requestingWebContents: trustedContents,
      trustedWebContents: trustedContents,
      isMainFrame: true,
      requestingUrl: `${origin}/settings`,
      currentMainFrameUrl: `${origin}/`,
      trustedOrigin: origin,
    }
    expect(isExactMainFrameRequest(base)).toBe(true)
    expect(isExactMainFrameRequest({ ...base, requestingWebContents: {} })).toBe(false)
    expect(isExactMainFrameRequest({ ...base, isMainFrame: false })).toBe(false)
    expect(isExactMainFrameRequest({ ...base, embeddingOrigin: 'http://evil.test' })).toBe(false)
    expect(isExactMainFrameRequest({ ...base, securityOrigin: 'http://localhost:43127' })).toBe(false)
    expect(isExactMainFrameRequest({ ...base, currentMainFrameUrl: 'data:text/html,stale' })).toBe(false)
  })

  it('defaults unknown permissions to deny and keeps SysEx separate', () => {
    expect(permissionDisposition('clipboard-sanitized-write')).toBe('allow')
    expect(permissionDisposition('media')).toBe('prompt')
    expect(permissionDisposition('midi')).toBe('prompt')
    expect(permissionDisposition('midiSysex')).toBe('prompt')
    expect(permissionDisposition('openExternal')).toBe('deny')
    expect(permissionDisposition('unknown')).toBe('deny')
  })

  it('asks once per session even for concurrent requests and remembers denial', async () => {
    const ledger = new SessionGrantLedger()
    let resolveDecision: ((value: boolean) => void) | undefined
    const decide = vi.fn(() => new Promise<boolean>((resolve) => {
      resolveDecision = resolve
    }))

    const first = ledger.decidePermissionOnce(origin, 'geolocation', decide)
    const second = ledger.decidePermissionOnce(origin, 'geolocation', decide)
    expect(decide).toHaveBeenCalledTimes(1)
    resolveDecision?.(false)
    await expect(first).resolves.toBe(false)
    await expect(second).resolves.toBe(false)
    await expect(ledger.decidePermissionOnce(origin, 'geolocation', decide)).resolves.toBe(false)
    expect(decide).toHaveBeenCalledTimes(1)
  })

  it('scopes device grants to type, exact origin and identifier', () => {
    const ledger = new SessionGrantLedger()
    ledger.grantDevice('hid', origin, 'device-1')
    expect(ledger.hasDeviceGrant('hid', origin, 'device-1')).toBe(true)
    expect(ledger.hasDeviceGrant('usb', origin, 'device-1')).toBe(false)
    expect(ledger.hasDeviceGrant('hid', 'http://127.0.0.1:43128', 'device-1')).toBe(false)
    expect(ledger.hasDeviceGrant('hid', origin, 'device-2')).toBe(false)
    ledger.revokeDevice('hid', origin, 'device-1')
    expect(ledger.hasDeviceGrant('hid', origin, 'device-1')).toBe(false)
  })

  it('flattens control characters in native-dialog labels', () => {
    expect(safeDialogLabel('Camera\nCancel\u0000', 'fallback')).toBe('Camera Cancel')
    expect(safeDialogLabel(' \t ', 'fallback')).toBe('fallback')
    expect(safeDialogLabel('x'.repeat(110), 'fallback')).toHaveLength(100)
  })
})
