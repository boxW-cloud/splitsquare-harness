/** Exact readiness line emitted by the official Harness Web surface. */
const READY_LINE = /^dsh web: (http:\/\/127\.0\.0\.1:(\d{1,5}))\/?\s*$/

/**
 * Parse the official supervisor readiness line without accepting LAN hosts,
 * credentials, paths, or arbitrary output that merely contains a URL.
 */
export function parseHarnessReadyUrl(line: string): URL | undefined {
  const match = READY_LINE.exec(line.trim())
  if (match === null) return undefined
  const port = Number(match[2])
  if (!Number.isInteger(port) || port < 1 || port > 65_535) return undefined
  const parsed = new URL(match[1] as string)
  if (parsed.protocol !== 'http:'
    || parsed.hostname !== '127.0.0.1'
    || parsed.port !== String(port)
    || parsed.username !== ''
    || parsed.password !== '') return undefined
  return parsed
}

