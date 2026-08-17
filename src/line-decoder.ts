/** Stateful UTF-8 text-line splitter for child stdout/stderr chunks. */
export class LineDecoder {
  private remainder = ''

  push(chunk: Buffer | string): string[] {
    const text = this.remainder + chunk.toString()
    const parts = text.split(/\r?\n/)
    this.remainder = parts.pop() ?? ''
    return parts
  }

  flush(): string | undefined {
    if (this.remainder === '') return undefined
    const line = this.remainder
    this.remainder = ''
    return line
  }
}

