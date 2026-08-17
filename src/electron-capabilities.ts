import type {
  BluetoothDevice,
  BrowserWindow,
  DesktopCapturerSource,
  DevicePermissionHandlerHandlerDetails,
  DownloadItem,
  Event as ElectronEvent,
  HIDDevice,
  MessageBoxOptions,
  MessageBoxReturnValue,
  SaveDialogOptions,
  SerialPort,
  SourcesOptions,
  USBDevice,
  WebContents,
  WebFrameMain,
} from 'electron'
import {
  canonicalHarnessOrigin,
  isExactHarnessOrigin,
  isExactMainFrameRequest,
  permissionDisposition,
  safeDialogLabel,
  SessionGrantLedger,
  type DeviceKind,
} from './capability-policy.js'

type ShowMessageBox = (
  window: BrowserWindow,
  options: MessageBoxOptions,
) => Promise<MessageBoxReturnValue>

type GetDisplaySources = (options: SourcesOptions) => Promise<DesktopCapturerSource[]>

export interface ElectronCapabilityDependencies {
  /** Test seam; production uses Electron's native dialog module. */
  readonly showMessageBox?: ShowMessageBox
  /** Test seam; production uses Electron's desktopCapturer module. */
  readonly getDisplaySources?: GetDisplaySources
  readonly platform?: NodeJS.Platform
}

export interface ElectronCapabilityController {
  readonly ledger: SessionGrantLedger
  dispose(): void
}

interface Choice {
  readonly identifier: string
  readonly label: string
}

interface BluetoothSelectionState {
  origin: string
  callback: (deviceId: string) => void
  devices: Map<string, BluetoothDevice>
  selecting: boolean
  timeout: ReturnType<typeof setTimeout>
}

const permissionCopy: Readonly<Record<string, readonly [string, string]>> = {
  'clipboard-read': [
    'Allow clipboard reading?',
    'The Harness page will be able to read data currently stored on your clipboard.',
  ],
  'display-capture': [
    'Allow screen sharing?',
    'The Harness page will be able to capture a screen or application window you select.',
  ],
  fullscreen: [
    'Allow full screen?',
    'The Harness page will be able to cover the entire display until you exit full screen.',
  ],
  geolocation: [
    'Allow location access?',
    'The Harness page will be able to request your current location from the operating system.',
  ],
  media: [
    'Allow camera or microphone access?',
    'The Harness page will be able to use the media devices named in this request.',
  ],
  midi: [
    'Allow MIDI access?',
    'The Harness page will be able to communicate with connected MIDI devices.',
  ],
  midiSysex: [
    'Allow MIDI system-exclusive messages?',
    'SysEx messages can reconfigure connected MIDI hardware. This requires separate approval.',
  ],
  notifications: [
    'Allow notifications?',
    'The Harness page will be able to show operating-system notifications.',
  ],
  pointerLock: [
    'Allow pointer lock?',
    'The Harness page will be able to capture mouse movement until you release pointer lock.',
  ],
  'speaker-selection': [
    'Allow speaker selection?',
    'The Harness page will be able to enumerate and choose an audio output device.',
  ],
}

const safeDownloadDialogOptions: SaveDialogOptions = {
  title: 'Save Harness download',
  buttonLabel: 'Save',
  properties: ['createDirectory', 'showOverwriteConfirmation', 'dontAddToRecent'],
}

async function electronShowMessageBox(
  window: BrowserWindow,
  options: MessageBoxOptions,
): Promise<MessageBoxReturnValue> {
  const { dialog } = await import('electron')
  return dialog.showMessageBox(window, options)
}

async function electronGetDisplaySources(options: SourcesOptions): Promise<DesktopCapturerSource[]> {
  const { desktopCapturer } = await import('electron')
  return desktopCapturer.getSources(options)
}

function deviceIdentifier(details: DevicePermissionHandlerHandlerDetails): string | undefined {
  switch (details.deviceType) {
    case 'hid':
      return (details.device as HIDDevice).deviceId
    case 'usb':
      return (details.device as USBDevice).deviceId
    case 'serial': {
      const port = details.device as SerialPort
      return port.deviceInstanceId ?? port.serialNumber ?? port.portId
    }
  }
}

function hidChoices(devices: readonly HIDDevice[]): Choice[] {
  return devices.map((device) => ({
    identifier: device.deviceId,
    label: `${safeDialogLabel(device.name, 'Unnamed HID device')} (${device.vendorId
      .toString(16).padStart(4, '0')}:${device.productId.toString(16).padStart(4, '0')})`,
  }))
}

function usbChoices(devices: readonly USBDevice[]): Choice[] {
  return devices.map((device) => ({
    identifier: device.deviceId,
    label: `${safeDialogLabel(device.productName, 'Unnamed USB device')} (${device.vendorId
      .toString(16).padStart(4, '0')}:${device.productId.toString(16).padStart(4, '0')})`,
  }))
}

function serialChoices(ports: readonly SerialPort[]): Choice[] {
  return ports.map((port) => ({
    identifier: port.deviceInstanceId ?? port.serialNumber ?? port.portId,
    label: safeDialogLabel(port.displayName ?? port.portName, 'Unnamed serial port'),
  }))
}

function bluetoothChoices(devices: readonly BluetoothDevice[]): Choice[] {
  return devices.map((device) => ({
    identifier: device.deviceId,
    label: safeDialogLabel(device.deviceName, 'Unnamed Bluetooth device'),
  }))
}

function displayChoices(sources: readonly DesktopCapturerSource[]): Choice[] {
  return sources.map((source) => ({
    identifier: source.id,
    label: safeDialogLabel(source.name, 'Unnamed screen or window'),
  }))
}

function onceCallback<TArgs extends unknown[]>(
  callback: (...args: TArgs) => void,
): (...args: TArgs) => void {
  let called = false
  return (...args: TArgs): void => {
    if (called) return
    called = true
    try {
      callback(...args)
    } catch {
      // Chromium may invalidate a request while a native picker is open.
    }
  }
}

/**
 * Install the complete native-capability boundary for one BrowserWindow.
 * Call this after installWindowSecurity because both functions own Session handlers.
 */
export function installElectronCapabilities(
  window: BrowserWindow,
  trustedOrigin: () => string | undefined,
  dependencies: ElectronCapabilityDependencies = {},
  trustedContents: WebContents = window.webContents,
): ElectronCapabilityController {
  const session = trustedContents.session
  const ledger = new SessionGrantLedger()
  const showMessageBox = dependencies.showMessageBox ?? electronShowMessageBox
  const getDisplaySources = dependencies.getDisplaySources ?? electronGetDisplaySources
  const platform = dependencies.platform ?? process.platform
  let disposed = false
  let bluetoothSelection: BluetoothSelectionState | undefined

  const activeOrigin = (): string | undefined => canonicalHarnessOrigin(trustedOrigin())

  const currentMainFrameIsTrusted = (): boolean => {
    if (disposed || trustedContents.isDestroyed()) return false
    const origin = activeOrigin()
    return origin !== undefined
      && isExactHarnessOrigin(trustedContents.mainFrame.url, origin)
  }

  const exactContents = (contents: WebContents): boolean => (
    contents === trustedContents && currentMainFrameIsTrusted()
  )

  const exactFrame = (frame: WebFrameMain | null): boolean => (
    frame !== null
    && currentMainFrameIsTrusted()
    && frame === trustedContents.mainFrame
    && isExactHarnessOrigin(frame.url, activeOrigin())
  )

  const ask = async (message: string, detail: string): Promise<boolean> => {
    if (disposed || window.isDestroyed()) return false
    try {
      const result = await showMessageBox(window, {
        type: 'warning',
        title: 'SplitSquare Harness permission',
        message,
        detail,
        buttons: ['Allow for this session', 'Deny'],
        defaultId: 1,
        cancelId: 1,
        noLink: true,
      })
      return result.response === 0
    } catch {
      return false
    }
  }

  const choose = async (
    title: string,
    detail: string,
    choices: readonly Choice[],
  ): Promise<string | undefined> => {
    if (disposed || window.isDestroyed()) return undefined

    const unique = new Map<string, Choice>()
    for (const choice of choices) {
      if (choice.identifier !== '' && !unique.has(choice.identifier)) {
        unique.set(choice.identifier, choice)
      }
    }
    const visible = [...unique.values()]
    if (visible.length === 0) return undefined

    const cancelIndex = visible.length
    try {
      const result = await showMessageBox(window, {
        type: 'question',
        title,
        message: title,
        detail,
        buttons: [...visible.map((choice, index) => `${index + 1}. ${choice.label}`), 'Cancel'],
        // Enter and Escape both cancel; no device is ever selected by default.
        defaultId: cancelIndex,
        cancelId: cancelIndex,
        noLink: true,
      })
      return result.response >= 0 && result.response < visible.length
        ? visible[result.response]?.identifier
        : undefined
    } catch {
      return undefined
    }
  }

  const permissionDecision = async (
    origin: string,
    permission: string,
    detailSuffix = '',
  ): Promise<boolean> => {
    const copy = permissionCopy[permission]
    if (copy === undefined) return false
    return ledger.decidePermissionOnce(origin, permission, () => ask(
      copy[0],
      detailSuffix === '' ? copy[1] : `${copy[1]}\n\n${detailSuffix}`,
    ))
  }

  const mediaPermissionDecision = async (
    origin: string,
    mediaTypes: readonly ('audio' | 'video')[],
  ): Promise<boolean> => {
    const types = [...new Set(mediaTypes)].sort()
    const scopes = (types.length === 0 ? ['unknown'] : types).map((type) => `media:${type}`)
    const remembered = scopes.map((scope) => ledger.permissionDecision(origin, scope))
    if (remembered.some((decision) => decision === false)) return false
    if (remembered.every((decision) => decision === true)) return true

    const unknownScopes = scopes.filter((scope) => ledger.permissionDecision(origin, scope) === undefined)
    const copy = permissionCopy.media
    if (copy === undefined) return false
    const granted = await ledger.decidePermissionOnce(
      origin,
      `media-request:${unknownScopes.join(',')}`,
      () => ask(copy[0], `${copy[1]}\n\nRequested: ${types.join(' and ') || 'unspecified media'}`),
    )
    for (const scope of unknownScopes) ledger.rememberPermissionDecision(origin, scope, granted)
    return granted
  }

  session.setPermissionCheckHandler((contents, permission, requestingOrigin, details) => {
    const origin = activeOrigin()
    if (origin === undefined) return false

    // Chromium currently reports fileSystem checks as non-main-frame. Bind its URL,
    // exact WebContents and the currently loaded main frame instead.
    const exactRequest = permission === 'fileSystem'
      ? contents === trustedContents
        && currentMainFrameIsTrusted()
        && isExactHarnessOrigin(requestingOrigin, origin)
        && (details.requestingUrl === undefined
          || isExactHarnessOrigin(details.requestingUrl, origin))
        && (details.embeddingOrigin === undefined
          || isExactHarnessOrigin(details.embeddingOrigin, origin))
      : isExactMainFrameRequest({
        requestingWebContents: contents,
        trustedWebContents: trustedContents,
        isMainFrame: details.isMainFrame,
        requestingUrl: requestingOrigin,
        currentMainFrameUrl: trustedContents.mainFrame.url,
        trustedOrigin: origin,
        ...(details.embeddingOrigin === undefined
          ? {}
          : { embeddingOrigin: details.embeddingOrigin }),
        ...(details.securityOrigin === undefined
          ? {}
          : { securityOrigin: details.securityOrigin }),
      })
    if (!exactRequest) return false

    const disposition = permissionDisposition(permission)
    if (disposition === 'deny') return false
    if (disposition === 'allow') return true
    if (permission === 'media') {
      return ledger.permissionDecision(origin, `media:${details.mediaType ?? 'unknown'}`) === true
    }
    return ledger.permissionDecision(origin, permission) === true
  })

  session.setPermissionRequestHandler((contents, permission, callback, details) => {
    const complete = onceCallback(callback)
    const origin = activeOrigin()
    if (origin === undefined) {
      complete(false)
      return
    }

    const exactRequest = permission === 'fileSystem'
      ? exactContents(contents) && isExactHarnessOrigin(details.requestingUrl, origin)
      : isExactMainFrameRequest({
        requestingWebContents: contents,
        trustedWebContents: trustedContents,
        isMainFrame: details.isMainFrame,
        requestingUrl: details.requestingUrl,
        currentMainFrameUrl: trustedContents.mainFrame.url,
        trustedOrigin: origin,
        ...('securityOrigin' in details && details.securityOrigin !== undefined
          ? { securityOrigin: details.securityOrigin }
          : {}),
      })
    const disposition = permissionDisposition(permission)
    if (!exactRequest || disposition === 'deny') {
      complete(false)
      return
    }
    if (disposition === 'allow') {
      complete(true)
      return
    }

    const decide = async (): Promise<boolean> => {
      if (permission === 'media') {
        const types = 'mediaTypes' in details && details.mediaTypes !== undefined
          ? details.mediaTypes
          : []
        return mediaPermissionDecision(origin, types)
      }
      if (permission === 'midiSysex') {
        return await permissionDecision(origin, 'midi')
          && permissionDecision(origin, 'midiSysex')
      }
      return permissionDecision(origin, permission)
    }

    void decide()
      .then((granted) => complete(
        granted
        && activeOrigin() === origin
        && exactContents(contents),
      ))
      .catch(() => complete(false))
  })

  session.setDisplayMediaRequestHandler((request, callback) => {
    const complete = onceCallback(callback)
    const origin = activeOrigin()
    if (
      origin === undefined
      || !request.userGesture
      || !exactFrame(request.frame)
      || !isExactHarnessOrigin(request.securityOrigin, origin)
    ) {
      complete({})
      return
    }

    void (async () => {
      if (!await permissionDecision(origin, 'display-capture')) return {}
      if (activeOrigin() !== origin || !exactFrame(request.frame)) return {}

      if (!request.videoRequested) {
        return request.audioRequested && platform === 'win32'
          ? { audio: 'loopback' as const }
          : {}
      }

      const sources = await getDisplaySources({
        types: ['screen', 'window'],
        fetchWindowIcons: false,
        thumbnailSize: { width: 0, height: 0 },
      })
      const selected = await choose(
        'Choose a screen or window',
        'Nothing is shared until you explicitly choose one of these sources.',
        displayChoices(sources),
      )
      if (selected === undefined || activeOrigin() !== origin || !exactFrame(request.frame)) return {}
      const source = sources.find((candidate) => candidate.id === selected)
      if (source === undefined) return {}
      return {
        video: source,
        ...(request.audioRequested && platform === 'win32'
          ? { audio: 'loopback' as const }
          : {}),
      }
    })().then(complete).catch(() => complete({}))
  }, { useSystemPicker: true })

  session.setDevicePermissionHandler((details) => {
    const origin = activeOrigin()
    const identifier = deviceIdentifier(details)
    return origin !== undefined
      && identifier !== undefined
      && currentMainFrameIsTrusted()
      && isExactHarnessOrigin(details.origin, origin)
      && ledger.hasDeviceGrant(details.deviceType, origin, identifier)
  })

  const onWillDownload = (
    event: ElectronEvent,
    item: DownloadItem,
    contents: WebContents,
  ): void => {
    if (!exactContents(contents)) {
      event.preventDefault()
      return
    }
    item.setSaveDialogOptions({ ...safeDownloadDialogOptions })
  }

  const onFileSystemAccessRestricted = (
    _event: ElectronEvent,
    details: Electron.FileSystemAccessRestrictedDetails,
    callback: (action: 'allow' | 'deny' | 'tryAgain') => void,
  ): void => {
    const complete = onceCallback(callback)
    const origin = activeOrigin()
    if (
      origin === undefined
      || !currentMainFrameIsTrusted()
      || !isExactHarnessOrigin(details.origin, origin)
    ) {
      complete('deny')
      return
    }

    const path = safeDialogLabel(details.path, 'Restricted operating-system path')
    void ledger.decidePermissionOnce(origin, `file-system-access:${details.path}`, () => ask(
      'Allow access to a restricted path?',
      `The Harness page requested ${details.isDirectory ? 'directory' : 'file'} access to:\n\n${path}`,
    )).then((granted) => complete(
      granted && activeOrigin() === origin && currentMainFrameIsTrusted() ? 'allow' : 'deny',
    )).catch(() => complete('deny'))
  }

  const onSelectHidDevice = (
    event: ElectronEvent,
    details: Electron.SelectHidDeviceDetails,
    callback: (deviceId?: string | null) => void,
  ): void => {
    event.preventDefault()
    const complete = onceCallback(callback)
    const origin = activeOrigin()
    if (origin === undefined || !exactFrame(details.frame)) {
      complete()
      return
    }
    void choose(
      'Choose a HID device',
      'The selected device will be available only to this Harness session.',
      hidChoices(details.deviceList),
    ).then((identifier) => {
      if (identifier === undefined || activeOrigin() !== origin || !exactFrame(details.frame)) {
        complete()
        return
      }
      ledger.grantDevice('hid', origin, identifier)
      complete(identifier)
    }).catch(() => complete())
  }

  const onSelectUsbDevice = (
    event: ElectronEvent,
    details: Electron.SelectUsbDeviceDetails,
    callback: (deviceId?: string) => void,
  ): void => {
    event.preventDefault()
    const complete = onceCallback(callback)
    const origin = activeOrigin()
    if (origin === undefined || !exactFrame(details.frame)) {
      complete()
      return
    }
    void choose(
      'Choose a USB device',
      'The selected device will be available only to this Harness session.',
      usbChoices(details.deviceList),
    ).then((identifier) => {
      if (identifier === undefined || activeOrigin() !== origin || !exactFrame(details.frame)) {
        complete()
        return
      }
      ledger.grantDevice('usb', origin, identifier)
      complete(identifier)
    }).catch(() => complete())
  }

  const onSelectSerialPort = (
    event: ElectronEvent,
    ports: SerialPort[],
    contents: WebContents,
    callback: (portId: string) => void,
  ): void => {
    event.preventDefault()
    const complete = onceCallback(callback)
    const origin = activeOrigin()
    if (origin === undefined || !exactContents(contents)) {
      complete('')
      return
    }
    void choose(
      'Choose a serial port',
      'The selected port will be available only to this Harness session.',
      serialChoices(ports),
    ).then((identifier) => {
      if (identifier === undefined || activeOrigin() !== origin || !exactContents(contents)) {
        complete('')
        return
      }
      const selected = ports.find((port) => (
        port.deviceInstanceId ?? port.serialNumber ?? port.portId
      ) === identifier)
      if (selected === undefined) {
        complete('')
        return
      }
      ledger.grantDevice('serial', origin, identifier)
      complete(selected.portId)
    }).catch(() => complete(''))
  }

  const finishBluetoothSelection = (
    selection: BluetoothSelectionState,
    identifier: string,
  ): void => {
    if (bluetoothSelection !== selection) return
    bluetoothSelection = undefined
    clearTimeout(selection.timeout)
    selection.callback(identifier)
  }

  const onSelectBluetoothDevice = (
    event: ElectronEvent,
    devices: BluetoothDevice[],
    callback: (deviceId: string) => void,
  ): void => {
    // Without preventDefault Electron silently selects the first device.
    event.preventDefault()
    const complete = onceCallback(callback)
    const origin = activeOrigin()
    if (origin === undefined || !currentMainFrameIsTrusted()) {
      complete('')
      return
    }
    if (bluetoothSelection === undefined) {
      const selection = {
        origin,
        callback: complete,
        devices: new Map<string, BluetoothDevice>(),
        selecting: false,
        timeout: setTimeout(() => finishBluetoothSelection(selection, ''), 10_000),
      }
      bluetoothSelection = selection
    }
    const selection = bluetoothSelection
    if (selection.origin !== origin) {
      complete('')
      return
    }
    for (const device of devices) {
      if (device.deviceId !== '') selection.devices.set(device.deviceId, device)
    }
    if (selection.selecting || selection.devices.size === 0) return
    selection.selecting = true
    clearTimeout(selection.timeout)
    void choose(
      'Choose a Bluetooth device',
      'The selected device will be available only to this Harness session.',
      bluetoothChoices([...selection.devices.values()]),
    ).then((identifier) => {
      if (identifier === undefined
        || !selection.devices.has(identifier)
        || activeOrigin() !== origin
        || !currentMainFrameIsTrusted()) {
        finishBluetoothSelection(selection, '')
        return
      }
      ledger.grantDevice('bluetooth', origin, identifier)
      finishBluetoothSelection(selection, identifier)
    }).catch(() => finishBluetoothSelection(selection, ''))
  }

  const revoke = (
    kind: DeviceKind,
    originCandidate: string | undefined,
    identifier: string,
  ): void => {
    const origin = activeOrigin()
    if (
      origin !== undefined
      && originCandidate !== undefined
      && isExactHarnessOrigin(originCandidate, origin)
    ) ledger.revokeDevice(kind, origin, identifier)
  }

  const onHidDeviceRevoked = (_event: ElectronEvent, details: Electron.HidDeviceRevokedDetails): void => {
    revoke('hid', details.origin, details.device.deviceId)
  }
  const onUsbDeviceRevoked = (_event: ElectronEvent, details: Electron.UsbDeviceRevokedDetails): void => {
    revoke('usb', details.origin, details.device.deviceId)
  }
  const onSerialPortRevoked = (
    _event: ElectronEvent,
    details: Electron.SerialPortRevokedDetails,
  ): void => {
    revoke(
      'serial',
      details.origin,
      details.port.deviceInstanceId ?? details.port.serialNumber ?? details.port.portId,
    )
  }

  session.on('will-download', onWillDownload)
  session.on('file-system-access-restricted', onFileSystemAccessRestricted)
  session.on('select-hid-device', onSelectHidDevice)
  session.on('select-usb-device', onSelectUsbDevice)
  session.on('select-serial-port', onSelectSerialPort)
  session.on('hid-device-revoked', onHidDeviceRevoked)
  session.on('usb-device-revoked', onUsbDeviceRevoked)
  session.on('serial-port-revoked', onSerialPortRevoked)
  trustedContents.on('select-bluetooth-device', onSelectBluetoothDevice)

  return {
    ledger,
    dispose(): void {
      if (disposed) return
      disposed = true
      session.setPermissionCheckHandler(null)
      session.setPermissionRequestHandler(null)
      session.setDisplayMediaRequestHandler(null)
      session.setDevicePermissionHandler(null)
      session.removeListener('will-download', onWillDownload)
      session.removeListener('file-system-access-restricted', onFileSystemAccessRestricted)
      session.removeListener('select-hid-device', onSelectHidDevice)
      session.removeListener('select-usb-device', onSelectUsbDevice)
      session.removeListener('select-serial-port', onSelectSerialPort)
      session.removeListener('hid-device-revoked', onHidDeviceRevoked)
      session.removeListener('usb-device-revoked', onUsbDeviceRevoked)
      session.removeListener('serial-port-revoked', onSerialPortRevoked)
      trustedContents.removeListener('select-bluetooth-device', onSelectBluetoothDevice)
      if (bluetoothSelection !== undefined) {
        finishBluetoothSelection(bluetoothSelection, '')
      }
      ledger.clear()
    },
  }
}
