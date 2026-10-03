import { test } from "node:test";
import assert from "node:assert/strict";
import { recipeChoice, filterRecipeChoices, starterSource, runFailure, createRunLogBuffer } from "../public/recipe-model.js";
import { decodeRecipeSnapshot } from "../public/model.js";
const recipe = (purpose = "fetch_artifact") => ({ identifier: "com.github.autopkg.download.FirefoxSignedPkg", builder: "autopkg", parents: [], guidance: { name: "FirefoxSignedPkg", purpose }, import_sources: [{ ...starterSource }] });
const manifest = entries => ({ schema_version: 1, producer: "autopkg", source: starterSource, recipes: entries, diagnostics: [] });
test("starter suggestions require exact reviewed pins, metadata and resolved trust", () => {
  const entry = recipe(); const source = manifest([entry]);
  const choice = recipeChoice(entry, source);
  assert.equal(choice.name, "Firefox"); assert.equal(choice.recommended, true);
  assert.deepEqual(choice.outputs, { version: "version", artifact: "pathname", media: "application/octet-stream" });
  entry.import_sources[0].revision = "b".repeat(40);
  assert.equal(recipeChoice(entry, source).recommended, false);
  assert.equal(recipeChoice(entry, source).outputs, null);
  source.diagnostics.push({ code: "parent_trust_required", severity: "warning", identifier: entry.identifier });
  assert.equal(recipeChoice(entry, source).selectable, false);
  assert.equal(recipeChoice(entry, source).status, "Needs trust review");
});
test("artifact filter excludes install and publishing even under misleading download identifiers", () => {
  const entries = [recipe("install"), recipe("publish"), recipe("unknown"), recipe()];
  const choices = entries.map(entry => recipeChoice(entry, manifest(entries)));
  assert.equal(filterRecipeChoices(choices, "artifacts").length, 1);
  assert.equal(filterRecipeChoices(choices, "all").length, 4);
  assert.equal(filterRecipeChoices(choices, "recommended").length, 1);
  assert.ok(choices.slice(0, 3).every(choice => !choice.selectable));
  assert.equal(filterRecipeChoices(choices, "artifacts", "mozilla").length, 1);
});
test("legacy metadata remains readable but requires a refreshed inventory", () => {
  const entry = recipe(); delete entry.guidance;
  const snapshot = { summary: { id: "snapshot" }, manifest: manifest([entry]) };
  decodeRecipeSnapshot(snapshot);
  assert.equal(recipeChoice(entry, snapshot.manifest).status, "Refresh discovery");
  snapshot.manifest.recipes[0].guidance = { name: "App", purpose: "invented" };
  assert.throws(() => decodeRecipeSnapshot(snapshot), /inventory/);
});
test("trust failures are actionable without build_result or technical JSON", () => {
  const failure = runFailure({ state: "failed", result: { code: "autopkg_recipe_trust_failed" } });
  assert.match(failure.title, /before download/); assert.equal(failure.trust, "Failed");
  assert.match(failure.action, /reviewed override/);
  assert.equal(runFailure({ state: "succeeded" }), null);
});
const chunk = (sequence, stream, bytes, attempt_id = "attempt-1") => ({ sequence, stream, attempt_id, message_base64: Buffer.from(bytes).toString("base64") });
test("logs preserve per-stream partial lines and UTF-8 across pages and retries", () => {
  const buffer = createRunLogBuffer();
  buffer.append([chunk(0, "system", "AutoPkg attempt started"), chunk(1, "stderr", "WARNING: Did not l"), chunk(2, "stdout", "Recipe map not found\n")]);
  const output = buffer.append([chunk(3, "stderr", "oad any default preferences.\n"), chunk(4, "stdout", [0xe2, 0x82])]);
  assert.match(output, /WARNING: Did not load any default preferences/);
  assert.doesNotMatch(output, /lRecipe/);
  assert.match(buffer.append([chunk(5, "stdout", [0xac])]), /€/);
  assert.doesNotMatch(buffer.append([chunk(5, "stdout", "duplicate")]), /duplicate/);
  assert.match(buffer.append([chunk(6, "stdout", "new attempt", "attempt-2")]), /attempt-2 · stdout\nnew attempt/);
});
test("logs reject malformed streams and keep retained output bounded", () => {
  const buffer = createRunLogBuffer();
  assert.throws(() => buffer.append([chunk(0, "invalid", "bad")]));
  assert.ok(buffer.append([chunk(0, "stdout", "a".repeat(250000)), chunk(1, "stderr", "b".repeat(150000))]).length < 201000);
});
