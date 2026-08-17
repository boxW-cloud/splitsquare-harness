import { createHash, randomBytes as secureRandomBytes, timingSafeEqual } from 'node:crypto'
import type { LanGatewayAuthenticator, PairingExchangeResult } from './lan-gateway.js'

export const REMOTE_COOKIE_NAME = '__Host-dsh-remote'
const PAIRING_TTL_MS = 5 * 60 * 1_000
const SESSION_TTL_MS = 12 * 60 * 60 * 1_000
const ATTEMPT_WINDOW_MS = 5 * 60 * 1_000
const MAX_ATTEMPTS_PER_WINDOW = 5

export interface RemoteAuthOptions {
  now?: () => number
  randomBytes?: (size: number) => Uint8Array
}

export interface PairingChallenge {
  code: string
  expiresAt: number
}

export type PairingResult =
  | { ok: true; sessionToken: string; cookie: string; expiresAt: number }
  | { ok: false; reason: 'invalid' | 'expired' | 'rate-limited'; retryAfterMs?: number }

interface StoredPairing {
  digest: Buffer
  expiresAt: number
}

/** In-memory, generation-scoped authentication for remote browser access. */
export class RemoteAuth implements LanGatewayAuthenticator {
  readonly cookieName = REMOTE_COOKIE_NAME
  private readonly now: () => number
  private readonly entropy: (size: number) => Uint8Array
  private pairing: StoredPairing | undefined
  private readonly sessions = new Map<string, number>()
  private readonly attempts = new Map<string, number[]>()

  constructor(options: RemoteAuthOptions = {}) {
    this.now = options.now ?? Date.now
    this.entropy = options.randomBytes ?? secureRandomBytes
  }

  createPairing(): PairingChallenge {
    const code = Buffer.from(this.entropy(32)).toString('base64url')
    const expiresAt = this.now() + PAIRING_TTL_MS
    this.pairing = { digest: digest(code), expiresAt }
    return { code, expiresAt }
  }

  verifyPairing(code: string, ip: string): PairingResult {
    const now = this.now()
    const retryAfterMs = this.recordAttempt(ip, now)
    if (retryAfterMs !== undefined) {
      return { ok: false, reason: 'rate-limited', retryAfterMs }
    }
    const pairing = this.pairing
    if (pairing === undefined || now >= pairing.expiresAt) {
      this.pairing = undefined
      return { ok: false, reason: 'expired' }
    }
    const supplied = digest(code)
    if (!timingSafeEqual(pairing.digest, supplied)) return { ok: false, reason: 'invalid' }

    this.pairing = undefined
    const sessionToken = Buffer.from(this.entropy(32)).toString('base64url')
    const expiresAt = now + SESSION_TTL_MS
    this.sessions.set(digestKey(sessionToken), expiresAt)
    return {
      ok: true,
      sessionToken,
      expiresAt,
      cookie: `${this.cookieName}=${sessionToken}; Path=/; Max-Age=43200; HttpOnly; Secure; SameSite=Strict`,
    }
  }

  exchangePairing(code: string, clientAddress: string): PairingExchangeResult {
    const result = this.verifyPairing(code, clientAddress)
    if (result.ok) return { ok: true, setCookie: result.cookie }
    if (result.reason === 'rate-limited') {
      return {
        ok: false,
        retryAfterSeconds: Math.max(1, Math.ceil((result.retryAfterMs ?? 1_000) / 1_000)),
      }
    }
    return { ok: false }
  }

  authenticate(cookieHeader: string | undefined): boolean {
    return this.sessionExpiresAt(cookieHeader) !== undefined
  }

  sessionExpiresAt(cookieHeader: string | undefined): number | undefined {
    const token = uniqueCookie(cookieHeader, this.cookieName)
    if (token === undefined) return undefined
    const key = digestKey(token)
    const expiresAt = this.sessions.get(key)
    if (expiresAt === undefined) return undefined
    if (this.now() >= expiresAt) {
      this.sessions.delete(key)
      return undefined
    }
    return expiresAt
  }

  revokeAll(): void {
    this.pairing = undefined
    this.sessions.clear()
    this.attempts.clear()
  }

  private recordAttempt(ip: string, now: number): number | undefined {
    const threshold = now - ATTEMPT_WINDOW_MS
    const recent = (this.attempts.get(ip) ?? []).filter((time) => time > threshold)
    if (recent.length >= MAX_ATTEMPTS_PER_WINDOW) {
      this.attempts.set(ip, recent)
      return (recent[0] as number) + ATTEMPT_WINDOW_MS - now
    }
    recent.push(now)
    this.attempts.set(ip, recent)
    return undefined
  }
}

function digest(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest()
}

function digestKey(value: string): string {
  return digest(value).toString('base64url')
}

function uniqueCookie(header: string | undefined, name: string): string | undefined {
  if (header === undefined) return undefined
  const values: string[] = []
  for (const part of header.split(';')) {
    const separator = part.indexOf('=')
    if (separator < 1 || part.slice(0, separator).trim() !== name) continue
    values.push(part.slice(separator + 1).trim())
  }
  return values.length === 1 && values[0] !== '' ? values[0] : undefined
}
