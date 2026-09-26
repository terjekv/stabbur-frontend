import { test } from "node:test";
import assert from "node:assert/strict";
import { decodeRecipeSnapshot, parseRoute } from "../public/model.js";

test("recipe snapshots decode their summary envelope and optional legacy source closures", () => {
  const fixture = { summary: { id: "snapshot" }, manifest: { schema_version: 1, producer: "autopkg", source: { locator: "worker", revision: "opaque" }, recipes: [{ identifier: "example.App", builder: "autopkg", parents: [] }], diagnostics: [] } };
  assert.equal(decodeRecipeSnapshot(fixture).summary.id, "snapshot");
  fixture.manifest.recipes[0].import_sources = [{ locator: "https://example.test/repo", revision: "exact" }];
  assert.equal(decodeRecipeSnapshot(fixture).manifest.recipes.length, 1);
  fixture.manifest.recipes[0].import_sources = "unexpected";
  assert.throws(() => decodeRecipeSnapshot(fixture), /inventory/);
  assert.equal(parseRoute("#/discovery").group, "discovery");
  assert.equal(parseRoute("#/discovery/invalid").group, "software");
});
