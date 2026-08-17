import { describe, expect, it } from 'vitest'
import { LogBuffer, redactLogLine } from '../src/log-buffer.js'

describe('backend log safety', () => {
  it('redacts DeepSeek and Volcengine key shapes before display', () => {
    expect(redactLogLine('keys sk-example_123456 ark-example-123456')).toBe(
      'keys [REDACTED] [REDACTED]',
    )
  })

  it('keeps only a bounded tail', () => {
    const logs = new LogBuffer(2)
    logs.push('first')
    logs.push('second')
    logs.push('third')
    expect(logs.snapshot()).toEqual(['second', 'third'])
  })

  it('returns a defensive snapshot', () => {
    const logs = new LogBuffer(2)
    logs.push('safe')
    const snapshot = logs.snapshot() as string[]
    snapshot.push('mutated')
    expect(logs.snapshot()).toEqual(['safe'])
  })
})
