/**
 * Node-side Harness runner. Electron launches this file in RunAsNode mode so
 * the documented CLI owns profile boot while the desktop parent retains an
 * IPC-only shutdown control channel.
 */
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'

interface RunnerMessage {
  type?: unknown
}

let bootSettled = false
let shutdownRequested = false
let signalSent = false

function requestShutdown(): void {
  shutdownRequested = true
  if (!bootSettled || signalSent) return
  signalSent = true
  // runProfile installs the official bounded SIGTERM disposer. Emitting inside
  // this child works on Windows too, where cross-process SIGTERM is forceful.
  process.emit('SIGTERM')
}

process.on('message', (message: RunnerMessage) => {
  if (message?.type === 'shutdown') requestShutdown()
})
process.on('disconnect', requestShutdown)

try {
  const require = createRequire(import.meta.url)
  const packagePath = require.resolve('@deepseek-ai/dsh/package.json')
  const manifest = JSON.parse(readFileSync(packagePath, 'utf8')) as {
    bin?: string | Record<string, string>
  }
  const relativeBin = typeof manifest.bin === 'string' ? manifest.bin : manifest.bin?.dsh
  if (typeof relativeBin !== 'string' || relativeBin === '') {
    throw new Error('@deepseek-ai/dsh does not declare bin.dsh')
  }
  const binPath = join(dirname(packagePath), relativeBin)
  process.argv = [process.execPath, binPath, 'web', '--host', '127.0.0.1', '--port', '0']
  await import(pathToFileURL(binPath).href)
  bootSettled = true
  if (shutdownRequested) requestShutdown()
} catch (error) {
  console.error(`desktop runner: ${error instanceof Error ? error.stack ?? error.message : String(error)}`)
  process.exitCode = 1
}

