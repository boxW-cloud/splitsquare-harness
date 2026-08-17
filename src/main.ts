import { existsSync } from 'node:fs'
import { stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  Menu,
  nativeTheme,
  shell,
} from 'electron'
import started from 'electron-squirrel-startup'
import { DshProcess, type UnexpectedBackendExit } from './dsh-process.js'
import { installElectronCapabilities } from './electron-capabilities.js'
import { listPrivateLanAddresses, pickPreferredLanAddress } from './lan-network.js'
import { safeExternalUrl } from './navigation-policy.js'
import { errorPage, startupPage, toDataUrl } from './page-html.js'
import { RemoteAccess, type RemoteConnectionInfo } from './remote-access.js'
import {
  CorruptSettingsError,
  defaultDesktopSettings,
  type DesktopSettings,
  SettingsStore,
  UnsupportedSettingsVersionError,
} from './settings-store.js'
import { installWindowSecurity } from './window-security.js'
import { type ShellMenuId } from './shell-contract.js'
import { createDesktopWindowShell, type DesktopWindowShell } from './window-shell.js'

const APP_NAME = 'SplitSquare Harness'
const SMOKE_TEST = process.argv.includes('--smoke-test')

let mainWindow: BrowserWindow | undefined
let desktopShell: DesktopWindowShell | undefined
let backend: DshProcess | undefined
let harnessOrigin: string | undefined
let workspace = ''
let settings = defaultDesktopSettings()
let settingsStore: SettingsStore
let settingsWritable = true
let quitting = false
let restartInFlight: Promise<void> | undefined
const remoteAccess = new RemoteAccess()

function runnerPath(): string {
  return fileURLToPath(new URL('./runner.js', import.meta.url))
}

function desktopSettingsPath(): string {
  return join(app.getPath('userData'), 'desktop-settings.json')
}

async function isDirectory(path: string | undefined): Promise<boolean> {
  if (path === undefined || path === '') return false
  try {
    return (await stat(path)).isDirectory()
  } catch {
    return false
  }
}

async function loadDesktopSettings(): Promise<void> {
  settingsStore = new SettingsStore(desktopSettingsPath())
  try {
    settings = await settingsStore.load()
  } catch (error) {
    settings = defaultDesktopSettings()
    settingsWritable = !(error instanceof UnsupportedSettingsVersionError)
    const detail = error instanceof CorruptSettingsError
      ? `损坏的原文件已安全备份到：\n${error.backupPath}`
      : error instanceof UnsupportedSettingsVersionError
        ? `配置由更新版本创建（schema ${String(error.version)}），本次运行不会覆盖它。`
        : String(error)
    await dialog.showMessageBox({
      type: 'warning',
      title: '桌面配置无法读取',
      message: '已使用安全默认配置启动。',
      detail,
    })
  }
}

async function persistSettings(next: DesktopSettings): Promise<void> {
  settings = next
  if (settingsWritable) await settingsStore.save(next)
}

async function chooseInitialWorkspace(): Promise<string> {
  const fromEnvironment = process.env.DSH_DESKTOP_WORKSPACE
  if (await isDirectory(fromEnvironment)) return resolve(fromEnvironment as string)
  if (await isDirectory(settings.workspace)) return resolve(settings.workspace as string)
  return app.getPath('documents')
}

function iconPath(): string | undefined {
  const candidate = join(app.getAppPath(), 'assets', process.platform === 'win32' ? 'icon.ico' : 'icon.png')
  return existsSync(candidate) ? candidate : undefined
}

function createWindow(): BrowserWindow {
  const icon = iconPath()
  const controller = createDesktopWindowShell({
    title: APP_NAME,
    ...(icon === undefined ? {} : { icon }),
    onMenuPopup: ({ menu, x, y }) => popupShellMenu(menu, x, y),
  })
  desktopShell = controller
  const { window, harnessContents } = controller
  installWindowSecurity(window, () => harnessOrigin, harnessContents)
  const capabilities = installElectronCapabilities(window, () => harnessOrigin, {}, harnessContents)
  installShortcutHandling(window, harnessContents)
  window.once('ready-to-show', () => window.show())
  window.on('closed', () => {
    capabilities.dispose()
    controller.dispose()
    if (desktopShell === controller) desktopShell = undefined
    if (mainWindow === window) mainWindow = undefined
  })
  return window
}

async function showStartup(): Promise<void> {
  harnessOrigin = undefined
  await desktopShell?.harnessContents.loadURL(toDataUrl(startupPage(workspace)))
}

async function showBackendError(error: unknown, logs: readonly string[] = []): Promise<void> {
  harnessOrigin = undefined
  const message = error instanceof Error ? error.message : String(error)
  await desktopShell?.harnessContents.loadURL(toDataUrl(errorPage(message, logs)))
}

function onUnexpectedExit(exit: UnexpectedBackendExit): void {
  if (quitting) return
  void remoteAccess.setTarget(undefined)
  installMenu()
  void showBackendError(
    new Error(`后端意外退出（code=${String(exit.code)}, signal=${String(exit.signal)}）`),
    exit.logs,
  )
}

async function startBackend(): Promise<void> {
  await showStartup()
  const next = new DshProcess({ runnerPath: runnerPath(), workspace })
  next.on('unexpected-exit', onUnexpectedExit)
  backend = next
  const url = await next.start()
  if (backend !== next || quitting) {
    await next.stop()
    return
  }
  harnessOrigin = url.origin
  if (remoteAccess.running) await remoteAccess.setTarget(url)
  const contents = desktopShell?.harnessContents
  await contents?.loadURL(url.href)
  // Startup/error documents are implementation details, not user navigation entries.
  contents?.navigationHistory.clear()
  desktopShell?.publishState()
  if (settings.lanGateway.enabled && !remoteAccess.running) {
    try {
      await enableRemoteAccess(url, !SMOKE_TEST)
    } catch (error) {
      if (SMOKE_TEST) throw error
      await showRemoteError(error)
    }
  }
  installMenu()

  if (SMOKE_TEST) {
    const healthy = await desktopShell?.harnessContents.executeJavaScript(
      "Boolean(window.__DSH_BOOT__ && document.getElementById('root'))",
      true,
    )
    if (healthy !== true) throw new Error('desktop smoke: renderer boot evidence missing')
    console.log(`desktop smoke: ready ${url.origin}`)
    await remoteAccess.stop()
    await next.stop()
    app.exit(0)
  }
}

function restartBackend(): Promise<void> {
  if (restartInFlight !== undefined) return restartInFlight
  const run = (async () => {
    const previous = backend
    backend = undefined
    await remoteAccess.setTarget(undefined)
    if (previous !== undefined) {
      previous.off('unexpected-exit', onUnexpectedExit)
      await previous.stop()
    }
    if (quitting) return
    try {
      await startBackend()
    } catch (error) {
      await showBackendError(error, currentBackendLogs())
    }
  })().finally(() => {
    if (restartInFlight === run) restartInFlight = undefined
  })
  restartInFlight = run
  return run
}

function currentBackendLogs(): readonly string[] {
  return backend?.logTail ?? []
}

async function pickWorkspace(): Promise<void> {
  if (mainWindow === undefined) return
  const result = await dialog.showOpenDialog(mainWindow, {
    title: '选择 SplitSquare Harness 默认工作目录',
    defaultPath: workspace,
    properties: ['openDirectory', 'createDirectory'],
  })
  const selected = result.filePaths[0]
  if (result.canceled || selected === undefined) return
  workspace = resolve(selected)
  await persistSettings({ ...settings, workspace })
  await restartBackend()
}

function availableBindAddress(): string | undefined {
  const candidates = listPrivateLanAddresses()
  const configured = settings.lanGateway.bindAddress
  if (configured !== undefined && candidates.some((item) => item.address === configured)) {
    return configured
  }
  return pickPreferredLanAddress(candidates)?.address
}

async function enableRemoteAccess(target: URL, showInfo: boolean): Promise<void> {
  const bindAddress = availableBindAddress()
  if (bindAddress === undefined) throw new Error('未找到可用的私有 IPv4 网卡')
  await remoteAccess.stop()
  const info = await remoteAccess.start({
    bindAddress,
    port: settings.lanGateway.port,
  }, target)
  try {
    await persistSettings({
      ...settings,
      lanGateway: { ...settings.lanGateway, enabled: true, bindAddress },
    })
  } catch (error) {
    await remoteAccess.stop()
    throw error
  }
  installMenu()
  if (showInfo) await showRemoteInfo(info)
}

async function disableRemoteAccess(): Promise<void> {
  await remoteAccess.stop()
  await persistSettings({
    ...settings,
    lanGateway: { ...settings.lanGateway, enabled: false },
  })
  installMenu()
}

async function toggleRemoteAccess(): Promise<void> {
  if (remoteAccess.running || settings.lanGateway.enabled) {
    await disableRemoteAccess()
    return
  }
  const url = backend?.url
  if (url === undefined) {
    await showRemoteError(new Error('Harness 后端尚未就绪'))
    return
  }
  try {
    await enableRemoteAccess(url, true)
  } catch (error) {
    await persistSettings({
      ...settings,
      lanGateway: { ...settings.lanGateway, enabled: false },
    })
    await showRemoteError(error)
  }
}

async function chooseBindAddress(address: string): Promise<void> {
  const wasEnabled = settings.lanGateway.enabled
  await persistSettings({
    ...settings,
    lanGateway: { ...settings.lanGateway, bindAddress: address },
  })
  if (remoteAccess.running) await remoteAccess.stop()
  const target = backend?.url
  if (wasEnabled && target !== undefined) {
    try {
      await enableRemoteAccess(target, true)
    } catch (error) {
      await showRemoteError(error)
    }
  }
  installMenu()
}

async function showNewPairing(): Promise<void> {
  try {
    await showRemoteInfo(remoteAccess.createPairing())
  } catch (error) {
    await showRemoteError(error)
  }
}

async function showRemoteInfo(info: RemoteConnectionInfo): Promise<void> {
  const expires = new Date(info.expiresAt).toLocaleTimeString()
  const details = [
    `地址：${info.origin}`,
    `一次性配对码：${info.code}`,
    `配对码有效至：${expires}`,
    '',
    `TLS SHA-256 指纹：\n${info.fingerprint256}`,
    '',
    '首次访问会看到自签名证书提示。请先核对上面的指纹；不要在不可信网络中忽略不匹配的证书。',
    '远程用户登录后拥有与本机 Harness 相同的文件、终端和 Agent 权限。',
  ].join('\n')
  const options: Electron.MessageBoxOptions = {
    type: 'info',
    title: '局域网安全访问',
    message: 'HTTPS/WSS 网关已启用',
    detail: details,
    buttons: ['复制全部连接信息', '只复制地址', '关闭'],
    defaultId: 0,
    cancelId: 2,
    noLink: true,
  }
  const result = mainWindow === undefined
    ? await dialog.showMessageBox(options)
    : await dialog.showMessageBox(mainWindow, options)
  if (result.response === 0) clipboard.writeText(details)
  if (result.response === 1) clipboard.writeText(info.origin)
}

async function showRemoteError(error: unknown): Promise<void> {
  const options: Electron.MessageBoxOptions = {
    type: 'error',
    title: '局域网访问启动失败',
    message: error instanceof Error ? error.message : String(error),
  }
  if (mainWindow === undefined) await dialog.showMessageBox(options)
  else await dialog.showMessageBox(mainWindow, options)
}

function fileMenuItems(): Electron.MenuItemConstructorOptions[] {
  return [
    { label: '选择默认工作目录…', accelerator: 'Ctrl+Shift+O', click: () => void pickWorkspace() },
    { label: '重新启动后端', accelerator: 'Ctrl+Shift+R', click: () => void restartBackend() },
    { type: 'separator' },
    { label: '退出', accelerator: 'Ctrl+Q', click: () => app.quit() },
  ]
}

function remoteMenuItems(): Electron.MenuItemConstructorOptions[] {
  const addresses = listPrivateLanAddresses()
  const remoteStatus = remoteAccess.status()
  return [
    {
      label: '同一局域网 HTTPS/WSS 访问',
      sublabel: '仅限同一私有网络，不是互联网远程通讯',
      type: 'checkbox',
      checked: remoteAccess.running,
      click: () => void toggleRemoteAccess(),
    },
    {
      label: '生成并显示新配对码…',
      enabled: remoteAccess.running,
      click: () => void showNewPairing(),
    },
    {
      label: '复制局域网访问地址',
      enabled: remoteStatus !== undefined,
      click: () => {
        if (remoteStatus !== undefined) clipboard.writeText(remoteStatus.origin)
      },
    },
    { type: 'separator' },
    {
      label: '绑定网卡',
      submenu: addresses.length === 0
        ? [{ label: '未发现私有 IPv4 网卡', enabled: false }]
        : addresses.map((candidate) => ({
          label: `${candidate.interfaceName} — ${candidate.address}${candidate.virtual ? '（虚拟）' : ''}`,
          type: 'radio' as const,
          checked: settings.lanGateway.bindAddress === candidate.address
            || (settings.lanGateway.bindAddress === undefined
              && pickPreferredLanAddress(addresses)?.address === candidate.address),
          click: () => void chooseBindAddress(candidate.address),
        })),
    },
  ]
}

function viewMenuItems(): Electron.MenuItemConstructorOptions[] {
  const contents = desktopShell?.harnessContents
  return [
    { label: '刷新界面', accelerator: 'Ctrl+R', click: () => contents?.reload() },
    {
      label: '切换全屏',
      accelerator: 'F11',
      type: 'checkbox',
      checked: mainWindow?.isFullScreen() ?? false,
      click: () => {
        if (mainWindow !== undefined) mainWindow.setFullScreen(!mainWindow.isFullScreen())
      },
    },
    ...(app.isPackaged ? [] : [{
      label: 'Harness 开发者工具',
      click: () => {
        if (contents === undefined) return
        if (contents.isDevToolsOpened()) contents.closeDevTools()
        else contents.openDevTools({ mode: 'detach' })
      },
    }]),
  ]
}

function windowMenuItems(): Electron.MenuItemConstructorOptions[] {
  const window = mainWindow
  return [
    { label: '最小化', click: () => window?.minimize() },
    {
      label: window?.isMaximized() === true ? '还原' : '最大化',
      click: () => {
        if (window === undefined) return
        if (window.isMaximized()) window.unmaximize()
        else window.maximize()
      },
    },
    { type: 'separator' },
    { label: '关闭窗口', accelerator: 'Alt+F4', click: () => window?.close() },
  ]
}

function helpMenuItems(): Electron.MenuItemConstructorOptions[] {
  const projectUrl = safeExternalUrl('https://github.com/boxW-cloud/splitsquare-harness') as string
  const upstreamUrl = safeExternalUrl('https://github.com/deepseek-ai/deepseek-harness') as string
  return [
    { label: 'SplitSquare Harness 开源仓库', click: () => void shell.openExternal(projectUrl) },
    { label: 'DeepSeek Harness 上游项目', click: () => void shell.openExternal(upstreamUrl) },
    { type: 'separator' },
    {
      label: '关于 SplitSquare Harness',
      click: () => {
        const options: Electron.MessageBoxOptions = {
          type: 'info',
          title: '关于 SplitSquare Harness',
          message: 'SplitSquare Harness',
          detail: `桌面壳版本 ${app.getVersion()}\n基于开源 DeepSeek Harness ${String(process.env.npm_package_version ?? '0.1.0-rc.6')}\n\n由独立第三方维护，与 DeepSeek 无隶属关系，且未获其授权、认可或赞助。`,
        }
        if (mainWindow === undefined) void dialog.showMessageBox(options)
        else void dialog.showMessageBox(mainWindow, options)
      },
    },
  ]
}

function menuItems(menu: ShellMenuId): Electron.MenuItemConstructorOptions[] {
  if (menu === 'file') return fileMenuItems()
  if (menu === 'remote') return remoteMenuItems()
  if (menu === 'view') return viewMenuItems()
  if (menu === 'window') return windowMenuItems()
  return helpMenuItems()
}

function popupShellMenu(menu: ShellMenuId, x: number, y: number): void {
  if (mainWindow === undefined) return
  Menu.buildFromTemplate(menuItems(menu)).popup({
    window: mainWindow,
    x,
    y,
    callback: () => desktopShell?.publishState(),
  })
}

function installShortcutHandling(window: BrowserWindow, contents: Electron.WebContents): void {
  const handleInput = (event: Electron.Event, input: Electron.Input): void => {
    if (input.type !== 'keyDown') return
    const key = input.key.toLowerCase()
    const command = input.control || input.meta

    if (command && input.shift && key === 'o') {
      event.preventDefault()
      void pickWorkspace()
      return
    }
    if (command && input.shift && key === 'r') {
      event.preventDefault()
      void restartBackend()
      return
    }
    if (command && !input.shift && key === 'r') {
      event.preventDefault()
      contents.reload()
      return
    }
    if (command && key === 'q') {
      event.preventDefault()
      app.quit()
      return
    }
    if (input.alt && key === 'left') {
      event.preventDefault()
      if (contents.navigationHistory.canGoBack()) contents.navigationHistory.goBack()
      return
    }
    if (input.alt && key === 'right') {
      event.preventDefault()
      if (contents.navigationHistory.canGoForward()) contents.navigationHistory.goForward()
      return
    }
    if (key === 'f11') {
      event.preventDefault()
      window.setFullScreen(!window.isFullScreen())
    }
  }
  window.webContents.on('before-input-event', handleInput)
  contents.on('before-input-event', handleInput)
}

function installMenu(): void {
  Menu.setApplicationMenu(null)
  mainWindow?.setMenu(null)
  mainWindow?.setMenuBarVisibility(false)
}

async function bootstrap(): Promise<void> {
  await app.whenReady()
  nativeTheme.themeSource = 'system'
  app.setName(APP_NAME)
  if (process.platform === 'win32') app.setAppUserModelId('org.splitsquare.harness.desktop')
  await loadDesktopSettings()
  workspace = await chooseInitialWorkspace()
  mainWindow = createWindow()
  installMenu()
  try {
    await startBackend()
  } catch (error) {
    if (SMOKE_TEST) {
      console.error(error)
      await remoteAccess.stop()
      await backend?.stop()
      app.exit(1)
      return
    }
    await showBackendError(error, currentBackendLogs())
  }
}

if (started) {
  app.quit()
} else if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow === undefined) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.show()
    mainWindow.focus()
  })
  app.on('activate', () => {
    if (mainWindow !== undefined) return
    mainWindow = createWindow()
    void restartBackend()
  })
  app.on('window-all-closed', () => app.quit())
  app.on('before-quit', (event) => {
    if (quitting) return
    event.preventDefault()
    quitting = true
    void (async () => {
      await remoteAccess.stop()
      await backend?.stop()
      app.exit(0)
    })()
  })
  if (SMOKE_TEST) {
    setTimeout(() => {
      console.error('desktop smoke: timed out')
      void remoteAccess.stop().finally(() => backend?.stop()).finally(() => app.exit(1))
    }, 120_000).unref()
  }
  void bootstrap()
}
