/** Runtime contracts at browser response boundaries. No secrets are persisted. */
export function object(value) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Unexpected server response");
  return value;
}
export function decodeSession(value) {
  const result = object(value);
  const principal = object(result.principal);
  if (
    typeof principal.name !== "string" ||
    !Array.isArray(principal.roles) ||
    !principal.roles.every((role) => typeof role === "string") ||
    typeof result.csrf !== "string" ||
    !/^[A-Za-z0-9_-]{43}$/.test(result.csrf) ||
    !Number.isFinite(Date.parse(result.expires_at))
  )
    throw new Error("Unexpected session response");
  return Object.freeze({
    name: principal.name,
    roles: Object.freeze([...principal.roles]),
    csrf: result.csrf,
    expiresAt: result.expires_at,
  });
}
export function decodePage(value) {
  if (Array.isArray(value))
    return { items: value.map(object), nextCursor: null };
  const page = object(value);
  if (
    !Array.isArray(page.items) ||
    (page.next_cursor != null && typeof page.next_cursor !== "string")
  )
    throw new Error("Unexpected page response");
  return {
    items: page.items.map(object),
    nextCursor: page.next_cursor ?? null,
  };
}
export function label(value) {
  return String(value)
    .replaceAll("_", " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}
export function display(value) {
  if (value == null) return "—";
  if (Array.isArray(value)) return value.map(display).join(", ");
  if (typeof value === "object")
    return value.kind ? label(value.kind) : JSON.stringify(value);
  return String(value);
}
export function decodeLogs(items) {
  const decoder = new TextDecoder();
  return items
    .map((item) => {
      if (
        typeof item.message_base64 !== "string" ||
        item.message_base64.length > 1500000
      )
        throw new Error("Unexpected log response");
      return decoder.decode(
        Uint8Array.from(atob(item.message_base64), (char) =>
          char.charCodeAt(0),
        ),
      );
    })
    .join("");
}
export const groups = Object.freeze([
  {
    id: "software",
    title: "Software",
    description: "Published versions, channels and delivery readiness.",
    list: "list_software",
    create: "create_software",
    get: "get_software",
    key: "software",
    columns: [
      "name",
      "channels",
      "build_status",
      "last_success_at",
      "next_run_at",
    ],
    tags: ["software", "releases"],
  },
  {
    id: "targets",
    title: "Build targets",
    description: "Pinned recipes and recurring checks for your software.",
    list: "list_build_targets",
    create: "create_build_target",
    get: "get_build_target",
    key: "target",
    columns: [
      "name",
      "software_name",
      "schedule_description",
      "enabled",
      "next_run_at",
    ],
    tags: ["build-targets"],
  },
  {
    id: "runs",
    title: "Runs",
    description: "Follow builds from queue to verified, immutable artifacts.",
    list: "list_runs",
    create: "create_run",
    get: "get_run",
    key: "run",
    columns: ["run_name", "software_name", "state", "created_at", "duration"],
    tags: ["runs", "jobs"],
  },
  {
    id: "recipes",
    title: "Recipes",
    description: "Versioned build instructions with reviewed source pins.",
    list: "list_recipes",
    create: "create_recipe",
    get: "get_recipe",
    key: "recipe",
    columns: ["name", "revision", "created_at"],
    tags: ["recipes", "recipe-catalogs", "recipe-catalog-scans"],
  },
  {
    id: "workers",
    title: "Workers",
    description: "Capabilities, availability and graceful draining.",
    list: "list_workers",
    create: "provision_worker",
    get: "get_worker",
    key: "worker",
    columns: ["name", "enabled", "draining", "last_seen_at"],
    tags: ["workers"],
  },
  {
    id: "stores",
    title: "Storage",
    description: "Configured stores and immutable artifact locations.",
    list: "list_stores",
    get: "get_store",
    key: "store",
    columns: ["name", "role", "enabled"],
    tags: ["stores", "artifacts"],
  },
  {
    id: "access",
    title: "Access",
    description: "People, roles and revocable credentials.",
    list: "list_principals",
    create: "create_principal",
    get: "get_principal",
    key: "principal",
    columns: ["name", "kind", "roles", "enabled"],
    tags: ["auth"],
  },
  {
    id: "audit",
    title: "Audit history",
    description: "Append-only records of administrative decisions.",
    list: "list_audit_events",
    columns: ["occurred_at", "action", "resource_kind", "resource_id"],
    tags: ["audit"],
  },
]);

export function parseRoute(hash) {
  try {
    const [path, query = ""] = hash.replace(/^#\/?/, "").split("?");
    const parts = path.split("/").filter(Boolean).map(decodeURIComponent);
    const group = parts[0] || "software";
    if (
      !["catalog", "discovery", "exports", "delivery", "releases", ...groups.map((item) => item.id)].includes(
        group,
      ) ||
      parts.length > 2
    )
      throw new Error();
    if (["catalog", "discovery"].includes(group) && parts.length > 1) throw new Error();
    const params = new URLSearchParams(query);
    return Object.freeze({
      group,
      id: parts[1] || null,
      search: params.get("q") || "",
      state: params.get("state") || "",
    });
  } catch {
    return Object.freeze({
      group: "software",
      id: null,
      search: "",
      state: "",
    });
  }
}

export function routeHash(group, id) {
  return (
    "#/" + encodeURIComponent(group) + (id ? "/" + encodeURIComponent(id) : "")
  );
}

export function formatTime(value, now = Date.now()) {
  if (!value) return "—";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return String(value);
  const delta = (date.getTime() - now) / 1000;
  const units = [
    [86400, "day"],
    [3600, "hour"],
    [60, "minute"],
    [1, "second"],
  ];
  const [seconds, unit] =
    units.find(([size]) => Math.abs(delta) >= size) || units.at(-1);
  return new Intl.RelativeTimeFormat(undefined, { numeric: "auto" }).format(
    Math.round(delta / seconds),
    unit,
  );
}

export function duration(start, end, now = Date.now()) {
  if (!start || !Number.isFinite(Date.parse(start))) return "—";
  const seconds = Math.max(
    0,
    Math.round(((end ? Date.parse(end) : now) - Date.parse(start)) / 1000),
  );
  if (!Number.isFinite(seconds)) return "—";
  return seconds >= 3600
    ? Math.floor(seconds / 3600) +
        "h " +
        Math.floor((seconds % 3600) / 60) +
        "m"
    : seconds >= 60
      ? Math.floor(seconds / 60) + "m " + (seconds % 60) + "s"
      : seconds + "s";
}

export function scheduleDescription(schedule) {
  if (!schedule || schedule.kind === "manual") return "Manual";
  const seconds = schedule.every_seconds;
  return (
    "Every " +
    (seconds % 86400 === 0
      ? seconds / 86400 + " days"
      : seconds % 3600 === 0
        ? seconds / 3600 + " hours"
        : seconds % 60 === 0
          ? seconds / 60 + " minutes"
          : seconds + " seconds")
  );
}

export function decodeProblem(value, status) {
  const source = value && typeof value === "object" ? value : {};
  const clean = (text, limit) =>
    typeof text === "string" &&
    text.length <= limit &&
    !/[\u0000-\u001f\u007f]/.test(text);
  return Object.freeze({
    status,
    code: clean(source.code, 128) ? source.code : "request_failed",
    detail: clean(source.detail, 1024) ? source.detail : "",
    requestId: clean(source.request_id, 128) ? source.request_id : "",
    fields: Object.freeze(
      (Array.isArray(source.validation_errors) ? source.validation_errors : [])
        .filter(
          (item) => item && clean(item.field, 128) && clean(item.message, 512),
        )
        .slice(0, 32)
        .map((item) =>
          Object.freeze({ field: item.field, message: item.message }),
        ),
    ),
  });
}

export function decodeResource(value) {
  const item = object(value);
  if (typeof item.id !== "string" || !item.id || item.id.length > 256)
    throw new Error("Unexpected resource response");
  return item;
}

export function reviewedRevision(value) {
  if (!Number.isSafeInteger(value) || value < 0)
    throw new Error("Refresh this item to obtain a valid revision.");
  return value;
}

export function matchesFilter(item, search, state) {
  return (
    (!search ||
      Object.values(item).some((value) =>
        display(value).toLocaleLowerCase().includes(search.toLocaleLowerCase()),
      )) &&
    (!state ||
      String(item.state ?? item.build_status ?? item.enabled) === state)
  );
}

export function catalogActionTitle(action) {
  const resource =
    action.target?.name ||
    action.software?.name ||
    action.slug ||
    action.recipe ||
    action.name ||
    "";
  return label(action.action) + (resource ? ": " + resource : "");
}

// Catalog snapshots have a summary envelope rather than a top-level resource identity.
export function decodeRecipeSnapshot(value) {
  const snapshot = object(value);
  const summary = decodeResource(snapshot.summary);
  const manifest = object(snapshot.manifest);
  const text = value => typeof value === "string" && value.length > 0 && value.length <= 2048;
  const source = value => value && text(value.locator) && text(value.revision);
  if (manifest.schema_version !== 1 || !text(manifest.producer) || !source(manifest.source) ||
      !Array.isArray(manifest.recipes) || !Array.isArray(manifest.diagnostics) ||
      manifest.recipes.some(entry => !entry || !text(entry.identifier) || !text(entry.builder) ||
        !Array.isArray(entry.parents) || !entry.parents.every(text) ||
        (entry.guidance != null && (!text(entry.guidance.name) || !["fetch_artifact", "build_artifact", "install", "publish", "unknown"].includes(entry.guidance.purpose))) ||
        (entry.import_sources != null && (!Array.isArray(entry.import_sources) || !entry.import_sources.every(source)))) ||
      manifest.diagnostics.some(item => !item || !text(item.detail) || !text(item.code) ||
        (item.identifier != null && !text(item.identifier)) || !["info", "warning", "error"].includes(item.severity))) {
    throw new Error("Unexpected recipe inventory.");
  }
  return Object.freeze({ summary, manifest });
}
