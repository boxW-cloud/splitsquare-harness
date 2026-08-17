# Security policy

## Supported versions

Security fixes are provided for the latest release and the current `main` branch. This project depends on prerelease Harness software, so older builds may stop receiving fixes without a compatibility backport.

## Reporting a vulnerability

Do not open a public issue for a suspected vulnerability. Use the repository's **Security → Report a vulnerability** form (GitHub private vulnerability reporting). If that channel is not enabled yet, contact the repository owner privately and include:

- affected version and operating system;
- reproduction steps or a minimal proof of concept;
- expected impact and required user interaction;
- whether credentials, local files, terminal execution, or LAN sessions are exposed.

Please avoid accessing data that is not yours, persistence, denial of service, or public disclosure before a fix is available. Maintainers should acknowledge a complete report within seven days and coordinate a disclosure timeline after triage.

## Security boundary

- The local Harness process is trusted and loopback-only.
- A paired LAN user receives the same file, terminal, and Agent authority as the local user.
- The self-signed LAN certificate is safe only when the user verifies its SHA-256 fingerprint in the native desktop dialog.
- The LAN gateway must not be exposed through public Wi-Fi, port forwarding, UPnP, a public reverse proxy, or the Internet.
- The remote-communication design in `docs/architecture/remote-communication.md` is not implemented.

API provider incidents and vulnerabilities in the upstream Harness should also be reported to the corresponding provider or upstream project.
