# SplitSquare Harness

[中文说明](README.zh.md)

> SplitSquare Harness is an independently maintained third-party open-source project. It is not affiliated with, authorized, endorsed, or sponsored by DeepSeek. “DeepSeek” identifies interoperability and upstream provenance only. The application uses an original black-and-white SplitSquare identity, not the DeepSeek name or logo.

An installable Electron shell around the official `@deepseek-ai/dsh` Web application. It starts Harness on an OS-assigned loopback port, verifies the official readiness signal and injected client manifest, then loads the complete GUI in a hardened desktop window.

## Full-capability build

- Official `@deepseek-ai/dsh` `0.1.0-rc.6`, pinned by the lockfile. Harness continues to own models, credentials, sessions, plugins, and agent tools.
- Electron 43 with Node integration disabled and context isolation, renderer sandboxing, and web security enabled.
- Local support for file selection/downloads, clipboard, notifications, camera/microphone, display capture, fullscreen, geolocation, MIDI, WebHID, Web Serial, WebUSB, and Web Bluetooth.
- Sensitive capabilities are limited to the exact per-run `127.0.0.1:<port>` origin and require a native confirmation or device picker. Unknown permissions fail closed; grants are memory-only and do not survive a backend origin change.
- Managed backend readiness, failure reporting, graceful disposal, and bounded forced termination.
- Native menus for workspace selection, backend restart, LAN interface selection, remote access, and pairing rotation.

API keys are never copied into the package. Harness retains its normal `DSH_HOME`, usually `%USERPROFILE%\.dsh`.

## Authenticated LAN access

Remote access never binds Harness itself to `0.0.0.0`. The official service remains on a random `127.0.0.1` port while Electron provides a fixed-target HTTPS/WSS gateway:

```text
LAN browser -- HTTPS/WSS --> pairing/origin gateway --> 127.0.0.1:<random DSH port>
```

The gateway:

- Binds one selected private IPv4 interface and can never proxy to a client-selected target.
- Uses a 256-bit, one-use, five-minute pairing code with five attempts per source IP per five minutes.
- Exchanges pairing for a 12-hour maximum `Secure`, `HttpOnly`, `SameSite=Strict` cookie.
- Validates exact Host and Origin values, including WebSocket Origin, while stripping forged forwarding headers and its own cookie upstream.
- Preserves streaming HTTP, SSE, downloads, and bidirectional WebSocket frames.
- Revokes sessions and closes old connections whenever Harness exits/restarts, the interface changes, the gateway is disabled, or the app quits.
- Keeps TLS private keys, pairing challenges, and sessions in memory only.

Use the Remote Access menu to select an interface and enable the gateway. The desktop shows the URL, a fresh pairing code, and the TLS SHA-256 fingerprint. Open the URL from a LAN device, verify the fingerprint, and enter the code. Generate a new code from the menu for another device.

The per-run certificate is self-signed, so a browser reports it as untrusted on first access. Continue only when its fingerprint exactly matches the native desktop dialog. A self-signed certificate cannot protect a user who ignores a mismatched fingerprint. If Windows Firewall asks, allow private networks only.

An authenticated remote user receives the same file, terminal, and Agent authority as the local Harness user. Do not expose this gateway through public Wi-Fi, port forwarding, UPnP, or the public Internet.

Fresh installations keep remote access disabled. Desktop settings store only the workspace, enabled state, bind IP, and port; they never contain pairing codes, cookies, or TLS keys.

## Development and packaging

Requirements: Node 24, pnpm 11, and Git.

```powershell
pnpm install
pnpm test
$env:DSH_DESKTOP_WORKSPACE='C:\path\to\workspace'
pnpm start
```

The suite covers capability origin bypasses, settings migration, pairing throttling, TLS SANs, anonymous rejection, Host/Origin rewriting, SSE first-chunk timing, bidirectional WebSockets, and an end-to-end real DSH boot through the gateway.

Build an unpacked app or Windows Squirrel installer:

```powershell
pnpm package
pnpm make
```

Public releases are built from protected `v*` tags. The release workflow checks the package version, runs the complete suite, produces SHA-256 checksums, and creates a GitHub build-provenance attestation. Authenticode signing is supported through repository secrets; see [the release guide](docs/releasing.md).

Default Windows x64 artifacts:

- Unpacked executable: `out/SplitSquare Harness-win32-x64/SplitSquareHarness.exe`
- Installer: `out/make/squirrel.windows/x64/SplitSquare-Harness-Setup.exe`

## Architecture boundary

This is a standalone compatibility shell consuming the public `dsh web` CLI, not a new package in DeepSeek's npm release family. Upstream documents a future first-party Electron IPC carrier; moving to that zero-listener carrier is a separate upstream product change. This build treats the loopback Web service as its trusted upstream and adds the authenticated LAN boundary outside it.

- [Remote communication architecture proposal](docs/architecture/remote-communication.md)

The current gateway is LAN-only. Internet relay, offline delivery, and cross-network task synchronization are architecture proposals, not shipped capabilities.

## Open-source project

- [Source repository](https://github.com/boxW-cloud/splitsquare-harness)
- [Contributing](CONTRIBUTING.md)
- [Security policy](SECURITY.md)
- [Branding and trademark boundary](BRANDING.md)
- [Third-party notices](THIRD_PARTY_NOTICES.md)
- [Release process](docs/releasing.md)

DeepSeek Harness remains a Developer Preview. Do not run different prerelease versions concurrently against one `DSH_HOME`.
