# Security

Report vulnerabilities privately to the project maintainers. Do not include passwords, bearer tokens,
session cookies, one-time credentials, recipe secrets, or backend paths in reports or logs.

The trust boundaries are browser → console session backend → fixed Stabbur origin → worker/store.
The browser is untrusted. Only private constructors establish configured origins, canonical session
identities, unexpired session access, and reviewed operation/precondition state. Stabbur applies the
final role, revision, idempotency and publication policy on each call.

The backend disables upstream redirects through the supported client. Browser-supplied operation IDs
resolve only through the committed allowlist; path values are opaque segments and dot traversal is
rejected. No CORS is enabled. JSON requests are bounded to 2 MiB, upstream JSON responses to 8 MiB,
login credentials to bounded fields, sessions to 1000 entries and 30 minutes, and login-rate keys to
2048 entries. Streaming download failures terminate the stream instead of producing a success claim.

The CSP forbids inline scripts, external scripts, frames, plugins and form submissions to other origins.
All responses carry no-store, nosniff, no-referrer and frame-denial headers. Dynamic UI content uses
textContent and DOM construction. There are no HTML injection sinks or browser-storage credentials.
TLS and HSTS belong to the production reverse proxy. Development HTTP is explicit and loopback-only.

Checks cover origin validation, cookie attributes, session expiry, CSRF binding, gateway exclusions,
revision semantics, unauthenticated access, malicious text, pagination and upstream revocation.
Keep all dependencies within the advisory/license policy; do not add advisory exceptions.
