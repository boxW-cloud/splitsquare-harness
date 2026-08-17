import { randomUUID } from 'node:crypto'
import { access, mkdir, open, readFile, rename, rm } from 'node:fs/promises'
import { basename, dirname, resolve } from 'node:path'

export const SETTINGS_SCHEMA_VERSION = 1 as const

export interface LanGatewaySettings {
  enabled: boolean
  bindAddress?: string
  port: number
}

/** Persisted desktop settings. Secrets and live LAN state never belong here. */
export interface DesktopSettings {
  schemaVersion: typeof SETTINGS_SCHEMA_VERSION
  workspace?: string
  lanGateway: LanGatewaySettings
}

interface LegacyDesktopSettings {
  workspace?: string
}

interface SettingsStoreOptions {
  now?: () => Date
  randomId?: () => string
}

/** A settings document is malformed or contains fields this version does not own. */
export class SettingsValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SettingsValidationError'
  }
}

/** A valid settings envelope was written by a newer application version. */
export class UnsupportedSettingsVersionError extends Error {
  readonly version: number

  constructor(version: number) {
    super(`Unsupported desktop settings schema version: ${String(version)}`)
    this.name = 'UnsupportedSettingsVersionError'
    this.version = version
  }
}

/** A malformed file was moved aside without creating replacement settings. */
export class CorruptSettingsError extends Error {
  readonly settingsPath: string
  readonly backupPath: string

  constructor(settingsPath: string, backupPath: string, cause: unknown) {
    super(`Desktop settings are corrupt; the original was moved to ${backupPath}`, { cause })
    this.name = 'CorruptSettingsError'
    this.settingsPath = settingsPath
    this.backupPath = backupPath
  }
}

/** Fresh settings keep every network-facing capability disabled. */
export function defaultDesktopSettings(): DesktopSettings {
  return {
    schemaVersion: SETTINGS_SCHEMA_VERSION,
    lanGateway: {
      enabled: false,
      port: 0,
    },
  }
}

/** Validate a v1 document and return an owned copy. */
export function validateDesktopSettings(value: unknown): DesktopSettings {
  const record = objectRecord(value, 'desktop settings')
  if (record.schemaVersion !== SETTINGS_SCHEMA_VERSION) {
    if (typeof record.schemaVersion === 'number' && Number.isInteger(record.schemaVersion)) {
      throw new UnsupportedSettingsVersionError(record.schemaVersion)
    }
    throw new SettingsValidationError('desktop settings.schemaVersion must be 1')
  }
  exactKeys(record, ['schemaVersion', 'workspace', 'lanGateway'], 'desktop settings')

  const workspace = optionalNonEmptyString(record.workspace, 'desktop settings.workspace')
  const gateway = record.lanGateway === undefined
    ? {}
    : objectRecord(record.lanGateway, 'desktop settings.lanGateway')
  exactKeys(gateway, ['enabled', 'bindAddress', 'port'], 'desktop settings.lanGateway')
  const enabled = gateway.enabled ?? false
  if (typeof enabled !== 'boolean') {
    throw new SettingsValidationError('desktop settings.lanGateway.enabled must be a boolean')
  }
  const bindAddress = optionalNonEmptyString(
    gateway.bindAddress,
    'desktop settings.lanGateway.bindAddress',
  )
  const port = gateway.port ?? 0
  if (typeof port !== 'number'
    || !Number.isInteger(port)
    || port < 0
    || port > 65_535) {
    throw new SettingsValidationError(
      'desktop settings.lanGateway.port must be an integer between 0 and 65535',
    )
  }

  return {
    schemaVersion: SETTINGS_SCHEMA_VERSION,
    ...workspace === undefined ? {} : { workspace },
    lanGateway: {
      enabled,
      ...bindAddress === undefined ? {} : { bindAddress },
      port,
    },
  }
}

/** Upgrade the legacy `{ workspace? }` file or validate an existing v1 file. */
export function migrateDesktopSettings(value: unknown): DesktopSettings {
  const record = objectRecord(value, 'desktop settings')
  if (Object.hasOwn(record, 'schemaVersion')) return validateDesktopSettings(record)

  exactKeys(record, ['workspace'], 'legacy desktop settings')
  const legacy = record as LegacyDesktopSettings
  const workspace = legacy.workspace === ''
    ? undefined
    : optionalNonEmptyString(legacy.workspace, 'legacy desktop settings.workspace')
  return {
    ...defaultDesktopSettings(),
    ...workspace === undefined ? {} : { workspace },
  }
}

/** File-backed settings with ordered mutations and atomic same-directory publication. */
export class SettingsStore {
  readonly path: string
  private readonly now: () => Date
  private readonly randomId: () => string
  private queue: Promise<void> = Promise.resolve()

  constructor(path: string, options: SettingsStoreOptions = {}) {
    if (path === '') throw new Error('SettingsStore path must not be empty')
    this.path = resolve(path)
    this.now = options.now ?? (() => new Date())
    this.randomId = options.randomId ?? randomUUID
  }

  /** Read settings, atomically persisting a successful legacy migration. */
  load(): Promise<DesktopSettings> {
    return this.enqueue(async () => {
      const loaded = await this.readDocument()
      if (loaded === undefined) return defaultDesktopSettings()
      if (loaded.migrated) await this.writeAtomic(loaded.settings)
      return cloneSettings(loaded.settings)
    })
  }

  /** Validate and atomically replace the settings file in call order. */
  save(settings: DesktopSettings): Promise<void> {
    const validated = validateDesktopSettings(settings)
    return this.enqueue(async () => this.writeAtomic(validated))
  }

  /** Apply one synchronous update to the latest on-disk value without lost fields. */
  update(update: (current: DesktopSettings) => DesktopSettings): Promise<DesktopSettings> {
    return this.enqueue(async () => {
      const loaded = await this.readDocument()
      const current = loaded?.settings ?? defaultDesktopSettings()
      const next = validateDesktopSettings(update(cloneSettings(current)))
      await this.writeAtomic(next)
      return cloneSettings(next)
    })
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation, operation)
    this.queue = result.then(() => undefined, () => undefined)
    return result
  }

  private async readDocument(): Promise<
    { settings: DesktopSettings; migrated: boolean } | undefined
  > {
    let source: string
    try {
      source = await readFile(this.path, 'utf8')
    } catch (error) {
      if (isNodeError(error, 'ENOENT')) return undefined
      throw error
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(source) as unknown
    } catch (error) {
      return this.backupCorrupt(error)
    }

    try {
      const migrated = !hasSchemaVersion(parsed)
      return { settings: migrateDesktopSettings(parsed), migrated }
    } catch (error) {
      if (error instanceof UnsupportedSettingsVersionError) throw error
      return this.backupCorrupt(error)
    }
  }

  private async backupCorrupt(cause: unknown): Promise<never> {
    const stamp = this.now().toISOString().replaceAll(':', '-').replaceAll('.', '-')
    const base = `${this.path}.corrupt-${stamp}`
    let backupPath = `${base}.bak`
    for (let suffix = 1; await exists(backupPath); suffix += 1) {
      backupPath = `${base}-${String(suffix)}.bak`
    }
    await rename(this.path, backupPath)
    throw new CorruptSettingsError(this.path, backupPath, cause)
  }

  private async writeAtomic(settings: DesktopSettings): Promise<void> {
    const directory = dirname(this.path)
    await mkdir(directory, { recursive: true })
    const tempPath = resolve(
      directory,
      `.${basename(this.path)}.tmp-${String(process.pid)}-${this.randomId()}`,
    )
    const contents = `${JSON.stringify(settings, null, 2)}\n`
    let handle: Awaited<ReturnType<typeof open>> | undefined
    try {
      handle = await open(tempPath, 'wx', 0o600)
      await handle.writeFile(contents, 'utf8')
      await handle.sync()
      await handle.close()
      handle = undefined
      await rename(tempPath, this.path)
    } catch (error) {
      await handle?.close().catch(() => undefined)
      await rm(tempPath, { force: true }).catch(() => undefined)
      throw error
    }
  }
}

function objectRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new SettingsValidationError(`${label} must be an object`)
  }
  return value as Record<string, unknown>
}

function exactKeys(record: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const allowedKeys = new Set(allowed)
  const unknown = Object.keys(record).filter(key => !allowedKeys.has(key))
  if (unknown.length > 0) {
    throw new SettingsValidationError(`${label} contains unknown field(s): ${unknown.join(', ')}`)
  }
}

function optionalNonEmptyString(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || value.length === 0) {
    throw new SettingsValidationError(`${label} must be a non-empty string when present`)
  }
  return value
}

function hasSchemaVersion(value: unknown): boolean {
  return typeof value === 'object'
    && value !== null
    && !Array.isArray(value)
    && Object.hasOwn(value, 'schemaVersion')
}

function cloneSettings(settings: DesktopSettings): DesktopSettings {
  return {
    schemaVersion: SETTINGS_SCHEMA_VERSION,
    ...settings.workspace === undefined ? {} : { workspace: settings.workspace },
    lanGateway: {
      enabled: settings.lanGateway.enabled,
      ...settings.lanGateway.bindAddress === undefined
        ? {}
        : { bindAddress: settings.lanGateway.bindAddress },
      port: settings.lanGateway.port,
    },
  }
}

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) return false
    throw error
  }
}
