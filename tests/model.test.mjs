import { test } from "node:test";
import assert from "node:assert/strict";
import { decodeSession, decodePage, display } from "../public/model.js";
import {
  parseRoute,
  routeHash,
  formatTime,
  duration,
  scheduleDescription,
  decodeProblem,
  matchesFilter,
  reviewedRevision,
} from "../public/model.js";
test("session decoder accepts only complete bounded session facts", () => {
  const input = {
    principal: { name: "admin", roles: ["admin"] },
    csrf: "A".repeat(43),
    expires_at: "2026-09-01T12:00:00Z",
  };
  const session = decodeSession(input);
  assert.equal(session.name, "admin");
  assert.ok(Object.isFrozen(session));
  for (const bad of [
    { ...input, csrf: "bad" },
    { ...input, expires_at: "never" },
    { ...input, principal: { name: "admin", roles: "admin" } },
  ])
    assert.throws(() => decodeSession(bad));
});
test("resource routes preserve exact opaque identities and safely reject malformed routes", () => {
  const id = "name with / and ?";
  assert.equal(parseRoute(routeHash("software", id)).id, id);
  assert.equal(
    parseRoute("#/runs/exact?q=Failed&state=failed").state,
    "failed",
  );
  assert.equal(parseRoute("#/catalog").group, "catalog");
  for (const invalid of ["#/unknown", "#/runs/%XX", "#/catalog/extra"])
    assert.equal(parseRoute(invalid).group, "software");
});
test("readable times never order or interpret release versions", () => {
  const now = Date.parse("2026-01-01T12:00:00Z");
  assert.match(formatTime("2026-01-01T11:58:00Z", now), /2 minutes ago/);
  assert.equal(duration("2026-01-01T11:58:00Z", null, now), "2m 0s");
  assert.equal(
    scheduleDescription({ kind: "interval", every_seconds: 3600 }),
    "Every 1 hours",
  );
  assert.equal(display("2026.09b-custom"), "2026.09b-custom");
});
test("problem diagnostics reject malformed and oversized fields", () => {
  const problem = decodeProblem(
    {
      code: "validation_failed",
      detail: "Invalid slug.",
      validation_errors: [
        { field: "slug", message: "Use lowercase letters." },
        { field: "bad\nfield", message: "invalid" },
        { field: "name", message: "x".repeat(513) },
      ],
    },
    400,
  );
  assert.equal(problem.fields.length, 1);
  assert.equal(problem.fields[0].field, "slug");
  assert.ok(Object.isFrozen(problem));
  assert.equal(decodeProblem({ detail: "secret\ncontrol" }, 500).detail, "");
});
test("filters distinguish false from absence and revisions retain zero only when explicit", () => {
  assert.equal(
    matchesFilter({ name: "Firefox", enabled: false }, "fire", "false"),
    true,
  );
  assert.equal(
    matchesFilter({ name: "Firefox", enabled: true }, "fire", "false"),
    false,
  );
  assert.equal(reviewedRevision(0), 0);
  for (const value of [-1, NaN, Number.MAX_SAFE_INTEGER + 1, "2", null])
    assert.throws(() => reviewedRevision(value));
});
test("pages preserve opaque cursors and reject malformed envelopes", () => {
  assert.deepEqual(
    decodePage({ items: [{ name: "a" }], next_cursor: "opaque" }),
    { items: [{ name: "a" }], nextCursor: "opaque" },
  );
  assert.throws(() => decodePage({ items: [], next_cursor: 8 }));
  assert.throws(() => decodePage({ items: [null] }));
});
test("display keeps malicious text literal for textContent rendering", () => {
  assert.equal(
    display("<img src=x onerror=alert(1)>"),
    "<img src=x onerror=alert(1)>",
  );
});
