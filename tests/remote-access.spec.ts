import { request as httpsRequest } from 'node:https'
import { describe, expect, it } from 'vitest'
import { RemoteAccess } from '../src/remote-access.js'

describe('remote access lifecycle serialization', () => {
  it('never leaves an orphan listener after concurrent starts and stop', async () => {
    const access = new RemoteAccess()
    const options = { bindAddress: '127.0.0.1', port: 0 }
    const target = new URL('http://127.0.0.1:1/')
    const results = await Promise.allSettled([
      access.start(options, target),
      access.start(options, target),
    ])
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1)
    const fulfilled = results.find((result) => result.status === 'fulfilled')
    if (fulfilled?.status !== 'fulfilled') throw new Error('missing successful start')
    await access.stop()
    await expect(connect(fulfilled.value.origin)).rejects.toThrow()
  })

  it('orders a stop requested while start is still generating TLS', async () => {
    const access = new RemoteAccess()
    const starting = access.start(
      { bindAddress: '127.0.0.1', port: 0 },
      new URL('http://127.0.0.1:1/'),
    )
    const stopping = access.stop()
    const info = await starting
    await stopping
    expect(access.running).toBe(false)
    await expect(connect(info.origin)).rejects.toThrow()
  })

  it('does not lose a backend exit while start is still generating TLS', async () => {
    const access = new RemoteAccess()
    const starting = access.start(
      { bindAddress: '127.0.0.1', port: 0 },
      new URL('http://127.0.0.1:1/'),
    )
    const clearing = access.setTarget(undefined)
    await starting
    await clearing
    expect(access.status()?.target).toBeUndefined()
    await access.stop()
  })
})

async function connect(origin: string): Promise<void> {
  return await new Promise<void>((resolve, reject) => {
    const request = httpsRequest(origin, {
      rejectUnauthorized: false,
      timeout: 1_000,
    }, (response) => {
      response.resume()
      response.once('end', resolve)
    })
    request.once('error', reject)
    request.once('timeout', () => request.destroy(new Error('timeout')))
    request.end()
  })
}
