import { X509Certificate } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { createLanTlsCertificate } from '../src/lan-tls.js'

describe('ephemeral LAN TLS', () => {
  it('covers the selected IP and host with a SHA-256 server certificate', async () => {
    const material = await createLanTlsCertificate({
      bindAddress: '192.168.1.6',
      hostname: 'dsh-test-host',
      validDays: 1,
    })
    const certificate = new X509Certificate(material.cert)
    expect(certificate.checkHost('localhost')).toBe('localhost')
    expect(certificate.checkHost('dsh-test-host')).toBe('dsh-test-host')
    expect(certificate.checkIP('127.0.0.1')).toBe('127.0.0.1')
    expect(certificate.checkIP('192.168.1.6')).toBe('192.168.1.6')
    expect(material.fingerprint256).toBe(certificate.fingerprint256)
    expect(material.key).toContain('PRIVATE KEY')
  })

  it('rejects public IPs and excessive certificate lifetimes', async () => {
    await expect(createLanTlsCertificate({ bindAddress: '8.8.8.8' })).rejects.toThrow()
    await expect(createLanTlsCertificate({ bindAddress: '192.168.1.6', validDays: 31 })).rejects.toThrow()
  })
})
