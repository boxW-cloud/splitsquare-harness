import type { ForgeConfig } from '@electron-forge/shared-types'

const certificateFile = process.env.WINDOWS_CERTIFICATE_FILE?.trim()
const certificatePassword = process.env.WINDOWS_CERTIFICATE_PASSWORD

if (Boolean(certificateFile) !== Boolean(certificatePassword)) {
  throw new Error(
    'WINDOWS_CERTIFICATE_FILE and WINDOWS_CERTIFICATE_PASSWORD must be provided together',
  )
}

const windowsSign = certificateFile && certificatePassword
  ? {
      certificateFile,
      certificatePassword,
      description: 'SplitSquare Harness',
    }
  : undefined

const config: ForgeConfig = {
  packagerConfig: {
    // Harness creates real filesystem junctions into its installed dependency
    // closure and loads native addons. Keep the application outside ASAR.
    asar: false,
    executableName: 'SplitSquareHarness',
    icon: 'assets/icon',
    ...(windowsSign ? { windowsSign } : {}),
    ignore: [
      /^\/\.editorconfig$/,
      /^\/\.env(?:\.|$)/,
      /^\/\.gitattributes$/,
      /^\/src($|\/)/,
      /^\/tests($|\/)/,
      /^\/out($|\/)/,
      /^\/release-assets($|\/)/,
      /^\/artifacts($|\/)/,
      /^\/coverage($|\/)/,
      /^\/docs($|\/)/,
      /^\/scripts($|\/)/,
      /^\/\.github($|\/)/,
      /^\/\.git($|\/)/,
      /^\/\.idea($|\/)/,
      /^\/\.vscode($|\/)/,
      /^\/\.nvmrc$/,
      /^\/(?:BRANDING|CHANGELOG|CODE_OF_CONDUCT|CONTRIBUTING|SECURITY)\.md$/,
      /^\/design-qa\.md$/,
      /^\/forge\.config\.ts$/,
      /^\/pnpm-(?:lock|workspace)\.yaml$/,
      /^\/README(?:\.zh)?\.md$/,
      /^\/tsconfig(?:\.forge)?\.json$/,
      /^\/[^/]+\.(?:cer|key|p12|pem|pfx)$/i,
    ],
  },
  makers: [
    {
      name: '@electron-forge/maker-squirrel',
      config: {
        name: 'SplitSquareHarness',
        setupExe: 'SplitSquare-Harness-Setup.exe',
        setupIcon: 'assets/icon.ico',
        noMsi: true,
        ...(windowsSign ? { windowsSign } : {}),
      },
    },
  ],
}

export default config
