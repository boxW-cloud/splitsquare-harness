/** Whether a renderer navigation stays inside the one Harness origin we started. */
export function isAllowedHarnessNavigation(target: string, harnessOrigin: string): boolean {
  try {
    const url = new URL(target)
    const expected = new URL(harnessOrigin)
    return expected.protocol === 'http:'
      && expected.hostname === '127.0.0.1'
      && url.origin === expected.origin
      && url.username === ''
      && url.password === ''
  } catch {
    return false
  }
}

/**
 * Return a URL that may be handed to the operating-system browser. Only HTTPS
 * leaves the app; every privileged/local scheme remains denied.
 */
export function safeExternalUrl(target: string): string | undefined {
  try {
    const url = new URL(target)
    if (url.protocol !== 'https:' || url.username !== '' || url.password !== '') return undefined
    return url.href
  } catch {
    return undefined
  }
}

