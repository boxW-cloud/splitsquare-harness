const SECRET_TOKEN = /\b(?:sk|ark)-[A-Za-z0-9_-]{8,}\b/g

/** Redact common API-key shapes before a child log reaches an error surface. */
export function redactLogLine(line: string): string {
  return line.replaceAll(SECRET_TOKEN, '[REDACTED]')
}

/** Small bounded tail; a failed backend must not grow the Electron process forever. */
export class LogBuffer {
  private readonly lines: string[] = []

  constructor(private readonly limit = 200) {
    if (!Number.isInteger(limit) || limit < 1) throw new Error('log buffer limit must be a positive integer')
  }

  push(line: string): void {
    this.lines.push(redactLogLine(line))
    if (this.lines.length > this.limit) this.lines.splice(0, this.lines.length - this.limit)
  }

  snapshot(): readonly string[] {
    return [...this.lines]
  }
}

