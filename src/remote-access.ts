import { LanGateway, type LanGatewayStatus } from './lan-gateway.js'
import { createLanTlsCertificate } from './lan-tls.js'
import { RemoteAuth, type PairingChallenge } from './remote-auth.js'

export interface RemoteAccessOptions {
  bindAddress: string
  port: number
}

export interface RemoteConnectionInfo extends LanGatewayStatus, PairingChallenge {}

/** Owns the per-run TLS key, pairing authority, gateway, and backend generation. */
export class RemoteAccess {
  private auth: RemoteAuth | undefined
  private gateway: LanGateway | undefined
  private queue: Promise<void> = Promise.resolve()

  get running(): boolean {
    return this.gateway !== undefined
  }

  status(): LanGatewayStatus | undefined {
    return this.gateway?.status()
  }

  start(options: RemoteAccessOptions, target: URL): Promise<RemoteConnectionInfo> {
    return this.enqueue(async () => {
      if (this.gateway !== undefined) throw new Error('remote access is already running')
      const auth = new RemoteAuth()
      const tls = await createLanTlsCertificate({ bindAddress: options.bindAddress })
      const gateway = new LanGateway({
        bindAddress: options.bindAddress,
        port: options.port,
        tls,
        auth,
      })
      try {
        const status = await gateway.start(target)
        this.auth = auth
        this.gateway = gateway
        return { ...status, ...auth.createPairing() }
      } catch (error) {
        await gateway.stop().catch(() => undefined)
        throw error
      }
    })
  }

  setTarget(target: URL | undefined): Promise<PairingChallenge | undefined> {
    return this.enqueue(async () => {
      this.gateway?.setTarget(target)
      if (target === undefined) return undefined
      return this.auth?.createPairing()
    })
  }

  createPairing(): RemoteConnectionInfo {
    if (this.gateway === undefined || this.auth === undefined) {
      throw new Error('remote access is not running')
    }
    return { ...this.gateway.status(), ...this.auth.createPairing() }
  }

  stop(): Promise<void> {
    return this.enqueue(async () => {
      const gateway = this.gateway
      this.gateway = undefined
      this.auth = undefined
      await gateway?.stop()
    })
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation, operation)
    this.queue = result.then(() => undefined, () => undefined)
    return result
  }
}
