import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import path from 'node:path'

const root = process.cwd()
const packageJson = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'))
const tag = process.env.GITHUB_REF_NAME || process.argv.find((argument) => argument.startsWith('v'))

if (!/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u.test(packageJson.version)) {
  throw new Error(`package.json version is not a supported release version: ${packageJson.version}`)
}

if (tag && tag !== `v${packageJson.version}`) {
  throw new Error(`Release tag ${tag} does not match package version v${packageJson.version}`)
}

if (packageJson.private !== true) {
  throw new Error('package.json must remain private to prevent accidental npm publication')
}

const icon = await readFile(path.join(root, 'assets', 'icon.svg'))
const iconHash = createHash('sha256').update(icon).digest('hex')
const officialPrototypeIconHash = '035b68e57ac4490f6880e25f4e7f534d7b50b249308ccea77af34cc5d9e840c3'
const packageUsesDeepSeekBrand = [
  packageJson.name,
  packageJson.productName,
  packageJson.description,
].some((value) => typeof value === 'string' && /deepseek/iu.test(value))
const publicIdentityFiles = [
  '.github/workflows/release.yml',
  'assets/shell.html',
  'forge.config.ts',
  'src/main.ts',
]
const publicIdentityPatterns = [
  /DeepSeek Harness Desktop/iu,
  /DeepSeekHarnessDesktop/gu,
  /DeepSeek-Harness-Desktop/gu,
  /ai\.deepseek\.harness\.desktop/gu,
  /<span>DeepSeek Harness<\/span>/iu,
]
let identityUsesDeepSeekBrand = false
for (const relativePath of publicIdentityFiles) {
  const content = await readFile(path.join(root, relativePath), 'utf8')
  for (const pattern of publicIdentityPatterns) {
    pattern.lastIndex = 0
    if (pattern.test(content)) {
      identityUsesDeepSeekBrand = true
    }
  }
}

const usesDeepSeekBrand = packageUsesDeepSeekBrand
  || identityUsesDeepSeekBrand
  || iconHash === officialPrototypeIconHash
const authorizationConfirmed = process.env.TRADEMARK_AUTHORIZATION_CONFIRMED?.trim().toLowerCase() === 'true'
const authorizationReference = process.env.TRADEMARK_AUTHORIZATION_REFERENCE?.trim()

if (usesDeepSeekBrand && (!authorizationConfirmed || !authorizationReference)) {
  throw new Error(
    'Public release blocked: DeepSeek branding is still present. Replace it with independent branding or confirm reviewed written authorization using both protected trademark authorization values. See BRANDING.md.',
  )
}

if (usesDeepSeekBrand) {
  console.warn(`DeepSeek branding release gate was explicitly acknowledged by protected record ${authorizationReference}.`)
}
console.log(`Release preflight passed for ${tag || `v${packageJson.version}`}.`)
