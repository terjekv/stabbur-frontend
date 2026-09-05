# Stabbur management console contributor guidance

This independently deployed repository owns the browser UI and its session backend. Keep the
control plane, worker runtime, and supported Rust client in their independent repositories.

## Security and architecture

- Authenticate against the configured Stabbur server through `stabbur_client`. The backend holds
  the upstream bearer token; browsers receive only an opaque, expiring HttpOnly session cookie.
  Never put passwords or bearer tokens in browser storage, rendered HTML, URLs, logs, or errors.
- Keep the upstream origin in operator-owned configuration. Browser input cannot select origins,
  headers, arbitrary API paths, or internal worker protocol operations. Every gateway request uses
  the reviewed operation allowlist and the supported client.
- Enforce exact Origin checks and session-bound CSRF tokens for mutations. Use Secure, HttpOnly,
  SameSite=Strict, host-only cookies in production. Insecure development is explicit and restricted
  to loopback origins. Send restrictive CSP, frame, referrer, and no-store policies.
- Stabbur remains the authority for permissions and credential expiry/revocation. Hidden buttons
  never replace server-side authorization. One-time issued credentials are downloads, not ordinary
  rendered/retained JSON. Confirm publication, withdrawal, cancellation, and credential mutations.
- Render server text as text; never inject untrusted markup. Bound request bodies, sessions, login
  attempts, responses, and event frames. Keep the application functional without third-party CDNs.

## Validated contracts

- Preserve validated facts as types across architectural boundaries. Convert raw API, cookie,
  configuration, and file representations once with a fallible constructor. Keep proof-type fields
  private and pass the resulting type to downstream operations instead of reconstructing the fact.
- Use newtypes for scalar invariants, enums for mutually exclusive/correlated states, and capability
  wrappers for validated, authenticated, or reviewed operations. Deserialization must not bypass
  validation. Database constraints, upstream transactions, concurrency revisions, and lease fencing
  remain necessary: proof types do not establish that mutable server state is still current.
- JavaScript uses explicit runtime decoders at response boundaries and keeps authenticated-session
  state encapsulated. UI values and disabled controls are never authorization proofs.

## Verification

Run `cargo fmt --all -- --check`, `cargo clippy --all-targets --locked -- -D warnings`,
`cargo test --locked`, `cargo build --release --locked`, `cargo deny check`, and `cargo audit`.
Run `node --test tests/*.test.mjs` and `python3 scripts/check-contract.py`.
Exercise login/logout, expiry, origin/CSRF rejection, role-denied actions, malicious text, and
pagination against the integration fixture before claiming release compatibility.
