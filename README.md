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
Opening the development HTTP console through another loopback hostname redirects to the configured
console address before sign-in. Login and mutation requests still require that exact origin.

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

Software, build targets, runs and releases have shareable fragment URLs with working Back and
Refresh navigation. Software views show current channels, recent build status, next checks and
worker blockers. Search and status filters apply to loaded items; Load more extends the set.

Build forms use named software and recipe selectors with explicit immutable revision selection.
Schedules have manual and recurring controls; new console targets default to disabled. Enabling a
recurring target can queue work immediately. Build now opens the run's progress, replayed logs and
verification result. Log following uses bounded pages, sequence deduplication and pause/resume.

Promotion selects an exact release and platform variant, previews the old and new channel, and
retains the observed concurrency revision internally. Stale submissions are rejected; close the
form and refresh to review current state before retrying. Other edit forms preserve unchanged
values and show safe field diagnostics inside the active dialog. Resource values are always text,
including logs and arbitrary metadata. Advanced operations and JSON definitions remain available.

Catalog plans are additive. Upload a manifest, generate a plan, inspect the visible action summary,
source definitions and targets that will be enabled, then confirm and apply it.
The backend recomputes the plan and rejects drift before mutations. Individual mutations also keep
revision/sequence checks. A multi-action catalog sync is not one distributed transaction: after an
interruption, review a fresh plan to resume. Recurring targets may start work as soon as enabled.

## Verification and compatibility

Run the checks in [AGENTS.md](AGENTS.md). `scripts/check-contract.py` rejects drift between the pinned
OpenAPI document and the gateway; use `--update` only after reviewing contract changes.
The server's `scripts/check-workspace-integration.py` exercises all four sibling repositories with
a disposable local server and tests login, roles, origin/CSRF rejection, logout and revocation.

This console targets the coordinated 0.0.1 release contract, currently 75 public operations. Local
integration is development evidence; released compatibility requires the same immutable-image
acceptance evidence as the supported client and CLI. No server image is published by these scripts.

## Add software from recipes

Open **Add software from recipes**, choose a worker inventory, or use **Firefox starter source**
and scan the displayed immutable commit. Scan progress updates automatically. Workers publish
local inventory with `--discover-autopkg`; `--autopkg-prefs` optionally selects their local profile.

Recipes are grouped by software and observed processing intent. Recommended presets match an exact
reviewed source pin; they are suggested configuration, not successful-build evidence. Artifact recipes
exclude observed install/publish workflows. All discovered includes unsupported and legacy entries.
Purpose follows known processors across the parent chain, not identifier suffixes, and is not a sandbox.
Missing dependencies, missing parent trust and legacy metadata prevent guided import. Review and commit
trusted overrides, publish their exact source revisions, then refresh inventory; trust is never accepted
automatically. Manual catalog definitions remain available for separately reviewed workflows.

Each selected installer has its own architecture, minimum macOS and advanced output settings. No
architecture is inferred from the worker. FirefoxSignedPkg at the starter pin suggests `version` and
`pathname`. Other recipes require explicit reviewed output mappings. The imported target stays disabled
and manual. Review and enable it, build once, inspect the release's artifact and verification results,
then promote or configure scheduling. Failures show their cause above the logs. Logs retain separate
incremental UTF-8 streams per attempt so interleaved partial messages remain readable.

Coordinated local development requires the updated server and client beside this checkout. Old catalog
snapshots remain readable but need rescanning for guided import. This is local development evidence,
not an immutable-image release compatibility claim.
