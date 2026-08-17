import { describe, expect, it } from 'vitest'
import { isAllowedHarnessNavigation, safeExternalUrl } from '../src/navigation-policy.js'

describe('desktop navigation policy', () => {
  const origin = 'http://127.0.0.1:43127'

  it('allows every path on the one exact Harness origin', () => {
    expect(isAllowedHarnessNavigation(`${origin}/`, origin)).toBe(true)
    expect(isAllowedHarnessNavigation(`${origin}/plugins/example/client.js`, origin)).toBe(true)
  })

  it.each([
    'http://127.0.0.1:43128/',
    'http://localhost:43127/',
    'https://127.0.0.1:43127/',
    'file:///C:/Windows/System32/calc.exe',
    'javascript:alert(1)',
  ])('blocks a target outside that origin: %s', (target) => {
    expect(isAllowedHarnessNavigation(target, origin)).toBe(false)
  })

  it('hands only credential-free HTTPS links to the system browser', () => {
    expect(safeExternalUrl('https://github.com/deepseek-ai/deepseek-harness'))
      .toBe('https://github.com/deepseek-ai/deepseek-harness')
    expect(safeExternalUrl('http://example.com')).toBeUndefined()
    expect(safeExternalUrl('https://user@example.com')).toBeUndefined()
    expect(safeExternalUrl('file:///tmp/a')).toBeUndefined()
  })
})

