import { fork, type ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { resolve } from 'node:path'
import { LineDecoder } from './line-decoder.js'
import { LogBuffer } from './log-buffer.js'
import { parseHarnessReadyUrl } from './ready-url.js'

const DEFAULT_STARTUP_TIMEOUT_MS = 90_000
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 7_500

export interface DshProcessOptions {
  runnerPath: string
  workspace: string
  environment?: NodeJS.ProcessEnv
  executablePath?: string
  startupTimeoutMs?: number
  shutdownTimeoutMs?: number
  probe?: (url: URL) => Promise<void>
}

export interface UnexpectedBackendExit {
  code: number | null
  signal: NodeJS.Signals | null
  logs: readonly string[]
}

/** Managed official `dsh web` process with readiness, health, and bounded stop. */
export class DshProcess extends EventEmitter {
  private child: ChildProcess | undefined
  private readyUrl: URL | undefined
  private startPromise: Promise<URL> | undefined
  private stopping = false
  private readonly logs = new LogBuffer()

  constructor(private readonly options: DshProcessOptions) {
    super()
  }

  get url(): URL | undefined {
    return this.readyUrl === undefined ? undefined : new URL(this.readyUrl.href)
  }

  get logTail(): readonly string[] {
    return this.logs.snapshot()
  }

  start(): Promise<URL> {
    if (this.readyUrl !== undefined && this.child !== undefined) {
      return Promise.resolve(new URL(this.readyUrl.href))
    }
    if (this.startPromise !== undefined) return this.startPromise
    this.stopping = false
    const attempt = this.launch().catch(async (error: unknown) => {
      await this.stop()
      throw error
    }).finally(() => {
      if (this.startPromise === attempt) this.startPromise = undefined
    })
    this.startPromise = attempt
    return attempt
  }

  private launch(): Promise<URL> {
    return new Promise<URL>((resolveStart, rejectStart) => {
      let child: ChildProcess
      try {
        child = fork(this.options.runnerPath, [], {
          cwd: resolve(this.options.workspace),
          execPath: this.options.executablePath ?? process.execPath,
          env: {
            ...process.env,
            ...this.options.environment,
            ELECTRON_RUN_AS_NODE: '1',
          },
          detached: process.platform !== 'win32',
          stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
        })
      } catch (error) {
        rejectStart(error)
        return
      }
      this.child = child

      const stdout = new LineDecoder()
      const stderr = new LineDecoder()
      let settled = false
      let probing = false
      const startupTimeoutMs = this.options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS
      const timer = setTimeout(() => {
        fail(new Error(`DeepSeek Harness did not become ready within ${String(startupTimeoutMs)} ms`))
      }, startupTimeoutMs)

      const cleanupStartup = (): void => {
        clearTimeout(timer)
      }
      const fail = (error: Error): void => {
        if (settled) return
        settled = true
        cleanupStartup()
        rejectStart(this.withLogTail(error))
      }
      const accept = (url: URL): void => {
        if (settled) return
        settled = true
        cleanupStartup()
        this.readyUrl = url
        resolveStart(new URL(url.href))
      }
      const inspectLine = (source: 'stdout' | 'stderr', line: string): void => {
        this.logs.push(`[${source}] ${line}`)
        if (source !== 'stdout' || probing || settled) return
        const ready = parseHarnessReadyUrl(line)
        if (ready === undefined) return
        probing = true
        void (this.options.probe ?? probeHarness)(ready).then(
          () => {
            if (child.exitCode !== null || child.signalCode !== null) {
              fail(new Error('DeepSeek Harness exited during its readiness probe'))
              return
            }
            accept(ready)
          },
          (error: unknown) => fail(new Error(
            `DeepSeek Harness readiness probe failed: ${error instanceof Error ? error.message : String(error)}`,
          )),
        )
      }
      child.stdout?.on('data', (chunk: Buffer) => {
        for (const line of stdout.push(chunk)) inspectLine('stdout', line)
      })
      child.stderr?.on('data', (chunk: Buffer) => {
        for (const line of stderr.push(chunk)) inspectLine('stderr', line)
      })
      child.once('error', (error) => fail(new Error(`DeepSeek Harness failed to start: ${error.message}`)))
      child.once('exit', (code, signal) => {
        const stdoutTail = stdout.flush()
        const stderrTail = stderr.flush()
        if (stdoutTail !== undefined) inspectLine('stdout', stdoutTail)
        if (stderrTail !== undefined) inspectLine('stderr', stderrTail)
        if (this.child === child) this.child = undefined
        const wasReady = this.readyUrl !== undefined
        this.readyUrl = undefined
        if (!settled) {
          fail(new Error(`DeepSeek Harness exited before readiness (code=${String(code)}, signal=${String(signal)})`))
          return
        }
        if (wasReady && !this.stopping) {
          this.emit('unexpected-exit', {
            code,
            signal,
            logs: this.logs.snapshot(),
          } satisfies UnexpectedBackendExit)
        }
      })
    })
  }

  async stop(): Promise<void> {
    this.stopping = true
    this.readyUrl = undefined
    const child = this.child
    if (child === undefined) return
    const exited = new Promise<void>((resolveExit) => {
      if (child.exitCode !== null || child.signalCode !== null) {
        resolveExit()
        return
      }
      child.once('exit', () => resolveExit())
    })
    if (child.connected) {
      try {
        child.send({ type: 'shutdown' })
      } catch {
        // The process may have crossed exit concurrently; the waiter observes it.
      }
    }
    const timeoutMs = this.options.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS
    const stoppedGracefully = await Promise.race([
      exited.then(() => true),
      new Promise<false>((resolveTimeout) => setTimeout(() => resolveTimeout(false), timeoutMs)),
    ])
    if (!stoppedGracefully && child.exitCode === null && child.signalCode === null) {
      if (process.platform !== 'win32' && child.pid !== undefined) {
        try {
          process.kill(-child.pid, 'SIGKILL')
        } catch {
          child.kill('SIGKILL')
        }
      } else {
        child.kill('SIGKILL')
      }
      await exited
    }
    if (this.child === child) this.child = undefined
  }

  private withLogTail(error: Error): Error {
    const tail = this.logs.snapshot().slice(-30)
    if (tail.length === 0) return error
    return new Error(`${error.message}\n\nRecent backend output:\n${tail.join('\n')}`, { cause: error })
  }
}

/** GET the rendered shell and prove that Host boot-manifest injection happened. */
export async function probeHarness(url: URL): Promise<void> {
  const response = await fetch(url, {
    redirect: 'error',
    signal: AbortSignal.timeout(10_000),
  })
  if (!response.ok) throw new Error(`GET ${url.href} returned HTTP ${String(response.status)}`)
  const html = await response.text()
  if (!html.includes('window.__DSH_BOOT__') || !html.includes('id="root"')) {
    throw new Error('the response is not an initialized Harness Web shell')
  }
}
