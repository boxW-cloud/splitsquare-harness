import { networkInterfaces } from 'node:os'

export type PrivateIpv4Kind = 'rfc1918' | 'cgnat' | 'link-local'

export interface NetworkAddressLike {
  address: string
  family: string | number
  internal?: boolean
  netmask?: string
  cidr?: string | null
  mac?: string
}

export type NetworkInterfacesLike = Readonly<
  Record<string, readonly NetworkAddressLike[] | undefined>
>

export interface LanAddressCandidate {
  interfaceName: string
  address: string
  netmask?: string
  cidr?: string | null
  mac?: string
  virtual: boolean
  score: number
}

const VIRTUAL_NAME = /(?:vEthernet|VMware|VMnet|VirtualBox|VBox|WSL|Docker|Hyper-?V|virbr|\bTAP\b|\bTUN\b|Tailscale|ZeroTier|WireGuard)/iu

export function classifyPrivateIpv4(address: string): PrivateIpv4Kind | undefined {
  const octets = parseIpv4(address)
  if (octets === undefined) return undefined
  const [a, b] = octets
  if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) {
    return 'rfc1918'
  }
  if (a === 100 && b >= 64 && b <= 127) return 'cgnat'
  if (a === 169 && b === 254) return 'link-local'
  return undefined
}

export function isPrivateLanIpv4(address: string): boolean {
  return classifyPrivateIpv4(address) !== undefined
}

export function listPrivateLanAddresses(
  interfaces: NetworkInterfacesLike = networkInterfaces(),
): LanAddressCandidate[] {
  const candidates: LanAddressCandidate[] = []
  for (const [interfaceName, addresses] of Object.entries(interfaces)) {
    for (const item of addresses ?? []) {
      if (item.internal === true || (item.family !== 4 && item.family !== 'IPv4')) continue
      const kind = classifyPrivateIpv4(item.address)
      if (kind === undefined) continue
      const virtual = VIRTUAL_NAME.test(interfaceName)
      candidates.push({
        interfaceName,
        address: item.address,
        ...(item.netmask === undefined ? {} : { netmask: item.netmask }),
        ...(item.cidr === undefined ? {} : { cidr: item.cidr }),
        ...(item.mac === undefined ? {} : { mac: item.mac }),
        virtual,
        score: scoreCandidate(interfaceName, kind, virtual),
      })
    }
  }
  return candidates.sort(compareCandidate)
}

export function pickPreferredLanAddress(
  candidates: readonly LanAddressCandidate[] = listPrivateLanAddresses(),
): LanAddressCandidate | undefined {
  return [...candidates].sort(compareCandidate)[0]
}

function scoreCandidate(name: string, kind: PrivateIpv4Kind, virtual: boolean): number {
  let score = virtual ? -1_000 : 100
  if (/(?:WLAN|Wi-?Fi|Wireless)/iu.test(name)) score += 300
  else if (/(?:Ethernet|Local Area)/iu.test(name)) score += 250
  else if (/^(?:en|eth)/iu.test(name)) score += 200
  if (kind === 'rfc1918') score += 30
  else if (kind === 'cgnat') score += 20
  else score -= 100
  return score
}

function compareCandidate(left: LanAddressCandidate, right: LanAddressCandidate): number {
  if (left.score !== right.score) return right.score - left.score
  const byInterface = left.interfaceName.localeCompare(right.interfaceName)
  return byInterface === 0 ? left.address.localeCompare(right.address) : byInterface
}

function parseIpv4(value: string): [number, number, number, number] | undefined {
  const parts = value.split('.')
  if (parts.length !== 4) return undefined
  const octets: number[] = []
  for (const part of parts) {
    if (!/^(?:0|[1-9][0-9]{0,2})$/u.test(part)) return undefined
    const value = Number(part)
    if (value > 255) return undefined
    octets.push(value)
  }
  return octets as [number, number, number, number]
}
