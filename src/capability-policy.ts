/** Permissions which the desktop shell intentionally supports. */
export const promptedPermissions = [
  'clipboard-read',
  'display-capture',
  'fullscreen',
  'geolocation',
  'media',
  'midi',
  'midiSysex',
  'notifications',
  'pointerLock',
  'speaker-selection',
] as const

export const automaticPermissions = [
  'clipboard-sanitized-write',
  'fileSystem',
] as const

export const deviceChooserPermissions = ['hid', 'serial', 'usb'] as const

export type PromptedPermission = (typeof promptedPermissions)[number]
export type AutomaticPermission = (typeof automaticPermissions)[number]
export type DeviceChooserPermission = (typeof deviceChooserPermissions)[number]
export type SupportedPermission =
  | PromptedPermission
  | AutomaticPermission
  | DeviceChooserPermission
export type PermissionDisposition = 'allow' | 'prompt' | 'deny'
export type DeviceKind = DeviceChooserPermission | 'bluetooth'

const prompted = new Set<string>(promptedPermissions)
const automatic = new Set<string>(automaticPermissions)
const deviceChooser = new Set<string>(deviceChooserPermissions)

/** Unknown Electron/Chromium permissions are deliberately denied. */
export function permissionDisposition(permission: string): PermissionDisposition {
  if (prompted.has(permission)) return 'prompt'
  if (automatic.has(permission) || deviceChooser.has(permission)) return 'allow'
  return 'deny'
}

function parsedUrl(value: string): URL | undefined {
  try {
    const url = new URL(value)
    if (url.username !== '' || url.password !== '') return undefined
    return url
  } catch {
    return undefined
  }
}

/**
 * Canonicalize the one origin a Harness renderer may hold capabilities for.
 * The desktop backend is deliberately limited to an explicit IPv4 loopback port.
 */
export function canonicalHarnessOrigin(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  const url = parsedUrl(value)
  if (
    url === undefined
    || url.protocol !== 'http:'
    || url.hostname !== '127.0.0.1'
    || url.port === ''
  ) return undefined
  return url.origin
}

/** Compare parsed origins; never use prefix/suffix matching for capability checks. */
export function isExactHarnessOrigin(candidate: string, trustedOrigin: string | undefined): boolean {
  const expected = canonicalHarnessOrigin(trustedOrigin)
  const url = parsedUrl(candidate)
  return expected !== undefined && url !== undefined && url.origin === expected
}

export interface MainFrameRequestContext {
  readonly requestingWebContents: object | null
  readonly trustedWebContents: object
  readonly isMainFrame: boolean
  readonly requestingUrl: string
  readonly currentMainFrameUrl: string
  readonly trustedOrigin: string | undefined
  readonly embeddingOrigin?: string
  readonly securityOrigin?: string
}

/** Pure policy used by the Electron adapters for every frame-bound request. */
export function isExactMainFrameRequest(context: MainFrameRequestContext): boolean {
  if (
    context.requestingWebContents !== context.trustedWebContents
    || !context.isMainFrame
    || !isExactHarnessOrigin(context.requestingUrl, context.trustedOrigin)
    || !isExactHarnessOrigin(context.currentMainFrameUrl, context.trustedOrigin)
  ) return false

  if (
    context.embeddingOrigin !== undefined
    && !isExactHarnessOrigin(context.embeddingOrigin, context.trustedOrigin)
  ) return false

  return context.securityOrigin === undefined
    || isExactHarnessOrigin(context.securityOrigin, context.trustedOrigin)
}

function compositeKey(parts: readonly string[]): string {
  return JSON.stringify(parts)
}

/** Permission decisions and device grants live only for this app session. */
export class SessionGrantLedger {
  readonly #decisions = new Map<string, boolean>()
  readonly #pendingDecisions = new Map<string, Promise<boolean>>()
  readonly #deviceGrants = new Set<string>()
  #generation = 0

  permissionDecision(origin: string, capability: string): boolean | undefined {
    return this.#decisions.get(compositeKey(['permission', origin, capability]))
  }

  rememberPermissionDecision(origin: string, capability: string, granted: boolean): void {
    this.#decisions.set(compositeKey(['permission', origin, capability]), granted)
  }

  async decidePermissionOnce(
    origin: string,
    capability: string,
    decide: () => Promise<boolean>,
  ): Promise<boolean> {
    const key = compositeKey(['permission', origin, capability])
    const remembered = this.#decisions.get(key)
    if (remembered !== undefined) return remembered

    const pending = this.#pendingDecisions.get(key)
    if (pending !== undefined) return pending

    const generation = this.#generation
    const decision = decide()
      .then((granted) => {
        if (this.#generation === generation) this.#decisions.set(key, granted)
        return granted
      })
      .finally(() => this.#pendingDecisions.delete(key))
    this.#pendingDecisions.set(key, decision)
    return decision
  }

  grantDevice(kind: DeviceKind, origin: string, identifier: string): void {
    if (identifier === '') return
    this.#deviceGrants.add(compositeKey(['device', kind, origin, identifier]))
  }

  hasDeviceGrant(kind: DeviceKind, origin: string, identifier: string): boolean {
    return identifier !== ''
      && this.#deviceGrants.has(compositeKey(['device', kind, origin, identifier]))
  }

  revokeDevice(kind: DeviceKind, origin: string, identifier: string): void {
    this.#deviceGrants.delete(compositeKey(['device', kind, origin, identifier]))
  }

  clear(): void {
    this.#generation += 1
    this.#decisions.clear()
    this.#pendingDecisions.clear()
    this.#deviceGrants.clear()
  }
}

/** Keep untrusted device/path text from changing the shape of a native dialog. */
export function safeDialogLabel(value: string | undefined, fallback: string): string {
  const cleaned = (value ?? '')
    .replace(/[\u0000-\u001f\u007f]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
  if (cleaned === '') return fallback
  return cleaned.length <= 100 ? cleaned : `${cleaned.slice(0, 99)}\u2026`
}
