import { readdir, readFile, stat } from 'node:fs/promises'
import path from 'node:path'

const root = process.cwd()
const ignoredDirectories = new Set([
  '.git',
  '.idea',
  '.vscode',
  'artifacts',
  'coverage',
  'dist',
  'node_modules',
  'out',
])
const ignoredFiles = new Set(['design-qa.md'])
const textExtensions = new Set([
  '', '.cjs', '.css', '.html', '.js', '.json', '.md', '.mjs', '.ts', '.txt', '.yaml', '.yml',
])

const rules = [
  {
    name: 'Ark API key',
    expression: /\bark-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}-[a-z0-9_-]{5,}\b/giu,
  },
  {
    name: 'OpenAI-style secret key',
    expression: /\bsk-[a-z0-9_-]{20,}\b/giu,
  },
  {
    name: 'GitHub token',
    expression: /\b(?:gh[oprsu]_[a-z0-9]{30,}|github_pat_[a-z0-9_]{40,})\b/giu,
  },
  {
    name: 'Slack token',
    expression: /\bxox[baprs]-[a-z0-9-]{20,}\b/giu,
  },
  {
    name: 'cloud access key',
    expression: /\b(?:AKIA|ASIA|AKLT)[A-Z0-9]{12,}\b/gu,
  },
  {
    name: 'private key material',
    expression: /-----BEGIN (?:EC |OPENSSH |RSA )?PRIVATE KEY-----/gu,
  },
  {
    name: 'personal Windows profile path',
    expression: /[A-Z]:\\Users\\(?!Public(?:\\|$)|Default(?:\\|$)|<username>(?:\\|$)|USERNAME(?:\\|$))[^\\\r\n`]+\\/gu,
  },
]

const findings = []

async function visit(directory) {
  const entries = await readdir(directory, { withFileTypes: true })
  entries.sort((left, right) => left.name.localeCompare(right.name))

  for (const entry of entries) {
    const absolute = path.join(directory, entry.name)
    const relative = path.relative(root, absolute).replaceAll('\\', '/')

    if (entry.isDirectory()) {
      if (!ignoredDirectories.has(entry.name)) {
        await visit(absolute)
      }
      continue
    }

    if (!entry.isFile() || ignoredFiles.has(relative) || !textExtensions.has(path.extname(entry.name))) {
      continue
    }

    if ((await stat(absolute)).size > 2 * 1024 * 1024) {
      continue
    }

    const content = await readFile(absolute, 'utf8')
    for (const rule of rules) {
      rule.expression.lastIndex = 0
      if (rule.expression.test(content)) {
        findings.push({ file: relative, rule: rule.name })
      }
    }
  }
}

await visit(root)

if (findings.length > 0) {
  console.error('Potential private material found (matched values are intentionally not printed):')
  for (const finding of findings) {
    console.error(`- ${finding.file}: ${finding.rule}`)
  }
  process.exitCode = 1
} else {
  console.log('Secret and private-path scan passed.')
}
