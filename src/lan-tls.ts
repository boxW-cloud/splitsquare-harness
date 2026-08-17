import { X509Certificate } from 'node:crypto'
import { hostname as systemHostname } from 'node:os'
import { generate, type SubjectAltNameEntry } from 'selfsigned'
import { isPrivateLanIpv4 } from './lan-network.js'

export interface LanTlsMaterial {
  key: string
  cert: string
  fingerprint256: string
}

export interface LanTlsOptions {
  bindAddress: string
  hostname?: string
  validDays?: number
}

/** Generate an ephemeral server certificate; the private key never touches disk. */
export async function createLanTlsCertificate(options: LanTlsOptions): Promise<LanTlsMaterial> {
  if (!isPrivateLanIpv4(options.bindAddress) && options.bindAddress !== '127.0.0.1') {
    throw new Error('TLS bind address must be a private IPv4 address')
  }
  const validDays = options.validDays ?? 2
  if (!Number.isInteger(validDays) || validDays < 1 || validDays > 30) {
    throw new Error('TLS certificate validity must be between 1 and 30 days')
  }
  const hostname = options.hostname ?? systemHostname()
  if (hostname === '' || /[\u0000-\u0020/\\]/u.test(hostname)) {
    throw new Error('TLS hostname is invalid')
  }
  const dnsNames = [...new Set(['localhost', hostname])]
  const ipAddresses = [...new Set(['127.0.0.1', options.bindAddress])]
  const altNames: SubjectAltNameEntry[] = [
    ...dnsNames.map((value): SubjectAltNameEntry => ({ type: 2, value })),
    ...ipAddresses.map((ip): SubjectAltNameEntry => ({ type: 7, ip })),
  ]
  const now = Date.now()
  const result = await generate([{ name: 'commonName', value: hostname }], {
    algorithm: 'sha256',
    keySize: 2048,
    notBeforeDate: new Date(now - 5 * 60 * 1_000),
    notAfterDate: new Date(now + validDays * 24 * 60 * 60 * 1_000),
    extensions: [
      { name: 'basicConstraints', cA: false, critical: true },
      { name: 'keyUsage', digitalSignature: true, keyEncipherment: true, critical: true },
      { name: 'extKeyUsage', serverAuth: true },
      { name: 'subjectAltName', altNames },
    ],
  })
  const certificate = new X509Certificate(result.cert)
  return {
    key: result.private,
    cert: result.cert,
    fingerprint256: certificate.fingerprint256,
  }
}
