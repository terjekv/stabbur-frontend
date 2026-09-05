# Stabbur management console

A separate, self-hosted management UI for Stabbur. Manage software, releases and channels, recipes,
build targets, runs and logs, workers, stores, principals, credentials, roles, and audit history.
Review and apply catalog schema 2 plans. Stabbur remains the authority for every permission.

The Rust session backend uses the supported `stabbur_client`. Bearer tokens stay in backend memory.
Browsers receive an opaque HttpOnly session cookie, and keep their CSRF token only in memory.
The UI has no third-party CDN, browser persistence, analytics, or build-time JavaScript dependencies.

## Run locally

Keep this repository beside `stabbur-client-rust` while these coordinated unreleased changes are
under review. Run a Stabbur server separately and bootstrap its administrator using the CLI.

```sh
STABBUR_FRONTEND_DEVELOPMENT=1 \
STABBUR_FRONTEND_ORIGIN=http://127.0.0.1:3000 \
STABBUR_FRONTEND_BIND=127.0.0.1:3000 \
STABBUR_SERVER_ORIGIN=http://127.0.0.1:8080 \
cargo run --locked
```

Open `http://127.0.0.1:3000` and sign in using the same username and password as the CLI.
Development HTTP requires an explicit flag and loopback origins/binding. Never expose this mode.

## Production

Build with `cargo build --release --locked`. Run the binary as a dedicated unprivileged user behind
a TLS reverse proxy; see [the service unit](deploy/stabbur-frontend.service) and
[the proxy example](deploy/Caddyfile). Configure all four environment variables in the unit for your
own deployment, with HTTPS origins and development disabled. Origins contain no path, query,
fragment, or credentials. The frontend origin must exactly match the address used in the browser.
Keep its listener private to the reverse proxy. Configure a separate HTTPS origin for Stabbur.
Use a trusted certificate accepted by the supported client.

Production cookies use the `__Host-` prefix, Secure, HttpOnly, SameSite=Strict, and no Domain.
Mutation requests require both the exact configured Origin and a session-bound CSRF token.
Login additionally requires a custom header and is limited per peer and username. Forwarded
addresses are deliberately ignored; a single reverse proxy shares the peer login budget of five
attempts per minute. Configure tighter network restrictions if this console has few operators.

Sessions expire at the earlier of the upstream login expiry or 30 minutes, with at most 1000 sessions
held in memory. Restarting the console signs everyone out. Deploy one replica, or use sticky routing;
there is no shared session database. Logout removes the browser's session and the console's token
reference. Stabbur's token expires on its original schedule; use principal session revocation for
account-wide revocation. Every operation reaches Stabbur, so server revocation and role changes apply.

The embedded gateway is generated from the pinned public OpenAPI contract. It cannot address an
arbitrary URL, path, header, bootstrap action, or internal worker protocol. One-time credentials are
attachment downloads. Protect these files and remove them from shared download folders.
Artifact downloads are streamed as attachments; use CLI downloads for final local SHA-256 verification
and binary uploads. Log views use bounded pages. The CLI also supports live reconnecting run watches.

## Reviewed operations

Open a resource to inspect its details and available actions. Forms retain optimistic revisions;
revision 0 means a channel binding must not already exist. Refresh after a stale-revision rejection.
Resource values are rendered as text, including logs and arbitrary metadata. Complex builder or
installation definitions use explicit JSON fields. All mutation forms require review confirmation.

Catalog plans are additive. Upload a manifest, generate a plan, inspect every action, then apply it.
The backend recomputes the plan and rejects drift before mutations. Individual mutations also keep
revision/sequence checks. A multi-action catalog sync is not one distributed transaction: after an
interruption, review a fresh plan to resume. Recurring targets may start work as soon as enabled.

## Verification and compatibility

Run the checks in [AGENTS.md](AGENTS.md). `scripts/check-contract.py` rejects drift between the pinned
OpenAPI document and the gateway; use `--update` only after reviewing contract changes.
The server's `scripts/check-workspace-integration.py` exercises all four sibling repositories with
a disposable local server and tests login, roles, origin/CSRF rejection, logout and revocation.

This console targets the coordinated unreleased 0.1 contract, currently 75 public operations. Local
integration is development evidence; released compatibility requires the same immutable-image
acceptance evidence as the supported client and CLI. No server image is published by these scripts.
