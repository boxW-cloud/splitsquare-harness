# Contributing

Thank you for improving this independent desktop shell.

## Development setup

Use Windows, Node `24.11.1`, pnpm `11.7.0`, and Git. The lockfile and package-manager version are part of the reproducible build boundary.

```powershell
corepack enable
corepack prepare pnpm@11.7.0 --activate
pnpm install --frozen-lockfile
pnpm run ci
```

No API key is required for unit or integration tests. Never add credentials, local Harness settings, signing certificates, screenshots containing private session data, or files from `%USERPROFILE%\.dsh` to the repository.

## Pull requests

1. Open an issue first for changes to the security boundary, remote access protocol, credential handling, packaging, or public API.
2. Keep each pull request focused and include tests for behavior changes.
3. Run `pnpm run ci` locally. Windows packaging changes should also pass `pnpm package`.
4. Update the English and Chinese READMEs when user-visible behavior changes.
5. Explain security implications, migration behavior, and manual verification in the pull request.

By contributing, you agree that your contribution is licensed under the repository's MIT License. Do not contribute third-party code, artwork, names, or marks unless redistribution rights are documented.

## Architecture constraints

- The renderer remains sandboxed with Node integration disabled.
- Harness listens only on an OS-assigned `127.0.0.1` port.
- LAN access goes through the authenticated HTTPS/WSS gateway and never turns Harness into an open proxy.
- Unknown Electron permissions fail closed.
- Secrets remain in Harness's credential store or protected CI secrets, never in source files.
