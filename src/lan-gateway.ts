import { request as httpRequest, type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from 'node:http'
import { createServer as createHttpsServer } from 'node:https'
import { connect as connectTcp } from 'node:net'
import type { Duplex } from 'node:stream'

const CONTROL_PREFIX = '/__desktop__/'
const LOGIN_PATH = `${CONTROL_PREFIX}login`
const PAIR_PATH = `${CONTROL_PREFIX}pair`
const LOGOUT_PATH = `${CONTROL_PREFIX}logout`
const MAX_PAIR_BODY_BYTES = 4_096

const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
])

const FORWARDED_HEADERS = new Set([
  'forwarded',
  'x-forwarded-for',
  'x-forwarded-host',
  'x-forwarded-port',
  'x-forwarded-proto',
  'x-real-ip',
])

export interface LanGatewayTls {
  key: string | Buffer
  cert: string | Buffer
  fingerprint256: string
}

export interface PairingExchangeResult {
  ok: boolean
  setCookie?: string
  retryAfterSeconds?: number
}

/** The gateway never sees a persistent plaintext credential through this seam. */
export interface LanGatewayAuthenticator {
  readonly cookieName: string
  authenticate(cookieHeader: string | undefined, clientAddress: string): boolean
  sessionExpiresAt(cookieHeader: string | undefined, clientAddress: string): number | undefined
  exchangePairing(code: string, clientAddress: string): PairingExchangeResult
  revokeAll(): void
}

export interface LanGatewayOptions {
  bindAddress: string
  port?: number
  tls: LanGatewayTls
  auth: LanGatewayAuthenticator
}

export interface LanGatewayStatus {
  address: string
  port: number
  origin: string
  fingerprint256: string
  target?: string
}

interface Target {
  url: URL
  generation: number
}

/**
 * Authenticated, fixed-target HTTPS/WSS gateway for one loopback Harness process.
 * It is deliberately not a forward proxy: the client can never select a host.
 */
export class LanGateway {
  private readonly server: ReturnType<typeof createHttpsServer>
  private readonly sockets = new Set<Duplex>()
  private target: Target | undefined
  private publicOrigin: string | undefined
  private authority: string | undefined
  private generation = 0

  constructor(private readonly options: LanGatewayOptions) {
    this.server = createHttpsServer({
      key: this.options.tls.key,
      cert: this.options.tls.cert,
      minVersion: 'TLSv1.2',
    }, (request, response) => void this.handleRequest(request, response))
    this.server.on('connection', (socket) => {
      this.sockets.add(socket)
      socket.once('close', () => this.sockets.delete(socket))
    })
    this.server.on('upgrade', (request, socket, head) => {
      this.handleUpgrade(request, socket, head)
    })
    this.server.on('clientError', (_error, socket) => {
      if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n')
    })
  }

  async start(target?: URL): Promise<LanGatewayStatus> {
    if (this.publicOrigin !== undefined) throw new Error('LAN gateway is already running')
    if (target !== undefined) this.target = { url: validateTarget(target), generation: ++this.generation }
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => {
        this.server.off('listening', onListening)
        reject(error)
      }
      const onListening = (): void => {
        this.server.off('error', onError)
        resolve()
      }
      this.server.once('error', onError)
      this.server.once('listening', onListening)
      this.server.listen({
        host: this.options.bindAddress,
        port: this.options.port ?? 0,
        exclusive: true,
      })
    })
    const address = this.server.address()
    if (address === null || typeof address === 'string') {
      await this.stop()
      throw new Error('LAN gateway did not receive an IP listener address')
    }
    const advertised = new URL(`https://${formatHost(address.address)}:${String(address.port)}/`)
    this.authority = advertised.host
    this.publicOrigin = advertised.origin
    return this.status()
  }

  status(): LanGatewayStatus {
    const origin = this.publicOrigin
    const address = this.server.address()
    if (origin === undefined || address === null || typeof address === 'string') {
      throw new Error('LAN gateway is not running')
    }
    return {
      address: address.address,
      port: address.port,
      origin,
      fingerprint256: this.options.tls.fingerprint256,
      ...(this.target === undefined ? {} : { target: this.target.url.origin }),
    }
  }

  /** Changing a backend generation revokes every remote session and connection. */
  setTarget(target: URL | undefined): void {
    this.generation += 1
    this.target = target === undefined ? undefined : {
      url: validateTarget(target),
      generation: this.generation,
    }
    this.options.auth.revokeAll()
    this.destroyConnections()
  }

  async stop(): Promise<void> {
    this.target = undefined
    this.options.auth.revokeAll()
    this.destroyConnections()
    if (!this.server.listening) {
      this.publicOrigin = undefined
      this.authority = undefined
      return
    }
    await new Promise<void>((resolve) => this.server.close(() => resolve()))
    this.publicOrigin = undefined
    this.authority = undefined
  }

  private destroyConnections(): void {
    for (const socket of this.sockets) socket.destroy()
    this.sockets.clear()
    this.server.closeIdleConnections()
  }

  private requestIsValid(request: IncomingMessage): boolean {
    const authority = this.authority
    const origin = this.publicOrigin
    if (authority === undefined || origin === undefined) return false
    if (!hasOneRawHeader(request, 'host')) return false
    if (request.headers.host?.toLowerCase() !== authority.toLowerCase()) return false
    if (request.headers['content-length'] !== undefined && request.headers['transfer-encoding'] !== undefined) return false
    const rawUrl = request.url
    if (rawUrl === undefined || !isOriginForm(rawUrl)) return false
    const suppliedOrigin = singleHeader(request.headers.origin)
    if (suppliedOrigin !== undefined && suppliedOrigin !== origin) return false
    return true
  }

  private async handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (!this.requestIsValid(request)) {
      sendText(response, 400, 'Bad request')
      return
    }
    const method = (request.method ?? 'GET').toUpperCase()
    if (method === 'CONNECT' || method === 'TRACE') {
      sendText(response, 405, 'Method not allowed')
      return
    }
    const origin = this.publicOrigin as string
    const parsed = new URL(request.url as string, origin)
    const address = clientAddress(request.socket.remoteAddress)

    if (parsed.pathname === LOGIN_PATH && (method === 'GET' || method === 'HEAD')) {
      sendLoginPage(response, method === 'HEAD')
      return
    }
    if (parsed.pathname === PAIR_PATH && method === 'POST') {
      if (singleHeader(request.headers.origin) !== origin) {
        sendText(response, 403, 'Cross-origin pairing is not allowed')
        return
      }
      try {
        const body = await readSmallBody(request, MAX_PAIR_BODY_BYTES)
        const code = new URLSearchParams(body).get('code') ?? ''
        const result = this.options.auth.exchangePairing(code, address)
        if (!result.ok || result.setCookie === undefined) {
          if (result.retryAfterSeconds !== undefined) {
            response.setHeader('Retry-After', String(result.retryAfterSeconds))
          }
          sendText(response, result.retryAfterSeconds === undefined ? 401 : 429, 'Pairing failed')
          return
        }
        response.statusCode = 303
        response.setHeader('Cache-Control', 'no-store')
        response.setHeader('Set-Cookie', result.setCookie)
        response.setHeader('Location', '/')
        response.end()
      } catch (error) {
        sendText(response, error instanceof BodyTooLargeError ? 413 : 400, 'Invalid pairing request')
      }
      return
    }

    const sessionExpiresAt = this.options.auth.sessionExpiresAt(request.headers.cookie, address)
    const authenticated = sessionExpiresAt !== undefined
    if (parsed.pathname === LOGOUT_PATH && method === 'POST') {
      if (!authenticated || singleHeader(request.headers.origin) !== origin) {
        sendText(response, 403, 'Forbidden')
        return
      }
      this.options.auth.revokeAll()
      response.once('finish', () => setImmediate(() => this.destroyConnections()))
      response.statusCode = 303
      response.setHeader('Cache-Control', 'no-store')
      response.setHeader('Set-Cookie', expiredCookie(this.options.auth.cookieName))
      response.setHeader('Location', LOGIN_PATH)
      response.end()
      return
    }
    if (parsed.pathname.startsWith(CONTROL_PREFIX)) {
      sendText(response, 404, 'Not found')
      return
    }
    if (!authenticated) {
      if (method === 'GET' || method === 'HEAD') {
        response.statusCode = 303
        response.setHeader('Cache-Control', 'no-store')
        response.setHeader('Location', LOGIN_PATH)
        response.end()
      } else {
        sendText(response, 401, 'Authentication required')
      }
      return
    }
    if (isUnsafeMethod(method) && singleHeader(request.headers.origin) !== origin) {
      sendText(response, 403, 'Origin required')
      return
    }
    this.proxyHttp(request, response, sessionExpiresAt as number)
  }

  private proxyHttp(
    request: IncomingMessage,
    response: ServerResponse,
    sessionExpiresAt: number,
  ): void {
    const target = this.target
    const publicOrigin = this.publicOrigin
    if (target === undefined || publicOrigin === undefined) {
      sendText(response, 503, 'Harness is unavailable')
      return
    }
    const headers = requestHeaders(request.headers, {
      targetOrigin: target.url.origin,
      targetAuthority: target.url.host,
      publicOrigin,
      gatewayCookieName: this.options.auth.cookieName,
      websocket: false,
    })
    const upstream = httpRequest({
      protocol: 'http:',
      hostname: target.url.hostname,
      port: Number(target.url.port),
      method: request.method,
      path: request.url,
      headers,
      agent: false,
    }, (upstreamResponse) => {
      if (this.target?.generation !== target.generation) {
        upstreamResponse.destroy()
        return
      }
      response.statusCode = upstreamResponse.statusCode ?? 502
      if (upstreamResponse.statusMessage !== undefined) response.statusMessage = upstreamResponse.statusMessage
      applyResponseHeaders(
        response,
        upstreamResponse.headers,
        target.url.origin,
        publicOrigin,
        this.options.auth.cookieName,
      )
      upstreamResponse.pipe(response)
    })
    upstream.once('error', () => {
      if (!response.headersSent) sendText(response, 502, 'Harness proxy failed')
      else response.destroy()
    })
    request.once('aborted', () => upstream.destroy())
    const expiryTimer = setTimeout(() => {
      upstream.destroy()
      request.socket.destroy()
    }, remainingSessionMs(sessionExpiresAt))
    response.once('finish', () => clearTimeout(expiryTimer))
    response.once('close', () => {
      clearTimeout(expiryTimer)
      if (!response.writableEnded) upstream.destroy()
    })
    request.pipe(upstream)
  }

  private handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void {
    if (!this.requestIsValid(request) || (request.method ?? '').toUpperCase() !== 'GET') {
      rejectUpgrade(socket, 400, 'Bad Request')
      return
    }
    const publicOrigin = this.publicOrigin as string
    const suppliedOrigin = singleHeader(request.headers.origin)
    const address = clientAddress(request.socket.remoteAddress)
    const sessionExpiresAt = this.options.auth.sessionExpiresAt(request.headers.cookie, address)
    if (suppliedOrigin !== publicOrigin || sessionExpiresAt === undefined) {
      rejectUpgrade(socket, 403, 'Forbidden')
      return
    }
    const target = this.target
    if (target === undefined) {
      rejectUpgrade(socket, 503, 'Service Unavailable')
      return
    }
    const headers = requestHeaders(request.headers, {
      targetOrigin: target.url.origin,
      targetAuthority: target.url.host,
      publicOrigin,
      gatewayCookieName: this.options.auth.cookieName,
      websocket: true,
    })
    const upstream = connectTcp({ host: target.url.hostname, port: Number(target.url.port) })
    const expiryTimer = setTimeout(() => {
      upstream.destroy()
      socket.destroy()
    }, remainingSessionMs(sessionExpiresAt))
    this.sockets.add(upstream)
    upstream.once('close', () => {
      clearTimeout(expiryTimer)
      this.sockets.delete(upstream)
    })
    upstream.once('connect', () => {
      if (this.target?.generation !== target.generation) {
        upstream.destroy()
        socket.destroy()
        return
      }
      const lines = [`GET ${request.url as string} HTTP/1.1`]
      for (const [name, value] of Object.entries(headers)) {
        if (value === undefined) continue
        if (Array.isArray(value)) {
          for (const item of value) lines.push(`${name}: ${item}`)
        } else {
          lines.push(`${name}: ${String(value)}`)
        }
      }
      upstream.write(`${lines.join('\r\n')}\r\n\r\n`)
      if (head.length > 0) upstream.write(head)
      socket.pipe(upstream).pipe(socket)
    })
    upstream.once('error', () => {
      if (socket.writable) rejectUpgrade(socket, 502, 'Bad Gateway')
      else socket.destroy()
    })
    socket.once('error', () => upstream.destroy())
  }
}

export function validateTarget(input: URL): URL {
  const target = new URL(input.href)
  if (target.protocol !== 'http:'
    || target.hostname !== '127.0.0.1'
    || target.username !== ''
    || target.password !== ''
    || target.pathname !== '/'
    || target.search !== ''
    || target.hash !== ''
    || target.port === '') {
    throw new Error('LAN gateway target must be an exact numeric loopback HTTP origin')
  }
  const port = Number(target.port)
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error('LAN gateway target port is invalid')
  }
  return target
}

function formatHost(address: string): string {
  return address.includes(':') ? `[${address}]` : address
}

function clientAddress(address: string | undefined): string {
  if (address === undefined || address === '') return 'unknown'
  return address.startsWith('::ffff:') ? address.slice(7) : address
}

function hasOneRawHeader(request: IncomingMessage, name: string): boolean {
  let count = 0
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    if (request.rawHeaders[index]?.toLowerCase() === name) count += 1
  }
  return count === 1
}

function isOriginForm(value: string): boolean {
  return value.startsWith('/')
    && !value.startsWith('//')
    && !/[\\\u0000-\u001f\u007f]/u.test(value)
}

function singleHeader(value: string | string[] | undefined): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function isUnsafeMethod(method: string): boolean {
  return method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS'
}

function remainingSessionMs(expiresAt: number): number {
  return Math.max(1, Math.min(2_147_483_647, expiresAt - Date.now()))
}

function requestHeaders(
  input: IncomingHttpHeaders,
  options: {
    targetOrigin: string
    targetAuthority: string
    publicOrigin: string
    gatewayCookieName: string
    websocket: boolean
  },
): IncomingHttpHeaders {
  const output: IncomingHttpHeaders = {}
  for (const [name, value] of Object.entries(input)) {
    const lower = name.toLowerCase()
    if (HOP_BY_HOP_HEADERS.has(lower) || FORWARDED_HEADERS.has(lower) || lower === 'host') continue
    if (lower === 'origin') {
      output.origin = options.targetOrigin
      continue
    }
    if (lower === 'referer') {
      const referer = rewriteReferer(singleHeader(value), options.publicOrigin, options.targetOrigin)
      if (referer !== undefined) output.referer = referer
      continue
    }
    if (lower === 'cookie') {
      const cookie = stripCookie(singleHeader(value), options.gatewayCookieName)
      if (cookie !== undefined) output.cookie = cookie
      continue
    }
    output[lower] = value
  }
  output.host = options.targetAuthority
  if (options.websocket) {
    output.connection = 'Upgrade'
    output.upgrade = 'websocket'
  }
  return output
}

function rewriteReferer(
  referer: string | undefined,
  publicOrigin: string,
  targetOrigin: string,
): string | undefined {
  if (referer === undefined) return undefined
  try {
    const parsed = new URL(referer)
    if (parsed.origin !== publicOrigin) return undefined
    return `${targetOrigin}${parsed.pathname}${parsed.search}${parsed.hash}`
  } catch {
    return undefined
  }
}

function stripCookie(header: string | undefined, reservedName: string): string | undefined {
  if (header === undefined) return undefined
  const kept = header.split(';').map((part) => part.trim()).filter((part) => {
    const separator = part.indexOf('=')
    return separator > 0 && part.slice(0, separator).trim() !== reservedName
  })
  return kept.length === 0 ? undefined : kept.join('; ')
}

function applyResponseHeaders(
  response: ServerResponse,
  headers: IncomingHttpHeaders,
  targetOrigin: string,
  publicOrigin: string,
  gatewayCookieName: string,
): void {
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase()
    if (HOP_BY_HOP_HEADERS.has(lower) || lower === 'server' || value === undefined) continue
    if (lower === 'set-cookie') {
      const values = (Array.isArray(value) ? value : [value])
        .map((item) => rewriteSetCookie(item, gatewayCookieName))
        .filter((item): item is string => item !== undefined)
      if (values.length > 0) response.setHeader(name, values)
      continue
    }
    if (lower === 'location' && typeof value === 'string') {
      response.setHeader(name, rewriteAbsoluteOrigin(value, targetOrigin, publicOrigin))
      continue
    }
    if ((lower === 'content-security-policy' || lower === 'content-security-policy-report-only')
      && typeof value === 'string') {
      response.setHeader(name, value.split(targetOrigin).join(publicOrigin))
      continue
    }
    if (lower === 'access-control-allow-origin' && value === targetOrigin) {
      response.setHeader(name, publicOrigin)
      continue
    }
    response.setHeader(name, value)
  }
}

function rewriteAbsoluteOrigin(value: string, from: string, to: string): string {
  try {
    const parsed = new URL(value)
    return parsed.origin === from ? `${to}${parsed.pathname}${parsed.search}${parsed.hash}` : value
  } catch {
    return value
  }
}

function rewriteSetCookie(value: string, reservedName: string): string | undefined {
  const name = value.slice(0, value.indexOf('=')).trim()
  if (name === reservedName) return undefined
  return value.replace(/;\s*Domain=(?:127\.0\.0\.1|localhost)(?=;|$)/giu, '')
}

function expiredCookie(name: string): string {
  return `${name}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict`
}

class BodyTooLargeError extends Error {}

async function readSmallBody(request: IncomingMessage, limit: number): Promise<string> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.length
    if (size > limit) throw new BodyTooLargeError('request body is too large')
    chunks.push(buffer)
  }
  return Buffer.concat(chunks).toString('utf8')
}

function sendLoginPage(response: ServerResponse, headOnly: boolean): void {
  const html = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>SplitSquare Harness 配对</title><style>
:root{color-scheme:dark}body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0b0f16;color:#eef3ff;font:16px system-ui}
main{width:min(430px,calc(100vw - 40px));padding:32px;border:1px solid #26334b;border-radius:18px;background:#111827;box-shadow:0 20px 70px #0008}
h1{font-size:24px;margin:0 0 12px}p{color:#aebbd0;line-height:1.55}input,button{box-sizing:border-box;width:100%;padding:13px 15px;border-radius:10px;font:inherit}
input{border:1px solid #3a4965;background:#0b1220;color:#fff;letter-spacing:.08em}button{margin-top:14px;border:0;background:#3b82f6;color:#fff;font-weight:700;cursor:pointer}
</style></head><body><main><h1>连接 SplitSquare Harness</h1><p>请输入桌面应用中显示的一次性配对码。成功后会建立加密、限时的远程会话。</p>
<form method="post" action="${PAIR_PATH}"><input name="code" autocomplete="one-time-code" required autofocus><button type="submit">安全连接</button></form></main></body></html>`
  response.statusCode = 200
  response.setHeader('Content-Type', 'text/html; charset=utf-8')
  response.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'")
  response.setHeader('Cache-Control', 'no-store')
  response.setHeader('X-Content-Type-Options', 'nosniff')
  response.setHeader('Referrer-Policy', 'no-referrer')
  response.end(headOnly ? undefined : html)
}

function sendText(response: ServerResponse, status: number, message: string): void {
  response.statusCode = status
  response.setHeader('Content-Type', 'text/plain; charset=utf-8')
  response.setHeader('Cache-Control', 'no-store')
  response.setHeader('X-Content-Type-Options', 'nosniff')
  response.end(message)
}

function rejectUpgrade(socket: Duplex, status: number, message: string): void {
  if (!socket.writable) {
    socket.destroy()
    return
  }
  const body = `${message}\n`
  socket.end(
    `HTTP/1.1 ${String(status)} ${message}\r\nConnection: close\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: ${String(Buffer.byteLength(body))}\r\n\r\n${body}`,
  )
}
