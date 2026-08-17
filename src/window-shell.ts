import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  app,
  BrowserWindow,
  ipcMain,
  nativeTheme,
  WebContentsView,
  type WebContents,
} from 'electron'
import {
  DEFAULT_CHROME_HEIGHT,
  SHELL_COMMAND_CHANNEL,
  SHELL_STATE_CHANNEL,
  computeHarnessBounds,
  parseShellCommand,
  type ShellMenuId,
  type ShellState,
} from './shell-contract.js'

const SIDEBAR_SCRIPT = `(() => {
  const collapse = document.querySelector(
    '[aria-label="收起侧边栏"], [aria-label="Collapse sidebar"]'
  );
  const open = document.querySelector(
    '[aria-label="打开侧边栏"], [aria-label="Open sidebar"]'
  );
  const button = collapse || open;
  if (!(button instanceof HTMLElement)) return { clicked: false, wasOpen: false };
  const wasOpen = Boolean(collapse);
  button.click();
  return { clicked: true, wasOpen };
})()`

export interface ShellMenuPopup {
  readonly menu: ShellMenuId
  readonly x: number
  readonly y: number
}

export interface DesktopWindowShellOptions {
  readonly title: string
  readonly icon?: string
  readonly onMenuPopup: (request: ShellMenuPopup) => void
}

export interface DesktopWindowShell {
  readonly window: BrowserWindow
  readonly harnessContents: WebContents
  publishState(): void
  dispose(): void
}

function shellAsset(name: string): string {
  const path = join(app.getAppPath(), 'assets', name)
  if (!existsSync(path)) throw new Error(`desktop shell asset is missing: ${path}`)
  return path
}

function harnessPreferences(): Electron.WebPreferences {
  return {
    nodeIntegration: false,
    contextIsolation: true,
    sandbox: true,
    webSecurity: true,
    allowRunningInsecureContent: false,
    devTools: !app.isPackaged,
    webviewTag: false,
  }
}

function titleBarOptions(): Pick<Electron.BrowserWindowConstructorOptions, 'titleBarStyle' | 'titleBarOverlay'> {
  if (process.platform === 'darwin') return { titleBarStyle: 'hiddenInset' }
  return {
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: nativeTheme.shouldUseDarkColors ? '#202124' : '#f2f2f2',
      symbolColor: nativeTheme.shouldUseDarkColors ? '#f1f3f4' : '#202124',
      height: 30,
    },
  }
}

export function createDesktopWindowShell(options: DesktopWindowShellOptions): DesktopWindowShell {
  const preload = shellAsset('shell-preload.cjs')
  const shellDocument = shellAsset('shell.html')
  const shellUrl = pathToFileURL(shellDocument).href
  const window = new BrowserWindow({
    title: options.title,
    width: 1440,
    height: 920,
    minWidth: 960,
    minHeight: 640,
    show: false,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#202124' : '#f2f2f2',
    autoHideMenuBar: true,
    ...(options.icon === undefined ? {} : { icon: options.icon }),
    ...titleBarOptions(),
    webPreferences: {
      ...harnessPreferences(),
      preload,
    },
  })
  window.setMenu(null)
  window.setMenuBarVisibility(false)

  const harnessView = new WebContentsView({ webPreferences: harnessPreferences() })
  const harnessContents = harnessView.webContents
  harnessView.setBackgroundColor('#0b0f16')
  window.contentView.addChildView(harnessView)

  let disposed = false
  let sidebarOpen = true

  const layout = (): void => {
    if (disposed || window.isDestroyed()) return
    const { width, height } = window.getContentBounds()
    harnessView.setBounds(computeHarnessBounds(width, height, DEFAULT_CHROME_HEIGHT))
  }

  const currentState = (): ShellState => ({
    canGoBack: !harnessContents.isDestroyed() && harnessContents.navigationHistory.canGoBack(),
    canGoForward: !harnessContents.isDestroyed() && harnessContents.navigationHistory.canGoForward(),
    sidebarOpen,
  })

  const publishState = (): void => {
    if (disposed || window.isDestroyed() || window.webContents.isDestroyed()) return
    window.webContents.send(SHELL_STATE_CHANNEL, currentState())
  }

  const updateNavigation = (): void => publishState()
  harnessContents.on('did-finish-load', updateNavigation)
  harnessContents.on('did-navigate', updateNavigation)
  harnessContents.on('did-navigate-in-page', updateNavigation)

  const toggleSidebar = async (): Promise<void> => {
    if (harnessContents.isDestroyed()) return
    try {
      const result = await harnessContents.executeJavaScript(SIDEBAR_SCRIPT, true) as unknown
      if (typeof result === 'object' && result !== null && 'clicked' in result && result.clicked === true) {
        sidebarOpen = !('wasOpen' in result && result.wasOpen === true)
      }
    } catch {
      // Startup and error pages do not expose the Harness sidebar.
    }
    publishState()
  }

  const onShellCommand = (event: Electron.IpcMainEvent, value: unknown): void => {
    if (disposed
      || event.sender !== window.webContents
      || event.senderFrame !== window.webContents.mainFrame) return
    const command = parseShellCommand(value)
    if (command === undefined) return

    if (command.type === 'menu') {
      options.onMenuPopup({ menu: command.menu, x: command.x, y: command.y })
      return
    }
    if (command.type === 'back') {
      if (harnessContents.navigationHistory.canGoBack()) harnessContents.navigationHistory.goBack()
      return
    }
    if (command.type === 'forward') {
      if (harnessContents.navigationHistory.canGoForward()) harnessContents.navigationHistory.goForward()
      return
    }
    void toggleSidebar()
  }

  ipcMain.on(SHELL_COMMAND_CHANNEL, onShellCommand)
  window.on('resize', layout)
  window.on('maximize', layout)
  window.on('unmaximize', layout)

  const updateTheme = (): void => {
    if (window.isDestroyed() || process.platform === 'darwin') return
    window.setTitleBarOverlay({
      color: nativeTheme.shouldUseDarkColors ? '#202124' : '#f2f2f2',
      symbolColor: nativeTheme.shouldUseDarkColors ? '#f1f3f4' : '#202124',
      height: 30,
    })
    window.setBackgroundColor(nativeTheme.shouldUseDarkColors ? '#202124' : '#f2f2f2')
  }
  nativeTheme.on('updated', updateTheme)

  window.webContents.on('will-navigate', (event, target) => {
    if (target !== shellUrl) event.preventDefault()
  })
  window.webContents.on('will-redirect', (event) => event.preventDefault())
  window.webContents.on('will-attach-webview', (event) => event.preventDefault())
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('did-finish-load', publishState)

  layout()
  void window.loadFile(shellDocument).catch((error: unknown) => {
    console.error('desktop shell failed to load', error)
  })

  return {
    window,
    harnessContents,
    publishState,
    dispose(): void {
      if (disposed) return
      disposed = true
      ipcMain.removeListener(SHELL_COMMAND_CHANNEL, onShellCommand)
      nativeTheme.removeListener('updated', updateTheme)
      window.removeListener('resize', layout)
      window.removeListener('maximize', layout)
      window.removeListener('unmaximize', layout)
      harnessContents.removeListener('did-finish-load', updateNavigation)
      harnessContents.removeListener('did-navigate', updateNavigation)
      harnessContents.removeListener('did-navigate-in-page', updateNavigation)
      if (!window.isDestroyed()) window.contentView.removeChildView(harnessView)
      if (!harnessContents.isDestroyed()) harnessContents.close()
    },
  }
}
