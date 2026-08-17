import { describe, expect, it } from 'vitest'
import { RemoteAuth, REMOTE_COOKIE_NAME } from '../src/remote-auth.js'

function deterministicEntropy(): (size: number) => Uint8Array {
  let next = 1
  return (size) => Uint8Array.from({ length: size }, () => next++ % 256)
}

describe('remote authentication', () => {
  it('issues a one-time 256-bit pairing challenge and a hardened session cookie', () => {
    let now = 1_000
    const auth = new RemoteAuth({ now: () => now, randomBytes: deterministicEntropy() })
    const challenge = auth.createPairing()
    expect(Buffer.from(challenge.code, 'base64url')).toHaveLength(32)
    expect(challenge.expiresAt).toBe(301_000)

    const result = auth.verifyPairing(challenge.code, '192.168.1.9')
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('expected successful pairing')
    expect(result.cookie).toContain(`${REMOTE_COOKIE_NAME}=`)
    expect(result.cookie).toContain('Path=/')
    expect(result.cookie).toContain('Max-Age=43200')
    expect(result.cookie).toContain('HttpOnly')
    expect(result.cookie).toContain('Secure')
    expect(result.cookie).toContain('SameSite=Strict')
    expect(auth.authenticate(`${REMOTE_COOKIE_NAME}=${result.sessionToken}`)).toBe(true)
    expect(auth.verifyPairing(challenge.code, '192.168.1.9')).toMatchObject({ ok: false })

    now += 12 * 60 * 60 * 1_000
    expect(auth.authenticate(`${REMOTE_COOKIE_NAME}=${result.sessionToken}`)).toBe(false)
  })

  it('expires pairing at five minutes and rejects duplicate cookie names', () => {
    let now = 0
    const auth = new RemoteAuth({ now: () => now, randomBytes: deterministicEntropy() })
    const challenge = auth.createPairing()
    now = 5 * 60 * 1_000
    expect(auth.verifyPairing(challenge.code, 'ip')).toEqual({ ok: false, reason: 'expired' })

    now = 0
    const next = auth.createPairing()
    const result = auth.verifyPairing(next.code, 'ip')
    if (!result.ok) throw new Error('expected successful pairing')
    expect(auth.authenticate(
      `${REMOTE_COOKIE_NAME}=${result.sessionToken}; ${REMOTE_COOKIE_NAME}=${result.sessionToken}`,
    )).toBe(false)
  })

  it('allows five attempts per IP, rate limits the sixth, and recovers after the window', () => {
    let now = 0
    const auth = new RemoteAuth({ now: () => now, randomBytes: deterministicEntropy() })
    auth.createPairing()
    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect(auth.verifyPairing('wrong', '192.168.1.2')).toEqual({ ok: false, reason: 'invalid' })
    }
    expect(auth.verifyPairing('wrong', '192.168.1.2')).toEqual({
      ok: false,
      reason: 'rate-limited',
      retryAfterMs: 300_000,
    })
    expect(auth.verifyPairing('wrong', '192.168.1.3')).toEqual({ ok: false, reason: 'invalid' })
    now = 300_001
    expect(auth.verifyPairing('wrong', '192.168.1.2')).toEqual({ ok: false, reason: 'expired' })
  })

  it('revokes pairing and every active session', () => {
    const auth = new RemoteAuth({ randomBytes: deterministicEntropy() })
    const challenge = auth.createPairing()
    const result = auth.verifyPairing(challenge.code, 'ip')
    if (!result.ok) throw new Error('expected successful pairing')
    auth.createPairing()
    auth.revokeAll()
    expect(auth.authenticate(`${REMOTE_COOKIE_NAME}=${result.sessionToken}`)).toBe(false)
    expect(auth.verifyPairing(challenge.code, 'ip')).toEqual({ ok: false, reason: 'expired' })
  })
})
