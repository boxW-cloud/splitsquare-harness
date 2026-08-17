import { describe, expect, it } from 'vitest'
import {
  classifyPrivateIpv4,
  listPrivateLanAddresses,
  pickPreferredLanAddress,
} from '../src/lan-network.js'

describe('LAN network selection', () => {
  it.each([
    ['10.0.0.0', 'rfc1918'],
    ['10.255.255.255', 'rfc1918'],
    ['172.16.0.0', 'rfc1918'],
    ['172.31.255.255', 'rfc1918'],
    ['192.168.0.0', 'rfc1918'],
    ['100.64.0.0', 'cgnat'],
    ['100.127.255.255', 'cgnat'],
    ['169.254.0.0', 'link-local'],
  ] as const)('classifies %s as %s', (address, kind) => {
    expect(classifyPrivateIpv4(address)).toBe(kind)
  })

  it.each([
    '9.255.255.255', '11.0.0.0', '172.15.255.255', '172.32.0.0',
    '192.167.255.255', '192.169.0.0', '100.63.255.255', '100.128.0.0',
    '127.0.0.1', '224.0.0.1', '1.2.3', '01.2.3.4', '256.1.1.1', '-1.2.3.4',
  ])('rejects non-LAN or malformed IPv4 %s', (address) => {
    expect(classifyPrivateIpv4(address)).toBeUndefined()
  })

  it('filters unusable addresses and prefers the real WLAN over VMware and WSL', () => {
    const interfaces = {
      'vEthernet (WSL (Hyper-V firewall))': [{ address: '172.25.16.1', family: 'IPv4' }],
      'VMware Network Adapter VMnet8': [{ address: '192.168.108.1', family: 4 }],
      WLAN: [{ address: '192.168.1.6', family: 'IPv4', cidr: '192.168.1.6/24' }],
      Loopback: [{ address: '127.0.0.1', family: 'IPv4', internal: true }],
      Public: [{ address: '8.8.8.8', family: 'IPv4' }],
      IPv6: [{ address: 'fd00::1', family: 'IPv6' }],
    } as const
    const candidates = listPrivateLanAddresses(interfaces)
    const snapshot = structuredClone(candidates)
    expect(candidates.map((item) => item.address)).toEqual([
      '192.168.1.6',
      '172.25.16.1',
      '192.168.108.1',
    ])
    expect(pickPreferredLanAddress(candidates)?.address).toBe('192.168.1.6')
    expect(candidates).toEqual(snapshot)
  })
})
