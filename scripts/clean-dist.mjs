import { rm } from 'node:fs/promises'
import { resolve } from 'node:path'

const projectRoot = resolve(import.meta.dirname, '..')
const outputPath = resolve(projectRoot, 'dist')

if (!outputPath.startsWith(`${projectRoot}\\`) && !outputPath.startsWith(`${projectRoot}/`)) {
  throw new Error(`Refusing to clean output outside the project: ${outputPath}`)
}

await rm(outputPath, { recursive: true, force: true })
