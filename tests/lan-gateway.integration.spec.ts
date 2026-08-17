import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { request as httpsRequest } from 'node:https'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { WebSocket, WebSocketServer } from 'ws'
import { generate } from 'selfsigned'
import {
  LanGateway,
  type LanGatewayAuthenticator,
  validateTarget,
} from '../src/lan-gateway.js'

interface ResponseData {
  status: number
  headers: Record<string, string | string[] | undefined>
  body: string
}

class FakeAuth implements LanGatewayAuthenticator {
  readonly cookieName = '__Host-dsh-test'
  private valid = true

  constructor(private readonly ttlMs = 60_000) {}

  authenticate(cookie: string | undefined): boolean {
    return this.valid && cookie?.split(';').some((part) => part.trim() === `${this.cookieName}=session`) === true
  }

  sessionExpiresAt(cookie: string | undefined): number | undefined {
    return this.authenticate(cookie) ? Date.now() + this.ttlMs : undefined
  }

  exchangePairing(code: string): { ok: boolean; setCookie?: string } {
    return code === 'PAIR-OK'
      ? { ok: true, setCookie: `${this.cookieName}=session; Path=/; HttpOnly; Secure; SameSite=Strict` }
      : { ok: false }
  }

  revokeAll(): void {
    this.valid = false
  }
}

describe('authenticated LAN gateway', () => {
  const cleanups: Array<() => Promise<void>> = []

  afterEach(async () => {
    await Promise.allSettled(cleanups.splice(0).reverse().map((cleanup) => cleanup()))
  })

  it('rejects any target that is not an exact numeric loopback HTTP origin', () => {
    expect(validateTarget(new URL('http://127.0.0.1:3080/')).href).toBe('http://127.0.0.1:3080/')
    for (const value of [
      'https://127.0.0.1:3080/',
      'http://localhost:3080/',
      'http://0.0.0.0:3080/',
      'http://127.0.0.1:3080/path',
      'http://user@127.0.0.1:3080/',
    ]) {
      expect(() => validateTarget(new URL(value))).toThrow()
    }
  })

  it('pairs once, authenticates with a secure cookie, and rewrites the trusted origin', async () => {
    const upstream = createServer((request, response) => {
      response.setHeader('Content-Type', 'application/json')
      response.end(JSON.stringify({
        host: request.headers.host,
        origin: request.headers.origin,
        referer: request.headers.referer,
        cookie: request.headers.cookie,
        forwarded: request.headers.forwarded,
        url: request.url,
      }))
    })
    const target = await listenHttp(upstream)
    cleanups.push(() => closeServer(upstream))
    const { gateway, origin } = await startGateway(target)
    cleanups.push(() => gateway.stop())

    const anonymous = await call(origin, { path: '/' })
    expect(anonymous.status).toBe(303)
    expect(anonymous.headers.location).toBe('/__desktop__/login')

    const paired = await call(origin, {
      path: '/__desktop__/pair',
      method: 'POST',
      headers: {
        Origin: origin,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: 'code=PAIR-OK',
    })
    expect(paired.status).toBe(303)
    const cookie = Array.isArray(paired.headers['set-cookie'])
      ? paired.headers['set-cookie'][0]
      : paired.headers['set-cookie']
    expect(cookie).toContain('__Host-dsh-test=session')
    expect(cookie).toContain('HttpOnly')
    expect(cookie).toContain('Secure')

    const response = await call(origin, {
      path: '/api/probe?stream=1',
      headers: {
        Cookie: `${(cookie as string).split(';')[0] as string}; dsh-own=value`,
        Origin: origin,
        Referer: `${origin}/workspace?id=1`,
        Forwarded: 'for=203.0.113.5',
      },
    })
    expect(response.status).toBe(200)
    const seen = JSON.parse(response.body) as Record<string, string | undefined>
    expect(seen.host).toBe(new URL(target).host)
    expect(seen.origin).toBe(new URL(target).origin)
    expect(seen.referer).toBe(`${new URL(target).origin}/workspace?id=1`)
    expect(seen.cookie).toBe('dsh-own=value')
    expect(seen.forwarded).toBeUndefined()
    expect(seen.url).toBe('/api/probe?stream=1')

    const forgedOrigin = await call(origin, {
      path: '/api/write',
      method: 'POST',
      headers: { Cookie: cookie as string, Origin: 'https://evil.example' },
    })
    expect(forgedOrigin.status).toBe(400)
  })

  it('does not buffer streaming responses', async () => {
    const upstream = createServer((_request, response) => {
      response.writeHead(200, { 'Content-Type': 'text/event-stream' })
      response.write('data: first\n\n')
      setTimeout(() => response.end('data: last\n\n'), 350)
    })
    const target = await listenHttp(upstream)
    cleanups.push(() => closeServer(upstream))
    const { gateway, origin } = await startGateway(target)
    cleanups.push(() => gateway.stop())

    const firstChunkAt = await firstChunk(origin, '__Host-dsh-test=session')
    expect(firstChunkAt).toBeLessThan(300)
  })

  it('authenticates and streams WebSocket frames in both directions', async () => {
    const upstream = createServer()
    const wss = new WebSocketServer({ noServer: true })
    upstream.on('upgrade', (request, socket, head) => {
      expect(request.headers.host).toBe((upstream.address() as AddressInfo).address + ':' + String((upstream.address() as AddressInfo).port))
      expect(request.headers.origin).toBe(`http://127.0.0.1:${String((upstream.address() as AddressInfo).port)}`)
      expect(request.headers.cookie).toBeUndefined()
      wss.handleUpgrade(request, socket, head, (client) => {
        client.on('message', (message) => client.send(`echo:${message.toString()}`))
      })
    })
    const target = await listenHttp(upstream)
    cleanups.push(async () => {
      wss.close()
      await closeServer(upstream)
    })
    const { gateway, origin } = await startGateway(target)
    cleanups.push(() => gateway.stop())

    const received = await new Promise<string>((resolve, reject) => {
      const socket = new WebSocket(origin.replace('https:', 'wss:'), {
        rejectUnauthorized: false,
        origin,
        headers: { Cookie: '__Host-dsh-test=session' },
      })
      socket.once('open', () => socket.send('probe'))
      socket.once('message', (message) => {
        resolve(message.toString())
        socket.close()
      })
      socket.once('error', reject)
    })
    expect(received).toBe('echo:probe')
  })

  it('closes an established WebSocket on logout', async () => {
    const upstream = createServer()
    const wss = new WebSocketServer({ noServer: true })
    upstream.on('upgrade', (request, socket, head) => {
      wss.handleUpgrade(request, socket, head, (client) => {
        client.on('message', (message) => client.send(`echo:${message.toString()}`))
      })
    })
    const target = await listenHttp(upstream)
    cleanups.push(async () => {
      wss.close()
      await closeServer(upstream)
    })
    const { gateway, origin } = await startGateway(target)
    cleanups.push(() => gateway.stop())
    const socket = new WebSocket(origin.replace('https:', 'wss:'), {
      rejectUnauthorized: false,
      origin,
      headers: { Cookie: '__Host-dsh-test=session' },
    })
    await new Promise<void>((resolve, reject) => {
      socket.once('open', resolve)
      socket.once('error', reject)
    })
    const closed = new Promise<void>((resolve) => socket.once('close', () => resolve()))
    const logout = await call(origin, {
      path: '/__desktop__/logout',
      method: 'POST',
      headers: { Cookie: '__Host-dsh-test=session', Origin: origin },
    })
    expect(logout.status).toBe(303)
    await expect(Promise.race([
      closed.then(() => 'closed'),
      new Promise<string>((resolve) => setTimeout(() => resolve('timeout'), 1_000)),
    ])).resolves.toBe('closed')
    expect(socket.readyState).toBe(WebSocket.CLOSED)
  })

  it('bounds an established WebSocket by the authenticated session lifetime', async () => {
    const upstream = createServer()
    const wss = new WebSocketServer({ noServer: true })
    upstream.on('upgrade', (request, socket, head) => {
      wss.handleUpgrade(request, socket, head, () => undefined)
    })
    const target = await listenHttp(upstream)
    cleanups.push(async () => {
      wss.close()
      await closeServer(upstream)
    })
    const { gateway, origin } = await startGateway(target, new FakeAuth(100))
    cleanups.push(() => gateway.stop())
    const socket = new WebSocket(origin.replace('https:', 'wss:'), {
      rejectUnauthorized: false,
      origin,
      headers: { Cookie: '__Host-dsh-test=session' },
    })
    await new Promise<void>((resolve, reject) => {
      socket.once('open', resolve)
      socket.once('error', reject)
    })
    await expect(new Promise<string>((resolve) => {
      socket.once('close', () => resolve('closed'))
      setTimeout(() => resolve('timeout'), 1_000)
    })).resolves.toBe('closed')
  })

  async function startGateway(
    target: string,
    auth: FakeAuth = new FakeAuth(),
  ): Promise<{ gateway: LanGateway; origin: string }> {
    const certificate = await generate([{ name: 'commonName', value: 'localhost' }], {
      algorithm: 'sha256',
      keySize: 2048,
      extensions: [
        { name: 'basicConstraints', cA: false },
        { name: 'keyUsage', digitalSignature: true, keyEncipherment: true },
        { name: 'extKeyUsage', serverAuth: true },
        { name: 'subjectAltName', altNames: [{ type: 7, ip: '127.0.0.1' }] },
      ],
    })
    const gateway = new LanGateway({
      bindAddress: '127.0.0.1',
      tls: { key: certificate.private, cert: certificate.cert, fingerprint256: 'test' },
      auth,
    })
    const status = await gateway.start(new URL(target))
    return { gateway, origin: status.origin }
  }
})

async function listenHttp(server: ReturnType<typeof createServer>): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  const address = server.address() as AddressInfo
  return `http://127.0.0.1:${String(address.port)}/`
}

async function closeServer(server: ReturnType<typeof createServer>): Promise<void> {
  if (!server.listening) return
  await new Promise<void>((resolve) => server.close(() => resolve()))
}

async function call(
  origin: string,
  options: {
    path: string
    method?: string
    headers?: Record<string, string>
    body?: string
  },
): Promise<ResponseData> {
  const url = new URL(options.path, origin)
  return await new Promise<ResponseData>((resolve, reject) => {
    const request = httpsRequest(url, {
      method: options.method ?? 'GET',
      headers: options.headers,
      rejectUnauthorized: false,
    }, (response) => {
      const chunks: Buffer[] = []
      response.on('data', (chunk: Buffer) => chunks.push(chunk))
      response.once('end', () => resolve({
        status: response.statusCode ?? 0,
        headers: response.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      }))
    })
    request.once('error', reject)
    if (options.body !== undefined) request.write(options.body)
    request.end()
  })
}

async function firstChunk(origin: string, cookie: string): Promise<number> {
  const started = performance.now()
  return await new Promise<number>((resolve, reject) => {
    const request = httpsRequest(origin, {
      headers: { Cookie: cookie },
      rejectUnauthorized: false,
    }, (response) => {
      response.once('data', () => resolve(performance.now() - started))
      response.once('error', reject)
    })
    request.once('error', reject)
    request.end()
  })
}
