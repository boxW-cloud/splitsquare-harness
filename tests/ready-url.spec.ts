import { describe, expect, it } from 'vitest'
import { parseHarnessReadyUrl } from '../src/ready-url.js'

describe('parseHarnessReadyUrl', () => {
  it('accepts the exact loopback readiness signal', () => {
    expect(parseHarnessReadyUrl('dsh web: http://127.0.0.1:43127')?.href)
      .toBe('http://127.0.0.1:43127/')
  })

  it.each([
    'prefix dsh web: http://127.0.0.1:43127',
    'dsh web: http://localhost:43127',
    'dsh web: http://0.0.0.0:43127',
    'dsh web: https://127.0.0.1:43127',
    'dsh web: http://127.0.0.1:0',
    'dsh web: http://127.0.0.1:65536',
    'dsh web: http://127.0.0.1:43127/other',
    'dsh web: http://user@127.0.0.1:43127',
  ])('rejects unsafe or non-canonical output: %s', (line) => {
    expect(parseHarnessReadyUrl(line)).toBeUndefined()
  })
})

