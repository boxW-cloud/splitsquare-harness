import type {
  BrowserWindow,
  MessageBoxOptions,
  Session,
  WebContents,
  WebFrameMain,
} from 'electron'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { installElectronCapabilities } from '../src/electron-capabilities.js'

type Handler = (...arguments_: never[]) => unknown

class FakeEmitter {
  readonly listeners = new Map<string, Handler>()

  on(event: string, listener: Handler): this {
    this.listeners.set(event, listener)
    return this
  }

  removeListener(event: string, listener: Handler): this {
    if (this.listeners.get(event) === listener) this.listeners.delete(event)
    return this
  }
}

class FakeSession extends FakeEmitter {
  permissionCheck: Handler | null = null
  permissionRequest: Handler | null = null
  displayMediaRequest: Handler | null = null
  displayMediaOptions: unknown
  devicePermission: Handler | null = null

  setPermissionCheckHandler(handler: Handler | null): void {
    this.permissionCheck = handler
  }

  setPermissionRequestHandler(handler: Handler | null): void {
    this.permissionRequest = handler
  }

  setDisplayMediaRequestHandler(handler: Handler | null, options?: unknown): void {
    this.displayMediaRequest = handler
    this.displayMediaOptions = options
  }

  setDevicePermissionHandler(handler: Handler | null): void {
    this.devicePermission = handler
  }
}

interface Fixture {
  readonly origin: string
  readonly frame: WebFrameMain
  readonly contents: WebContents
  readonly session: FakeSession
  readonly window: BrowserWindow
  readonly showMessageBox: ReturnType<typeof vi.fn>
  readonly getDisplaySources: ReturnType<typeof vi.fn>
}

function fixture(): Fixture {
  const origin = 'http://127.0.0.1:43127'
  const session = new FakeSession()
  const frame = { url: `${origin}/` } as WebFrameMain
  const contentsEmitter = new FakeEmitter()
  const contents = Object.assign(contentsEmitter, {
    session: session as unknown as Session,
    mainFrame: frame,
    isDestroyed: () => false,
  }) as unknown as WebContents
  const window = {
    webContents: contents,
    isDestroyed: () => false,
  } as BrowserWindow
  return {
    origin,
    frame,
    contents,
    session,
    window,
    showMessageBox: vi.fn(),
    getDisplaySources: vi.fn(),
  }
}

function preventableEvent(): { preventDefault: ReturnType<typeof vi.fn> } {
  return { preventDefault: vi.fn() }
}

function messageResult(response: number): { response: number; checkboxChecked: boolean } {
  return { response, checkboxChecked: false }
}

describe('Electron native capability boundary', () => {
  beforeEach(() => vi.restoreAllMocks())

  it('registers the Electron system picker and denies unknown or confused-origin permissions', () => {
    const value = fixture()
    installElectronCapabilities(value.window, () => value.origin, {
      showMessageBox: value.showMessageBox,
      getDisplaySources: value.getDisplaySources,
    })

    expect(value.session.displayMediaOptions).toEqual({ useSystemPicker: true })
    const check = value.session.permissionCheck as (...arguments_: unknown[]) => boolean
    expect(check(value.contents, 'clipboard-sanitized-write', value.origin, {
      isMainFrame: true,
      requestingUrl: `${value.origin}/`,
    })).toBe(true)
    expect(check(value.contents, 'clipboard-sanitized-write', 'http://127.0.0.1:43128', {
      isMainFrame: true,
      requestingUrl: `${value.origin}/`,
    })).toBe(false)
    expect(check(value.contents, 'clipboard-sanitized-write', value.origin, {
      isMainFrame: false,
      requestingUrl: `${value.origin}/`,
    })).toBe(false)
    expect(check(value.contents, 'openExternal', value.origin, {
      isMainFrame: true,
      requestingUrl: `${value.origin}/`,
    })).toBe(false)
  })

  it('prompts once per session for a dangerous main-frame permission', async () => {
    const value = fixture()
    value.showMessageBox.mockResolvedValue(messageResult(0))
    installElectronCapabilities(value.window, () => value.origin, {
      showMessageBox: value.showMessageBox,
      getDisplaySources: value.getDisplaySources,
    })
    const request = value.session.permissionRequest as (...arguments_: unknown[]) => void
    const details = {
      isMainFrame: true,
      requestingUrl: `${value.origin}/settings`,
      securityOrigin: value.origin,
      mediaTypes: ['audio'],
    }

    const first = await new Promise<boolean>((resolve) => {
      request(value.contents, 'media', resolve, details)
    })
    const second = await new Promise<boolean>((resolve) => {
      request(value.contents, 'media', resolve, details)
    })
    expect(first).toBe(true)
    expect(second).toBe(true)
    expect(value.showMessageBox).toHaveBeenCalledTimes(1)

    const options = value.showMessageBox.mock.calls[0]?.[1] as MessageBoxOptions
    expect(options.defaultId).toBe(1)
    expect(options.cancelId).toBe(1)
  })

  it('requires a second native confirmation for MIDI SysEx', async () => {
    const value = fixture()
    value.showMessageBox.mockResolvedValue(messageResult(0))
    installElectronCapabilities(value.window, () => value.origin, {
      showMessageBox: value.showMessageBox,
      getDisplaySources: value.getDisplaySources,
    })
    const request = value.session.permissionRequest as (...arguments_: unknown[]) => void

    await expect(new Promise<boolean>((resolve) => {
      request(value.contents, 'midiSysex', resolve, {
        isMainFrame: true,
        requestingUrl: `${value.origin}/`,
      })
    })).resolves.toBe(true)
    expect(value.showMessageBox).toHaveBeenCalledTimes(2)
    expect(value.showMessageBox.mock.calls[0]?.[1]).toMatchObject({ message: 'Allow MIDI access?' })
    expect(value.showMessageBox.mock.calls[1]?.[1]).toMatchObject({
      message: 'Allow MIDI system-exclusive messages?',
    })
  })

  it('denies permission requests from a subframe without displaying a dialog', async () => {
    const value = fixture()
    installElectronCapabilities(value.window, () => value.origin, {
      showMessageBox: value.showMessageBox,
      getDisplaySources: value.getDisplaySources,
    })
    const request = value.session.permissionRequest as (...arguments_: unknown[]) => void

    await expect(new Promise<boolean>((resolve) => {
      request(value.contents, 'geolocation', resolve, {
        isMainFrame: false,
        requestingUrl: `${value.origin}/embedded`,
      })
    })).resolves.toBe(false)
    expect(value.showMessageBox).not.toHaveBeenCalled()
  })

  it('uses an explicit display-source choice on platforms without the system picker', async () => {
    const value = fixture()
    const firstSource = { id: 'screen:1', name: 'Screen 1' }
    const secondSource = { id: 'window:2', name: 'Editor' }
    value.getDisplaySources.mockResolvedValue([firstSource, secondSource])
    value.showMessageBox
      .mockResolvedValueOnce(messageResult(0))
      .mockResolvedValueOnce(messageResult(1))
    installElectronCapabilities(value.window, () => value.origin, {
      showMessageBox: value.showMessageBox,
      getDisplaySources: value.getDisplaySources,
      platform: 'win32',
    })
    const request = value.session.displayMediaRequest as (...arguments_: unknown[]) => void

    const streams = await new Promise<Record<string, unknown>>((resolve) => {
      request({
        frame: value.frame,
        securityOrigin: value.origin,
        videoRequested: true,
        audioRequested: true,
        userGesture: true,
      }, resolve)
    })
    expect(streams).toEqual({ video: secondSource, audio: 'loopback' })
    const chooser = value.showMessageBox.mock.calls[1]?.[1] as MessageBoxOptions
    expect(chooser.defaultId).toBe(2)
    expect(chooser.cancelId).toBe(2)
  })

  it('cancels display capture safely when there is no user gesture', async () => {
    const value = fixture()
    installElectronCapabilities(value.window, () => value.origin, {
      showMessageBox: value.showMessageBox,
      getDisplaySources: value.getDisplaySources,
    })
    const request = value.session.displayMediaRequest as (...arguments_: unknown[]) => void

    await expect(new Promise<Record<string, unknown>>((resolve) => {
      request({
        frame: value.frame,
        securityOrigin: value.origin,
        videoRequested: true,
        audioRequested: false,
        userGesture: false,
      }, resolve)
    })).resolves.toEqual({})
    expect(value.showMessageBox).not.toHaveBeenCalled()
    expect(value.getDisplaySources).not.toHaveBeenCalled()
  })

  it('never auto-selects HID and records only the device the user chose', async () => {
    const value = fixture()
    value.showMessageBox.mockResolvedValue(messageResult(1))
    installElectronCapabilities(value.window, () => value.origin, {
      showMessageBox: value.showMessageBox,
      getDisplaySources: value.getDisplaySources,
    })
    const select = value.session.listeners.get('select-hid-device') as (...arguments_: unknown[]) => void
    const event = preventableEvent()
    const devices = [
      { deviceId: 'hid-1', name: 'First', vendorId: 1, productId: 1, collections: [] },
      { deviceId: 'hid-2', name: 'Second', vendorId: 2, productId: 2, collections: [] },
    ]

    const selected = await new Promise<string | null | undefined>((resolve) => {
      select(event, { frame: value.frame, deviceList: devices }, resolve)
    })
    expect(event.preventDefault).toHaveBeenCalledOnce()
    expect(selected).toBe('hid-2')
    const options = value.showMessageBox.mock.calls[0]?.[1] as MessageBoxOptions
    expect(options.defaultId).toBe(2)
    expect(options.cancelId).toBe(2)

    const devicePermission = value.session.devicePermission as (...arguments_: unknown[]) => boolean
    expect(devicePermission({
      deviceType: 'hid',
      origin: value.origin,
      device: devices[1],
    })).toBe(true)
    expect(devicePermission({
      deviceType: 'hid',
      origin: 'http://127.0.0.1:43128',
      device: devices[1],
    })).toBe(false)
    expect(devicePermission({
      deviceType: 'hid',
      origin: value.origin,
      device: devices[0],
    })).toBe(false)
  })

  it('treats device-dialog cancellation as denial', async () => {
    const value = fixture()
    value.showMessageBox.mockResolvedValue(messageResult(1))
    installElectronCapabilities(value.window, () => value.origin, {
      showMessageBox: value.showMessageBox,
      getDisplaySources: value.getDisplaySources,
    })
    const select = value.session.listeners.get('select-usb-device') as (...arguments_: unknown[]) => void
    const event = preventableEvent()

    const selected = await new Promise<string | undefined>((resolve) => {
      select(event, {
        frame: value.frame,
        deviceList: [{
          deviceId: 'usb-1',
          productName: 'USB key',
          vendorId: 1,
          productId: 2,
        }],
      }, resolve)
    })
    expect(event.preventDefault).toHaveBeenCalledOnce()
    expect(selected).toBeUndefined()
  })

  it('prevents Bluetooth default selection and cancels explicitly', async () => {
    const value = fixture()
    value.showMessageBox.mockResolvedValue(messageResult(1))
    installElectronCapabilities(value.window, () => value.origin, {
      showMessageBox: value.showMessageBox,
      getDisplaySources: value.getDisplaySources,
    })
    const select = (value.contents as unknown as FakeEmitter).listeners
      .get('select-bluetooth-device') as (...arguments_: unknown[]) => void
    const event = preventableEvent()

    await expect(new Promise<string>((resolve) => {
      select(event, [{ deviceId: 'bt-1', deviceName: 'Headset' }], resolve)
    })).resolves.toBe('')
    expect(event.preventDefault).toHaveBeenCalledOnce()
  })

  it('keeps a Bluetooth scan pending until a device becomes available', async () => {
    const value = fixture()
    value.showMessageBox.mockResolvedValue(messageResult(0))
    installElectronCapabilities(value.window, () => value.origin, {
      showMessageBox: value.showMessageBox,
      getDisplaySources: value.getDisplaySources,
    })
    const select = (value.contents as unknown as FakeEmitter).listeners
      .get('select-bluetooth-device') as (...arguments_: unknown[]) => void
    const callback = vi.fn()
    const firstEvent = preventableEvent()
    select(firstEvent, [], callback)
    await Promise.resolve()
    expect(callback).not.toHaveBeenCalled()

    const secondEvent = preventableEvent()
    select(secondEvent, [{ deviceId: 'bt-2', deviceName: 'Keyboard' }], callback)
    await vi.waitFor(() => expect(callback).toHaveBeenCalledWith('bt-2'))
    expect(firstEvent.preventDefault).toHaveBeenCalledOnce()
    expect(secondEvent.preventDefault).toHaveBeenCalledOnce()
  })

  it('limits downloads and restricted file access to the trusted renderer', async () => {
    const value = fixture()
    value.showMessageBox.mockResolvedValue(messageResult(0))
    installElectronCapabilities(value.window, () => value.origin, {
      showMessageBox: value.showMessageBox,
      getDisplaySources: value.getDisplaySources,
    })

    const download = value.session.listeners.get('will-download') as (...arguments_: unknown[]) => void
    const trustedEvent = preventableEvent()
    const item = { setSaveDialogOptions: vi.fn() }
    download(trustedEvent, item, value.contents)
    expect(trustedEvent.preventDefault).not.toHaveBeenCalled()
    expect(item.setSaveDialogOptions).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Save Harness download',
      properties: expect.arrayContaining(['showOverwriteConfirmation', 'dontAddToRecent']),
    }))

    const untrustedEvent = preventableEvent()
    download(untrustedEvent, item, {})
    expect(untrustedEvent.preventDefault).toHaveBeenCalledOnce()

    const restricted = value.session.listeners
      .get('file-system-access-restricted') as (...arguments_: unknown[]) => void
    await expect(new Promise<string>((resolve) => {
      restricted(preventableEvent(), {
        origin: 'http://localhost:43127',
        isDirectory: true,
        path: 'C:\\Windows',
      }, resolve)
    })).resolves.toBe('deny')
    await expect(new Promise<string>((resolve) => {
      restricted(preventableEvent(), {
        origin: value.origin,
        isDirectory: true,
        path: 'C:\\Windows',
      }, resolve)
    })).resolves.toBe('allow')
  })

  it('removes all handlers and clears in-memory grants on disposal', async () => {
    const value = fixture()
    value.showMessageBox.mockResolvedValue(messageResult(0))
    const controller = installElectronCapabilities(value.window, () => value.origin, {
      showMessageBox: value.showMessageBox,
      getDisplaySources: value.getDisplaySources,
    })
    controller.ledger.grantDevice('hid', value.origin, 'hid-1')
    controller.dispose()

    expect(value.session.permissionCheck).toBeNull()
    expect(value.session.permissionRequest).toBeNull()
    expect(value.session.displayMediaRequest).toBeNull()
    expect(value.session.devicePermission).toBeNull()
    expect(value.session.listeners.size).toBe(0)
    expect((value.contents as unknown as FakeEmitter).listeners.size).toBe(0)
    expect(controller.ledger.hasDeviceGrant('hid', value.origin, 'hid-1')).toBe(false)
  })
})
