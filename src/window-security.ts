import type { BrowserWindow, WebContents } from 'electron'
import { shell } from 'electron'
import { isAllowedHarnessNavigation, safeExternalUrl } from './navigation-policy.js'

/** Harden one Harness WebContents around a mutable, exact Harness origin. */
export function installWindowSecurity(
  window: BrowserWindow,
  harnessOrigin: () => string | undefined,
  trustedContents: WebContents = window.webContents,
): void {
  const handleNavigation = (event: Electron.Event, target: string): void => {
    const origin = harnessOrigin()
    if (origin !== undefined && isAllowedHarnessNavigation(target, origin)) return
    // The local startup/error document is the only non-Harness main-frame load.
    if (origin === undefined && target.startsWith('data:text/html;charset=UTF-8,')) return
    event.preventDefault()
    const external = safeExternalUrl(target)
    if (external !== undefined) void shell.openExternal(external)
  }

  trustedContents.on('will-navigate', handleNavigation)
  trustedContents.on('will-redirect', handleNavigation)
  trustedContents.on('will-attach-webview', (event) => event.preventDefault())
  trustedContents.setWindowOpenHandler(({ url }) => {
    const external = safeExternalUrl(url)
    if (external !== undefined) void shell.openExternal(external)
    return { action: 'deny' }
  })
  trustedContents.session.setPermissionCheckHandler(() => false)
  trustedContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
}
