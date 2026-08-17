import { mkdtemp, rm } from 'node:fs/promises'
import { request as httpsRequest } from 'node:https'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DshProcess } from '../src/dsh-process.js'
import { RemoteAccess } from '../src/remote-access.js'

describe('packaged Harness runtime contract', () => {
  let backend: DshProcess | undefined
  let remote: RemoteAccess | undefined
  let scratch: string | undefined

  afterEach(async () => {
    await remote?.stop()
    await backend?.stop()
    if (scratch !== undefined) await rm(scratch, { recursive: true, force: true })
  })

  it('boots the real npm CLI, serves it through the authenticated TLS gateway, and releases both ports', async () => {
    scratch = await mkdtemp(resolve(tmpdir(), 'dsh-desktop-smoke-'))
    backend = new DshProcess({
      runnerPath: resolve('dist/runner.js'),
      executablePath: process.execPath,
      workspace: scratch,
      startupTimeoutMs: 120_000,
      environment: {
        DSH_HOME: resolve(scratch, 'home'),
        DSH_TELEMETRY_DISABLED: '1',
      },
    })
    const url = await backend.start()
    const response = await fetch(url)
    const html = await response.text()
    expect(response.status).toBe(200)
    expect(html).toContain('window.__DSH_BOOT__')
    expect(html).toContain('id="root"')

    remote = new RemoteAccess()
    const info = await remote.start({ bindAddress: '127.0.0.1', port: 0 }, url)
    const paired = await callHttps(info.origin, '/__desktop__/pair', {
      method: 'POST',
      origin: info.origin,
      body: `code=${encodeURIComponent(info.code)}`,
    })
    expect(paired.status).toBe(303)
    const setCookie = Array.isArray(paired.setCookie) ? paired.setCookie[0] : paired.setCookie
    const cookie = setCookie?.split(';')[0]
    expect(cookie).toMatch(/^__Host-dsh-remote=/u)
    const remoteShell = await callHttps(info.origin, '/', { cookie })
    expect(remoteShell.status).toBe(200)
    expect(remoteShell.body).toContain('window.__DSH_BOOT__')
    expect(remoteShell.body).toContain('id="root"')

    await remote.setTarget(undefined)
    await remote.stop()
    await backend.stop()
    await expect(fetch(url, { signal: AbortSignal.timeout(3_000) })).rejects.toThrow()
  }, 150_000)
})

async function callHttps(
  origin: string,
  path: string,
  options: { method?: string; origin?: string; cookie?: string; body?: string },
): Promise<{ status: number; body: string; setCookie: string | string[] | undefined }> {
  return await new Promise((resolveRequest, rejectRequest) => {
    const request = httpsRequest(new URL(path, origin), {
      method: options.method ?? 'GET',
      rejectUnauthorized: false,
      headers: {
        ...(options.origin === undefined ? {} : { Origin: options.origin }),
        ...(options.cookie === undefined ? {} : { Cookie: options.cookie }),
        ...(options.body === undefined ? {} : {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': String(Buffer.byteLength(options.body)),
        }),
      },
    }, (response) => {
      const chunks: Buffer[] = []
      response.on('data', (chunk: Buffer) => chunks.push(chunk))
      response.once('end', () => resolveRequest({
        status: response.statusCode ?? 0,
        body: Buffer.concat(chunks).toString('utf8'),
        setCookie: response.headers['set-cookie'],
      }))
    })
    request.once('error', rejectRequest)
    if (options.body !== undefined) request.write(options.body)
    request.end()
  })
}
