import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  CorruptSettingsError,
  defaultDesktopSettings,
  migrateDesktopSettings,
  SETTINGS_SCHEMA_VERSION,
  SettingsStore,
  SettingsValidationError,
  UnsupportedSettingsVersionError,
  validateDesktopSettings,
  type DesktopSettings,
} from '../src/settings-store.js'

describe('desktop settings schema', () => {
  it('defaults to a disabled gateway on an OS-assigned port', () => {
    expect(defaultDesktopSettings()).toEqual({
      schemaVersion: 1,
      lanGateway: { enabled: false, port: 0 },
    })
  })

  it('purely migrates the current unversioned workspace format', () => {
    const legacy = { workspace: String.raw`E:\projects\demo` }
    expect(migrateDesktopSettings(legacy)).toEqual({
      schemaVersion: SETTINGS_SCHEMA_VERSION,
      workspace: String.raw`E:\projects\demo`,
      lanGateway: { enabled: false, port: 0 },
    })
    expect(legacy).toEqual({ workspace: String.raw`E:\projects\demo` })
  })

  it('treats the legacy empty workspace as absent', () => {
    expect(migrateDesktopSettings({ workspace: '' })).toEqual(defaultDesktopSettings())
  })

  it('validates and copies all v1 public fields', () => {
    const input: DesktopSettings = {
      schemaVersion: 1,
      workspace: '/work',
      lanGateway: { enabled: true, bindAddress: '192.168.1.10', port: 8443 },
    }
    const parsed = validateDesktopSettings(input)
    expect(parsed).toEqual(input)
    expect(parsed).not.toBe(input)
    expect(parsed.lanGateway).not.toBe(input.lanGateway)
  })

  it('fills the safe v1 gateway defaults when fields are omitted', () => {
    expect(validateDesktopSettings({ schemaVersion: 1 })).toEqual(defaultDesktopSettings())
    expect(validateDesktopSettings({
      schemaVersion: 1,
      lanGateway: { bindAddress: '127.0.0.1' },
    })).toEqual({
      schemaVersion: 1,
      lanGateway: { enabled: false, bindAddress: '127.0.0.1', port: 0 },
    })
  })

  it.each([
    [{ schemaVersion: 1, lanGateway: { enabled: false, port: -1 } }],
    [{ schemaVersion: 1, lanGateway: { enabled: false, port: 65_536 } }],
    [{ schemaVersion: 1, lanGateway: { enabled: false, port: 1.5 } }],
    [{ schemaVersion: 1, lanGateway: { enabled: 'false', port: 0 } }],
    [{ schemaVersion: 1, workspace: '', lanGateway: { enabled: false, port: 0 } }],
    [{ schemaVersion: 1, lanGateway: { enabled: false, bindAddress: '', port: 0 } }],
    [{ schemaVersion: 1, pairingCode: 'secret', lanGateway: { enabled: false, port: 0 } }],
    [{ schemaVersion: 1, lanGateway: { enabled: false, port: 0, session: 'secret' } }],
    [{ schemaVersion: 1, lanGateway: { enabled: false, port: 0, tlsPrivateKey: 'secret' } }],
  ])('rejects malformed, secret, or live-state fields: %j', (value) => {
    expect(() => validateDesktopSettings(value)).toThrow(SettingsValidationError)
  })
})

describe('SettingsStore', () => {
  let directory: string
  let path: string

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'dsh-desktop-settings-'))
    path = join(directory, 'desktop-settings.json')
  })

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true })
  })

  it('returns safe defaults without materializing a missing file', async () => {
    const store = new SettingsStore(path)
    await expect(store.load()).resolves.toEqual(defaultDesktopSettings())
    await expect(readdir(directory)).resolves.toEqual([])
  })

  it('atomically persists an on-disk legacy migration', async () => {
    await writeFile(path, '{"workspace":"/legacy"}\n', 'utf8')
    const store = new SettingsStore(path, { randomId: () => 'migration' })

    await expect(store.load()).resolves.toEqual({
      schemaVersion: 1,
      workspace: '/legacy',
      lanGateway: { enabled: false, port: 0 },
    })
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({
      schemaVersion: 1,
      workspace: '/legacy',
      lanGateway: { enabled: false, port: 0 },
    })
    expect((await readdir(directory)).filter(name => name.includes('.tmp-'))).toEqual([])
  })

  it('backs up malformed JSON and does not create replacement defaults', async () => {
    const source = '{not-json'
    await writeFile(path, source, 'utf8')
    const store = new SettingsStore(path, {
      now: () => new Date('2026-08-15T12:34:56.789Z'),
    })

    const error = await store.load().catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(CorruptSettingsError)
    const corruption = error as CorruptSettingsError
    expect(corruption.backupPath).toBe(`${path}.corrupt-2026-08-15T12-34-56-789Z.bak`)
    await expect(readFile(corruption.backupPath, 'utf8')).resolves.toBe(source)
    await expect(readFile(path, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('backs up a v1 document containing forbidden persisted secrets', async () => {
    await writeFile(path, JSON.stringify({
      schemaVersion: 1,
      lanGateway: {
        enabled: false,
        port: 0,
        pairingCode: 'must-not-persist',
      },
    }), 'utf8')
    const store = new SettingsStore(path, {
      now: () => new Date('2026-08-15T00:00:00.000Z'),
    })

    await expect(store.load()).rejects.toBeInstanceOf(CorruptSettingsError)
    expect(await readdir(directory)).toEqual([
      'desktop-settings.json.corrupt-2026-08-15T00-00-00-000Z.bak',
    ])
  })

  it('leaves a newer schema with unknown fields untouched instead of mislabeling it as corrupt', async () => {
    const future = '{"schemaVersion":2,"futureField":true,"lanGateway":{"enabled":false,"port":0}}\n'
    await writeFile(path, future, 'utf8')
    const store = new SettingsStore(path)

    await expect(store.load()).rejects.toBeInstanceOf(UnsupportedSettingsVersionError)
    await expect(readFile(path, 'utf8')).resolves.toBe(future)
    await expect(readdir(directory)).resolves.toEqual(['desktop-settings.json'])
  })

  it('publishes validated settings with no temporary residue', async () => {
    const store = new SettingsStore(path, { randomId: () => 'save' })
    await store.save({
      schemaVersion: 1,
      workspace: '/new',
      lanGateway: { enabled: false, bindAddress: '127.0.0.1', port: 0 },
    })

    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({
      schemaVersion: 1,
      workspace: '/new',
      lanGateway: { enabled: false, bindAddress: '127.0.0.1', port: 0 },
    })
    await expect(readdir(directory)).resolves.toEqual(['desktop-settings.json'])
  })

  it('serializes concurrent saves in invocation order', async () => {
    let id = 0
    const store = new SettingsStore(path, { randomId: () => String(id += 1) })
    const saves = Array.from({ length: 40 }, (_, index) => store.save({
      schemaVersion: 1,
      workspace: `/workspace/${String(index)}`,
      lanGateway: { enabled: false, port: 0 },
    }))

    await Promise.all(saves)
    await expect(store.load()).resolves.toMatchObject({ workspace: '/workspace/39' })
    expect((await readdir(directory)).filter(name => name.includes('.tmp-'))).toEqual([])
  })

  it('updates the latest document without losing gateway fields', async () => {
    const store = new SettingsStore(path)
    await store.save({
      schemaVersion: 1,
      lanGateway: { enabled: true, bindAddress: '0.0.0.0', port: 9443 },
    })

    const updated = await store.update(current => ({
      ...current,
      workspace: '/selected',
    }))
    expect(updated).toEqual({
      schemaVersion: 1,
      workspace: '/selected',
      lanGateway: { enabled: true, bindAddress: '0.0.0.0', port: 9443 },
    })
    await expect(store.load()).resolves.toEqual(updated)
  })

  it('rejects forbidden fields before touching the existing file', async () => {
    const initial: DesktopSettings = {
      schemaVersion: 1,
      workspace: '/safe',
      lanGateway: { enabled: false, port: 0 },
    }
    const store = new SettingsStore(path)
    await store.save(initial)
    const before = await readFile(path, 'utf8')

    expect(() => store.save({
      ...initial,
      lanGateway: {
        ...initial.lanGateway,
        pairingCode: 'secret',
      },
    } as DesktopSettings)).toThrow(SettingsValidationError)
    await expect(readFile(path, 'utf8')).resolves.toBe(before)
  })
})
