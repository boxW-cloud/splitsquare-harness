import { spawnSync } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

const root = process.cwd()
const outputPath = path.join(root, 'THIRD_PARTY_NOTICES.md')
const checkOnly = process.argv.includes('--check')

const command = process.platform === 'win32' ? (process.env.ComSpec || 'cmd.exe') : 'corepack'
const args = process.platform === 'win32'
  ? ['/d', '/s', '/c', 'corepack pnpm licenses list --prod --json']
  : ['pnpm', 'licenses', 'list', '--prod', '--json']
const result = spawnSync(command, args, {
  cwd: root,
  encoding: 'utf8',
  env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' },
  maxBuffer: 32 * 1024 * 1024,
})

if (result.status !== 0) {
  process.stderr.write(
    result.stderr
      || (result.error ? `${result.error.message}\n` : 'Unable to collect production dependency licenses.\n'),
  )
  process.exit(1)
}

const licenses = JSON.parse(result.stdout.replace(/^\uFEFF/u, ''))
const packages = []
for (const [license, entries] of Object.entries(licenses)) {
  for (const entry of entries) {
    packages.push({
      homepage: entry.homepage || '',
      license,
      name: entry.name,
      versions: [...entry.versions].sort(),
    })
  }
}
packages.sort((left, right) => {
  const nameOrder = left.name.localeCompare(right.name)
  return nameOrder || left.versions.join(',').localeCompare(right.versions.join(','))
})

const deepSeekLicense = (await readFile(
  path.join(root, 'node_modules', '@deepseek-ai', 'dsh', 'LICENSE'),
  'utf8',
)).trim()
const electronPackage = JSON.parse(await readFile(
  path.join(root, 'node_modules', 'electron', 'package.json'),
  'utf8',
))
const electronLicense = (await readFile(
  path.join(root, 'node_modules', 'electron', 'LICENSE'),
  'utf8',
)).trim()

const fluentLicense = `MIT License

Copyright (c) 2020 Microsoft Corporation

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.`

function escapeCell(value) {
  return String(value).replaceAll('|', '\\|').replaceAll('\n', ' ')
}

const lines = [
  '# Third-Party Notices',
  '',
  'This deterministic inventory is generated from the pinned production dependency graph by `pnpm licenses`. It is provided for attribution and review; package-level license files remain authoritative.',
  '',
  'The release also contains the Electron runtime even though Electron is a development-time packager dependency, so it is listed explicitly below.',
  '',
  '## Explicitly embedded components',
  '',
  `### Electron ${electronPackage.version}`,
  '',
  'Source: https://github.com/electron/electron',
  '',
  '```text',
  electronLicense,
  '```',
  '',
  '### DeepSeek Harness',
  '',
  'Source: https://github.com/deepseek-ai/deepseek-harness',
  '',
  'The software license below does not grant trademark rights in DeepSeek names or marks. See `BRANDING.md`.',
  '',
  '```text',
  deepSeekLicense,
  '```',
  '',
  '### Microsoft Fluent UI System Icons',
  '',
  'The unmodified panel, back, and forward SVGs came from `@fluentui/svg-icons` 1.1.337.',
  'Source: https://github.com/microsoft/fluentui-system-icons',
  '',
  '```text',
  fluentLicense,
  '```',
  '',
  '## Production package inventory',
  '',
  '| Package | Version(s) | License | Project |',
  '| --- | --- | --- | --- |',
]

for (const entry of packages) {
  const project = entry.homepage ? `[link](${entry.homepage})` : ''
  lines.push(
    `| ${escapeCell(entry.name)} | ${escapeCell(entry.versions.join(', '))} | ${escapeCell(entry.license)} | ${project} |`,
  )
}
lines.push('')

const generated = `${lines.join('\n')}\n`
if (checkOnly) {
  let existing = ''
  try {
    existing = await readFile(outputPath, 'utf8')
  } catch {
    // Report the same stale-file error for a missing file.
  }
  if (existing !== generated) {
    console.error('THIRD_PARTY_NOTICES.md is missing or stale. Run `pnpm licenses`.')
    process.exit(1)
  }
  console.log(`Third-party notice inventory is current (${packages.length} packages).`)
} else {
  await writeFile(outputPath, generated, 'utf8')
  console.log(`Wrote THIRD_PARTY_NOTICES.md (${packages.length} packages).`)
}
