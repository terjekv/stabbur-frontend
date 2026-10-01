// Reviewed suggestions are tied to immutable source contents, never just recipe names.
export const starterSource = Object.freeze({
  locator: "https://github.com/autopkg/recipes.git",
  revision: "6c092b47e9c6324aa48758832b2597a0f3ff932e",
});
const purposes = Object.freeze({
  fetch_artifact: "Download vendor artifact", build_artifact: "Build or copy package",
  install: "Install onto worker", publish: "Publish to another system", unknown: "Purpose needs review",
});
export function recipeChoice(entry, manifest) {
  const diagnostics = manifest.diagnostics.filter(d => !d.identifier || d.identifier === entry.identifier);
  const purpose = entry.guidance?.purpose || "unknown";
  const artifact = ["fetch_artifact", "build_artifact"].includes(purpose);
  const pins = entry.import_sources || [];
  const preset = entry.identifier === "com.github.autopkg.download.FirefoxSignedPkg" &&
    purpose === "fetch_artifact" && pins.length === 1 &&
    pins[0].locator === starterSource.locator && pins[0].revision === starterSource.revision;
  const name = preset ? "Firefox" : (entry.guidance?.name || entry.identifier.split(".").at(-1))
    .replace(/(?:SignedPkg|Pkg)$/, "").replace(/([a-z])([A-Z])/g, "$1 $2");
  let status = "Configure outputs", reason = "Review this source and configure its version, installer and architecture before testing.";
  let selectable = true;
  if (!entry.guidance) {
    status = "Refresh discovery"; reason = "This older snapshot has no recipe-purpose information. Scan it again with an updated worker."; selectable = false;
  } else if (!artifact) {
    status = purpose === "unknown" ? "Needs recipe review" : "Outside artifact workflow";
    reason = purpose === "install" ? "This recipe installs onto the worker. Choose a download or package recipe to obtain an installer."
      : purpose === "publish" ? "This recipe publishes to another system. Choose an artifact recipe and distribute the reviewed Stabbur release separately."
      : "Discovery could not identify an artifact workflow. Review its processors and use a manually reviewed catalog definition.";
    selectable = false;
  } else if (diagnostics.some(d => d.severity === "error") || !pins.length) {
    status = "Missing source or dependency"; reason = "Resolve the discovery errors and refresh the inventory before importing."; selectable = false;
  } else if (diagnostics.some(d => d.code === "parent_trust_required")) {
    status = "Needs trust review";
    reason = "Review the parent recipes, create a trusted override, commit and publish it, then discover that override. A source pin alone does not satisfy this recipe’s AutoPkg trust check.";
    selectable = false;
  } else if (preset) {
    status = "Ready to configure"; reason = "Suggested output mappings for this exact source. Confirm artifact architecture, then test the build.";
  }
  return Object.freeze({ entry, name, purpose, artifact, diagnostics, selectable, status, reason,
    recommended: preset && selectable, title: preset ? "Mozilla signed installer (.pkg)" : purposes[purpose],
    outputs: preset ? { version: "version", artifact: "pathname", media: "application/octet-stream" } : null });
}
export function filterRecipeChoices(choices, view, query = "") {
  const search = query.toLowerCase();
  return choices.filter(c => (view === "all" || (view === "recommended" ? c.recommended : view === "setup" ? !c.selectable || !c.outputs : c.artifact)) &&
    `${c.name} ${c.title} ${c.entry.identifier}`.toLowerCase().includes(search))
    .sort((a, b) => a.name.localeCompare(b.name) || Number(b.recommended) - Number(a.recommended) || a.entry.identifier.localeCompare(b.entry.identifier));
}
export function runFailure(run) {
  if (run.state !== "failed") return null;
  const failure = run.result;
  if (failure?.code === "autopkg_recipe_trust_failed") return {
    title: "Failed before download: recipe trust verification failed.",
    action: "Review the parent recipes and their trust information, then select a reviewed override from a fresh inventory. No installer was produced.",
    trust: "Failed",
  };
  return { title: typeof failure?.detail === "string" && failure.detail.length <= 2048 ? failure.detail : "The build failed.",
    action: "Inspect the output below, correct the recipe or build settings, then start a new build.", trust: "Not completed" };
}

// Each attempt and stream has its own incremental UTF-8 decoder, including across log pages.
// Retain at most 200,000 characters and 150 stream decoders.
export function createRunLogBuffer() {
  const streams = new Map();
  let lastSequence = -1;
  function append(items) {
    for (const item of items) {
      if (!Number.isSafeInteger(item.sequence) || item.sequence < 0 ||
          typeof item.attempt_id !== "string" || item.attempt_id.length > 128 ||
          !["system", "stdout", "stderr"].includes(item.stream) ||
          typeof item.message_base64 !== "string" || item.message_base64.length > 1500000)
        throw new Error("Unexpected log response");
      if (item.sequence <= lastSequence) continue;
      const bytes = Uint8Array.from(atob(item.message_base64), c => c.charCodeAt(0));
      const key = item.attempt_id + ":" + item.stream;
      if (!streams.has(key)) streams.set(key, { attempt: item.attempt_id, stream: item.stream, decoder: new TextDecoder(), text: "" });
      const entry = streams.get(key);
      entry.text = (entry.text + entry.decoder.decode(bytes, { stream: true })).slice(-200000);
      lastSequence = item.sequence;
      while (streams.size > 150) streams.delete(streams.keys().next().value);
      let excess = [...streams.values()].reduce((sum, value) => sum + value.text.length, 0) - 200000;
      for (const value of streams.values()) {
        if (excess <= 0) break;
        const trim = Math.min(excess, value.text.length); value.text = value.text.slice(trim); excess -= trim;
      }
    }
    return [...streams.values()].filter(entry => entry.text).map(entry =>
      `Attempt ${entry.attempt} · ${entry.stream}\n${entry.text}`).join("\n\n");
  }
  return Object.freeze({ append });
}
