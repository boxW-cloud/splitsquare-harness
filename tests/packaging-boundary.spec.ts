import { describe, expect, it } from 'vitest'
import forgeConfig from '../forge.config.js'

const ignoreRules = forgeConfig.packagerConfig?.ignore

function isIgnored(candidate: string): boolean {
  if (!Array.isArray(ignoreRules)) {
    throw new Error('Forge packager ignore rules must remain an explicit array')
  }
  return ignoreRules.some((rule) => {
    if (!(rule instanceof RegExp)) return false
    rule.lastIndex = 0
    return rule.test(candidate)
  })
}

describe('packaged application boundary', () => {
  it.each([
    '/.env',
    '/.env.local',
    '/.github/workflows/release.yml',
    '/artifacts/design-qa/implementation-final.png',
    '/design-qa.md',
    '/private-signing.pfx',
    '/scripts/check-secrets.mjs',
    '/src/main.ts',
    '/tests/runtime.integration.spec.ts',
  ])('excludes development or private file %s', (candidate) => {
    expect(isIgnored(candidate)).toBe(true)
  })

  it.each([
    '/assets/icon.ico',
    '/assets/shell.html',
    '/dist/main.js',
    '/LICENSE',
    '/NOTICE.md',
    '/package.json',
    '/THIRD_PARTY_NOTICES.md',
  ])('retains runtime or legal file %s', (candidate) => {
    expect(isIgnored(candidate)).toBe(false)
  })
})
