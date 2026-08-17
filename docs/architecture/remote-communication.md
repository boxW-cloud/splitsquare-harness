# Remote Communication Architecture

- **Status:** Proposed
- **Recorded:** 2026-08-15

## Purpose

This document records the direction for actual remote communication between trusted devices. The existing private-network HTTPS/WSS gateway is **LAN access**: it exposes the live desktop service to another device on the same network, but it does not provide Internet delivery, offline tasks, or a remote-control trust model.

Actual remote communication also requires device identity, end-to-end encryption, explicit capability grants, offline delivery, cancellation, and immediate revocation. The DeepSeek/provider API key and the Harness loopback endpoint remain on the host desktop.

## Product modes

| Mode | Connectivity | Semantics | Availability |
| --- | --- | --- | --- |
| **LAN access** | Direct HTTPS/WSS on the same private network, explicitly enabled | Interactive access to an online desktop | No cloud dependency; no offline delivery |
| **Remote task sync** | Both devices make outbound WSS connections to a relay on TCP 443 | Asynchronous tasks, events, results, and encrypted artifacts | Either endpoint may be offline |
| **Full remote session** | Outbound WSS/443 control plus an evaluated WebRTC or relayed data path | Continuous low-latency control | Both endpoints normally online |

Remote task sync does not grant an interactive terminal or full-session permissions. Promotion to a full session requires a separate request and explicit consent. LAN access remains disabled by default, binds only to a selected private interface, and uses pairing; a LAN is not automatically trusted.

## Topology

```text
Controller device ---- outbound WSS/443 ----\
                                             Relay/control plane
Host desktop -------- outbound WSS/443 -----/
                                             |
                                             +-- encrypted mailbox/artifact store
```

No mode requires port forwarding, UPnP, or unsolicited inbound Internet traffic. The relay authenticates devices, routes encrypted envelopes, tracks acknowledgements, and temporarily stores ciphertext. It never receives task, result, terminal, workspace, or attachment plaintext.

Connections use heartbeat, bounded exponential backoff with jitter, resumable cursors, and protocol-version negotiation. TLS remains mandatory around the end-to-end-encrypted payloads.

## Identity, encryption, and grants

- Each installation generates signing and key-agreement identities locally.
- Private keys use DPAPI, Keychain, libsecret, or an equivalent OS-protected store.
- A new device is approved by an existing trusted device using a QR code or short authentication string; account login alone does not silently establish trust.
- Grants are capability-scoped: task submission, task execution, artifacts, terminal, files, clipboard, screen, camera, microphone, and full-session control are independent.
- The relay stores public keys, grants, and revocation state, never private keys or content keys.

Use an audited protocol and library rather than custom cryptography. The initial candidate is Ed25519 identity signing, X25519/Noise key agreement, and ChaCha20-Poly1305 or AES-GCM. The final suite remains an open decision.

Payloads are encrypted only at endpoints. Signatures cover routing headers and ciphertext; task and session keys are separated and rotated; full sessions require forward secrecy; attachments are encrypted and chunked before upload; unique envelope IDs and per-stream sequence numbers prevent replay. Relay-visible headers contain only minimum routing, expiry, protocol, and size data.

A compromised relay can still observe presence, timing, routing relationships, and approximate sizes. Preventing all traffic analysis is not a goal.

## Offline delivery

Remote task sync is store-and-forward:

1. The sender persists an encrypted envelope in a local outbox.
2. The relay acknowledges durable receipt and retains ciphertext until delivery or expiry.
3. The target acknowledges device delivery and application acceptance separately.
4. Results and events use the same flow in reverse.

Transport is **at least once**. Stable command IDs, a target-side deduplication store, and idempotent handlers provide exactly-once effects where possible. Ordering is guaranteed only within one task/session stream.

Suggested states are `relay-accepted`, `device-delivered`, `application-accepted`, then `completed`, `failed`, `cancelled`, or `expired`. Queues have explicit TTLs and quotas, and expiry is visible to the user. Push notifications may wake a device but contain no plaintext content.

## Cancellation, termination, and revocation

- **Queued task cancellation:** remove an undelivered envelope or send a signed cancellation envelope.
- **Running task cancellation:** best effort; report `cancelled` or `too-late` and never imply external effects were undone.
- **Full-session termination:** a local kill switch ends control immediately even if the relay is unreachable.
- **Device revocation:** reject new connections, close active sockets, delete queued envelopes for that device, deny new grants, and rotate group/workspace keys where applicable.

Revocation is not retroactive. Already delivered and decrypted data cannot be recalled, so the product must not promise remote wipe.

Full sessions additionally require a persistent local indicator, short-lived grants, a local pause/terminate control, and separate opt-in for terminal, files, clipboard, screen, camera, and microphone. If screen/audio streaming is included, WebRTC with TURN/TLS 443 fallback or an SFU must be evaluated; WSS is not assumed to be efficient media transport.

## Cloudflare prototype

- **Workers:** bootstrap, WebSocket upgrade, authentication, rate limiting, and routing.
- **Durable Objects:** hibernatable sockets, per-device mailbox/presence ownership, and ordered coordination.
- **D1:** public device identities, grants, revocations, envelope indexes, and acknowledgement metadata.
- **R2:** opaque encrypted artifacts and oversized envelopes.
- **Queues:** retries, expiry, notifications, and cleanup—not the authoritative mailbox.
- **KV:** non-authoritative configuration/cache only, never revocation truth.
- **Access:** operator/admin surfaces only, not end-user device identity.
- **Tunnel:** optional connectivity to a self-hosted relay origin, not a substitute for E2EE, pairing, queues, or revocation.

The relay contract remains vendor-neutral so an owned or self-hosted implementation can replace Cloudflare. Data residency, WebSocket duration, Durable Object placement, storage/egress limits, and media cost must be validated before production commitment.

## Delivery phases and acceptance

1. **Protocol and threat model:** approve mode/capability boundaries, version schemas, publish cryptographic test vectors, and cover replay, lost device, relay compromise, account takeover, and endpoint compromise.
2. **LAN access:** work without Internet, stay off by default, never bind a public interface unintentionally, reject unpaired/revoked clients, and test origin, firewall, restart, and existing-connection expiry behavior.
3. **Remote task sync:** operate with only outbound WSS/443, survive either endpoint going offline, prevent duplicate execution under duplicate/reordered/interrupted delivery, keep relay storage/logs plaintext-free, and meet a defined online-revocation SLA.
4. **Full remote session:** require explicit consent, visible indication, scoped grants, a local kill switch, and independent capability tests; define latency, reconnect, bandwidth, and relay-fallback SLOs.
5. **Production hardening:** complete external security/cryptography review and test abuse controls, audit retention, recovery, relay failover, queue pressure, regional failure, and compatibility with at least one previous client.

## Open decisions

1. Audited handshake/library: Noise variant, MLS/group keys, or pairwise sessions.
2. First-device enrollment, recovery, and ownership transfer.
3. Pairwise versus workspace/group encryption for multi-device tasks.
4. Queue TTLs, quotas, attachment limits, and regional data residency.
5. Revocation SLA and organization-managed-device authority.
6. Whether “full session” includes complete desktop/audio or only Harness capabilities.
7. WebRTC/TURN/SFU provider and TCP-443-only fallback.
8. Cloudflare implementation versus an owned relay behind Tunnel.
9. Browser/mobile key storage, push constraints, metadata retention, and self-hosting policy.
