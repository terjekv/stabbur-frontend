import {
  object,
  decodePage,
  decodeResource,
  decodeRecipeSnapshot,
  display,
  label,
  formatTime,
  duration,
  scheduleDescription,
  reviewedRevision,
  routeHash,
  catalogActionTitle,
} from "./model.js";

import { nextStep } from "./delivery.js";
import { starterSource, recipeChoice, filterRecipeChoices, runFailure, createRunLogBuffer } from "./recipe-model.js";

const terminal = new Set(["succeeded", "failed", "cancelled"]);

// Bound both collection sizes and parallel reads. No credentials or resource state are persisted.
async function mapBounded(items, read) {
  const result = new Array(items.length);
  let index = 0;
  await Promise.all(
    Array.from({ length: Math.min(4, items.length) }, async () => {
      while (index < items.length) {
        const position = index++;
        result[position] = await read(items[position]);
      }
    }),
  );
  return result;
}

export function createWorkflows(ui) {
  const {
    api,
    request,
    element: el,
    button,
    field,
    heading,
    table,
    renderValue,
    openDialog,
    showResult,
    operationForm,
    showError,
    clearErrors,
    announce,
    navigate,
    reviewCatalog,
    renderRoute,
  } = ui;
  async function list(id, parameters) {
    return decodePage(await api(id, { parameters })).items;
  }

  async function collection(id, parameters = {}, maximum = 1000) {
    const items = [];
    const seen = new Set();
    let cursor;
    do {
      const page = decodePage(
        await api(id, {
          parameters,
          query: { limit: "200", ...(cursor ? { cursor } : {}) },
        }),
      );
      items.push(...page.items);
      cursor = page.nextCursor;
      if (cursor && (seen.has(cursor) || items.length >= maximum)) {
        throw new Error(
          "This selection exceeds the console limit. Use the CLI to select the exact resource.",
        );
      }
      seen.add(cursor);
    } while (cursor);
    return items;
  }

  function link(text, group, id, className = "link") {
    const node = el("a", text, className);
    node.href = routeHash(group, id);
    return node;
  }

  function section(parent, title) {
    const panel = el("section", null, "panel resource-section");
    panel.append(el("h2", title));
    parent.append(panel);
    return panel;
  }

  function properties(parent, values) {
    const list = el("dl", null, "properties");
    for (const [key, value] of Object.entries(values)) {
      list.append(el("dt", key));
      const cell = el("dd");
      if (value instanceof Node) cell.append(value);
      else cell.textContent = display(value);
      list.append(cell);
    }
    parent.append(list);
  }

  function timestamp(value) {
    if (!value) return "—";
    const node = el("time", formatTime(value));
    node.dateTime = value;
    node.title = new Date(value).toLocaleString();
    node.append(
      el("span", " · " + new Date(value).toLocaleString(), "small muted"),
    );
    return node;
  }

  function advanced(parent, value) {
    const disclosure = el("details", null, "advanced");
    disclosure.append(el("summary", "Technical details"));
    renderValue(disclosure, value);
    parent.append(disclosure);
  }

  function variantEvidence(parent, variants) {
    if (!variants.length) {
      parent.append(el("p", "No artifact variants are available.", "muted"));
      return;
    }
    for (const value of variants) {
      const variant = decodeResource(value);
      if (!Array.isArray(variant.artifacts))
        throw new Error("Unexpected artifact variants.");
      const card = el("article", null, "variant-evidence");
      card.append(
        el(
          "h3",
          (variant.platform === "mac_os" ? "macOS" : label(variant.platform)) +
            " · " +
            label(variant.architecture),
        ),
      );
      properties(card, {
        "Minimum macOS": variant.minimum_macos || "No minimum specified",
        "Maximum macOS": variant.maximum_macos || "No upper limit",
        "Resolution priority": variant.resolution_priority,
      });
      for (const artifact of variant.artifacts) {
        if (
          typeof artifact.digest !== "string" ||
          !/^[a-f0-9]{64}$/.test(artifact.digest)
        )
          throw new Error("Unexpected artifact digest.");
        const details = el("details", null, "artifact-evidence");
        details.append(
          el(
            "summary",
            label(artifact.role) + " · " + artifact.digest.slice(0, 12) + "…",
          ),
        );
        renderValue(details, artifact);
        card.append(details);
      }
      const identity = el("details", null, "artifact-evidence");
      identity.append(
        el("summary", "Variant identifier"),
        el("p", variant.id, "small"),
      );
      card.append(identity);
      parent.append(card);
    }
  }

  function select(parent, title, choices, value = "") {
    const wrapper = el("label", title, "field");
    const input = el("select");
    input.setAttribute("aria-label", title);
    for (const [key, text] of choices) input.append(new Option(text, key));
    input.value = String(value);
    wrapper.append(input);
    parent.append(wrapper);
    return input;
  }

  function jsonField(parent, title, value = {}) {
    const wrapper = el("label", title, "field");
    const input = el("textarea");
    input.rows = 4;
    input.value = JSON.stringify(value, null, 2);
    input.dataset.field = "parameters";
    wrapper.append(input);
    parent.append(wrapper);
    return input;
  }

  function confirmation(form, text) {
    const wrapper = el("label", null, "confirm");
    const checkbox = el("input");
    checkbox.type = "checkbox";
    checkbox.required = true;
    wrapper.append(checkbox, document.createTextNode(" " + text));
    form.append(wrapper);
    return checkbox;
  }

  function submitForm(form, text, action) {
    const submit = el("button", text, "button primary");
    submit.type = "submit";
    form.append(submit);
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      clearErrors(form);
      submit.disabled = true;
      try {
        await action();
      } catch (error) {
        showError(error);
      } finally {
        submit.disabled = false;
      }
    });
    return submit;
  }

  async function enrich(group, items) {
    const names = new Map();
    const softwareName = (id) => {
      if (!names.has(id))
        names.set(
          id,
          api("get_software", { parameters: { software: id } })
            .then((value) => value.name)
            .catch(() => id),
        );
      return names.get(id);
    };
    return mapBounded(items, async (item) => {
      if (group === "software") {
        try {
          const status = object(
            await api("software_status", { parameters: { software: item.id } }),
          );
          return {
            ...item,
            channels:
              status.channels
                .map((channel) => channel.name + ": " + channel.version)
                .join(" · ") || "Not published",
            build_status: status.blocked_targets.length
              ? "Blocked"
              : status.latest_run?.state || "Not built",
            last_success_at: status.last_success_at,
            next_run_at: status.next_run_at,
          };
        } catch {
          return {
            ...item,
            channels: "Unavailable",
            build_status: "Unavailable",
          };
        }
      }
      if (group === "runs")
        return {
          ...item,
          run_name: item.id,
          software_name: await softwareName(item.software_id),
          duration: duration(item.created_at, item.completed_at),
        };
      if (group === "targets")
        return {
          ...item,
          software_name: await softwareName(item.software_id),
          schedule_description: scheduleDescription(item.schedule),
        };
      return item;
    });
  }

  async function pagedSection(
    parent,
    title,
    operation,
    parameters,
    columns,
    group,
    token,
  ) {
    const panel = section(parent, title);
    const contents = el("div");
    panel.append(contents);
    let cursor;
    const seen = new Set();
    async function load() {
      const page = decodePage(
        await api(operation, {
          parameters,
          query: { limit: "50", ...(cursor ? { cursor } : {}) },
        }),
      );
      if (!ui.current(token)) return;
      if (page.items.length)
        contents.append(
          table(await enrich(group, page.items), columns, (item) =>
            navigate(group, item.id),
          ),
        );
      else if (!cursor)
        contents.append(
          el("p", "No " + title.toLowerCase() + " yet.", "muted"),
        );
      cursor = page.nextCursor;
      panel.querySelector(".load-more")?.remove();
      if (cursor) {
        if (seen.has(cursor))
          throw new Error("The server repeated a pagination cursor.");
        seen.add(cursor);
        const more = button(
          "Load more",
          async () => {
            more.disabled = true;
            try {
              await load();
            } finally {
              more.disabled = false;
            }
          },
          "button secondary load-more",
        );
        panel.append(more);
      }
    }
    await load();
    return panel;
  }

  async function resource(group, id) {
    const token = ui.begin();
    const definitions = {
      software: ["get_software", "software"],
      targets: ["get_build_target", "target"],
      runs: ["get_run", "run"],
      releases: ["get_release", "release"],
    };
    const [operation, key] = definitions[group];
    heading("Loading…", "Reading current state.");
    const value = decodeResource(
      await api(operation, { parameters: { [key]: id } }),
    );
    if (!ui.current(token)) return;
    const name =
      value.name ||
      (group === "releases" ? "Release " + value.version : "Build run");
    const { main, head } = heading(
      name,
      group === "runs" ? "Progress, logs, verification and publication." : "",
    );
    const breadcrumb = el("div", null, "breadcrumbs");
    breadcrumb.append(
      link(
        group === "releases" ? "Software" : label(group),
        group === "releases" ? "software" : group,
      ),
    );
    main.prepend(breadcrumb);
    const actions = el("div", null, "actions");
    actions.append(button("Refresh", renderRoute, "button secondary"));
    head.append(actions);
    if (group === "software") await softwarePage(main, actions, value, token);
    if (group === "targets") await targetPage(main, actions, value, token);
    if (group === "runs") await runPage(main, actions, value, token);
    if (group === "releases") await releasePage(main, actions, value, token);
    if (ui.current(token)) {
      ui.operationActions(main, key, { [key]: value.id }, value);
      const title = main.querySelector("h1");
      title?.setAttribute("tabindex", "-1");
      title?.focus();
    }
  }

  async function softwarePage(main, actions, software, token) {
    actions.append(
      button("Edit software", () =>
        operationForm(
          "update_software",
          { software: software.id },
          software.revision,
          software,
        ),
      ),
    );
    actions.append(
      button(
        "Add build target",
        () => form("create_build_target", { software: software.id }),
        "button primary",
      ),
    );
    const status = object(
      await api("software_status", { parameters: { software: software.id } }),
    );
    if (!ui.current(token)) return;
    const overview = section(main, "Delivery and builds");
    properties(overview, {
      "Published channels": status.channels.length
        ? status.channels
            .map((channel) => channel.name + ": " + channel.version)
            .join(" · ")
        : "Not published",
      "Latest build": status.latest_run
        ? link(
            label(status.latest_run.state) +
              " · " +
              formatTime(status.latest_run.created_at),
            "runs",
            status.latest_run.id,
          )
        : "No builds yet",
      "Last successful check": timestamp(status.last_success_at),
      "Next scheduled check": timestamp(status.next_run_at),
      "Enabled targets": status.enabled_targets,
      "Active builds": status.outstanding_runs,
    });
    for (const blocked of status.blocked_targets) {
      const message = el(
        "p",
        "No recently observed worker matches: " +
          blocked.required_capabilities.join(", ") +
          ". ",
        "callout warning",
      );
      message.append(
        link("Review " + blocked.name, "targets", blocked.id),
        document.createTextNode(" · "),
        link("Check workers", "workers"),
      );
      overview.append(message);
    }
    const targets = await collection("list_build_targets");
    if (!ui.current(token)) return;
    const related = targets.filter(
      (target) => target.software_id === software.id,
    );
    let published=[];
    try { const delivery=await request("/api/delivery"); published=(delivery.entries||[]).filter(e=>e.spec.software===software.slug); } catch { /* Delivery has its own actionable status page. */ }
    if(!ui.current(token))return;
    const step=nextStep(status,related,published);
    const journey=section(main,"Next step");journey.append(el("h3",step.title),el("p",step.detail),link(step.title,step.group,step.id,"button primary"));
    journey.append(el("p","Choose app → Check readiness → Build → Test → Publish", "workflow-steps"),link("Munki delivery","delivery",software.id));
    overview.before(journey);
    const targetPanel = section(main, "Build targets");
    if (related.length)
      targetPanel.append(
        table(
          await enrich("targets", related),
          ["name", "schedule_description", "enabled", "next_run_at"],
          (item) => navigate("targets", item.id),
        ),
      );
    else
      targetPanel.append(
        el(
          "p",
          "Add a target to select an exact recipe revision and choose when to build.",
          "muted",
        ),
      );
    await pagedSection(
      main,
      "Releases",
      "list_releases",
      { software: software.id },
      ["version", "state", "availability", "created_at"],
      "releases",
      token,
    );
    if (ui.current(token)) advanced(main, software);
  }

  async function targetPage(main, actions, target, token) {
    actions.append(
      button("Edit build target", () =>
        form("update_build_target", { target: target.id }, target),
      ),
    );
    const trigger = button(
      "Build now",
      async () => {
        const body = openDialog("Build " + target.name);
        const review = el("form");
        body.append(review);
        properties(review, {
          "Recipe revision": target.recipe_revision_id,
          Schedule: scheduleDescription(target.schedule),
        });
        confirmation(
          review,
          "Run this exact recipe revision with the target’s current parameters.",
        );
        const key = crypto.randomUUID();
        submitForm(review, "Start build", async () => {
          const run = decodeResource(
            await api("trigger_build_target", {
              parameters: { target: target.id },
              idempotency_key: key,
            }),
          );
          await navigate("runs", run.id);
        });
      },
      "button primary",
    );
    if(!target.enabled && target.schedule.kind==="manual") {
      actions.append(button("Review and build",async()=>{
        const body=openDialog("Review and build"),review=el("form");body.append(review);
        const workers=await collection("list_workers");
        const ready=workers.filter(w=>w.enabled && !w.draining && Date.now()-Date.parse(w.last_seen_at)<180000);
        const recipes=await collection("list_recipes");
        const revisions=(await mapBounded(recipes,r=>collection("list_recipe_revisions",{recipe:r.id}))).flat();
        const recipe=revisions.find(r=>r.id===target.recipe_revision_id);
        if(!recipe)throw new Error("The selected recipe revision could not be loaded. Refresh before building.");
        const matches=ready.filter(w=>([...(recipe.required_capabilities||[]), ...(recipe.builder==="autopkg"?["builder.autopkg","os.macos"]:["builder.fake"])]).every(c=>w.advertised_capabilities?.includes(c)&&w.allowed_capabilities?.includes(c)));
        review.append(el("p","This enables a manual build target and runs it once. It does not create a recurring schedule."));
        properties(review,{"Ready workers":matches.map(w=>w.name).join(", ")||"No matching worker seen recently","Recipe revision":target.recipe_revision_id});
        const definition=recipe.definition||{};
        for(const source of definition.sources||[])properties(review,{Repository:source.url,Commit:source.commit});
        confirmation(review,"I reviewed these build instructions and want to run this manual build.");
        const start=submitForm(review,"Enable and start build",async()=>{
          await api("update_build_target",{parameters:{target:target.id},revision:target.revision,body:{enabled:true}});
          const run=decodeResource(await api("trigger_build_target",{parameters:{target:target.id},idempotency_key:crypto.randomUUID()}));
          await navigate("runs",run.id);
        });
        start.disabled=!matches.length;
        if(!matches.length)review.append(el("p","Connect a matching worker, then reopen this review.","callout warning"),link("Check workers","workers"));
      },"button primary"));
    }
    trigger.disabled = !target.enabled;
    if (!target.enabled)
      trigger.title = "Enable this target before triggering a build.";
    actions.append(trigger);
    const software = decodeResource(
      await api("get_software", {
        parameters: { software: target.software_id },
      }),
    );
    if (!ui.current(token)) return;
    const overview = section(main, "Build policy");
    properties(overview, {
      Software: link(software.name, "software", software.id),
      Schedule: scheduleDescription(target.schedule),
      Triggering: target.enabled ? "Enabled" : "Disabled",
      "Next check": timestamp(target.next_run_at),
      "Exact recipe revision": target.recipe_revision_id,
    });
    await pagedSection(
      main,
      "Runs",
      "list_build_target_runs",
      { target: target.id },
      ["run_name", "state", "created_at", "duration"],
      "runs",
      token,
    );
    if (ui.current(token)) advanced(main, target);
  }

  async function runPage(main, actions, run, token) {
    const software = decodeResource(
      await api("get_software", { parameters: { software: run.software_id } }),
    );
    if (!ui.current(token)) return;
    const overview = section(main, "Build progress");
    const state = el("span", label(run.state), "badge");
    state.dataset.state = run.state;
    const elapsed = el("span", duration(run.created_at, run.completed_at));
    properties(overview, {
      Software: link(software.name, "software", software.id),
      State: state,
      Created: timestamp(run.created_at),
      Duration: elapsed,
      "Run ID": run.id,
    });
    const refreshState = el(
      "p",
      terminal.has(run.state)
        ? "Build finished. Loading its durable logs."
        : "Following this build. Updates every 3 seconds.",
      "small muted",
    );
    overview.append(refreshState);
    if (!terminal.has(run.state))
      actions.append(
        button(
          "Cancel build",
          () => operationForm("cancel_run", { run: run.id }),
          "button danger",
        ),
      );
    const failurePanel = el("div"); failurePanel.setAttribute("role", "status"); main.append(failurePanel);
    const logBuffer = createRunLogBuffer();
    const logsPanel = section(main, "Build logs");
    logsPanel.append(el("p", "Output is grouped by attempt and stream so messages remain readable across updates.", "muted"));
    const logs = el("pre", "", "logs");
    logs.tabIndex = 0;
    logs.setAttribute("aria-label", "Build log output");
    logsPanel.append(logs);
    const liveStatus = el("p", "Loading logs…", "small muted");
    liveStatus.setAttribute("role", "status");
    logsPanel.append(liveStatus);
    let stopped = false;
    let updating = false;
    let timer;
    let lastSequence = null;
    let cursor;
    let pagesRead = 0;
    let terminalObserved = terminal.has(run.state);
    const seenCursors = new Set();
    const follow = button(
      "Pause updates",
      () => {
        stopped = !stopped;
        follow.textContent = stopped ? "Resume updates" : "Pause updates";
        if (stopped) clearTimeout(timer);
        else tick();
      },
      "button secondary",
    );
    logsPanel.append(follow);
    const results = section(main, "Result and verification");
    function result(value) {
      results.replaceChildren(el("h2", "Result and verification"));
      failurePanel.replaceChildren();
      const failure = runFailure(value);
      if (failure) {
        failurePanel.className = "callout error";
        failurePanel.append(el("h2", failure.title), el("p", failure.action), link("Review available recipes", "discovery"));
      } else failurePanel.className = "";
      if (value.result) {
        const build = value.result.build_result;
        properties(results, {
          "Publication decision": value.result.publication?.disposition
            ? label(value.result.publication.disposition)
            : "No release published",
          "Discovered version": build?.discovered_version || "—",
          "Recipe trust": failure?.trust || (build?.provenance
            ? build.provenance.recipe_trust_succeeded
              ? "Passed"
              : "Failed"
            : "Not available"),
        });
        if (Array.isArray(build?.verification_results))
          renderValue(results, build.verification_results);
        advanced(results, value.result);
      } else
        results.append(
          el(
            "p",
            terminal.has(value.state)
              ? "No result was published."
              : "The server will verify the build result before publication.",
            "muted",
          ),
        );
      const releaseId = value.result?.publication?.release_id;
      const links = el("div", null, "actions");
      if (typeof releaseId === "string")
        links.append(
          link(
            "Review resulting release",
            "releases",
            releaseId,
            "button primary",
          ),
        );
      links.append(
        link("All releases for " + software.name, "software", software.id),
      );
      results.append(links);
    }
    result(run);
    advanced(main, run);
    async function tick() {
      if (stopped || updating || !ui.current(token)) return;
      updating = true;
      try {
        const page = decodePage(
          await api("list_run_logs", {
            parameters: { run: run.id },
            query: { limit: "200", ...(cursor ? { cursor } : {}) },
          }),
        );
        if (!ui.current(token)) return;
        if (
          page.items.some(
            (item) => !Number.isSafeInteger(item.sequence) || item.sequence < 0,
          )
        )
          throw new Error("The server returned an invalid log sequence.");
        const fresh = page.items.filter(
          (item) => lastSequence === null || item.sequence > lastSequence,
        );
        if (fresh.length) {
          logs.textContent = logBuffer.append(fresh);
          lastSequence = fresh.at(-1).sequence;
          logs.scrollTop = logs.scrollHeight;
        }
        pagesRead++;
        const next = page.nextCursor;
        if (next && seenCursors.has(next))
          throw new Error(
            "The server repeated a log cursor. Refresh this build.",
          );
        if (next) seenCursors.add(next);
        // The public log API defines its exclusive sequence cursor as an opaque string.
        // Re-read the last page while live; sequence deduplication suppresses replay.
        if (next) cursor = next;
        const current = decodeResource(
          await api("get_run", { parameters: { run: run.id } }),
        );
        if (!ui.current(token)) return;
        state.textContent = label(current.state);
        state.dataset.state = current.state;
        elapsed.textContent = duration(
          current.created_at,
          current.completed_at,
        );
        result(current);
        refreshState.textContent = terminal.has(current.state)
          ? "Build finished · " +
            duration(current.created_at, current.completed_at)
          : "Following this build. Updates every 3 seconds.";
        liveStatus.textContent =
          "Logs updated " +
          new Date().toLocaleTimeString() +
          ". Showing up to the latest 200,000 characters.";
        if (next && pagesRead >= 50) {
          stopped = true;
          follow.textContent = "Load more logs";
          pagesRead = 0;
          liveStatus.textContent =
            "Loaded 50 log pages. Continue to read more.";
        } else if (next || !terminal.has(current.state) || !terminalObserved)
          timer = setTimeout(
            tick,
            next || terminal.has(current.state) ? 100 : 3000,
          );
        else {
          follow.disabled = true;
          follow.textContent = "Logs complete";
          if (lastSequence === null)
            liveStatus.textContent = "This build produced no log entries.";
        }
        terminalObserved = terminal.has(current.state);
      } catch (error) {
        if (!ui.current(token)) return;
        liveStatus.textContent =
          error.message + " Use Resume updates to reconnect.";
        stopped = true;
        follow.textContent = "Resume updates";
      } finally {
        updating = false;
      }
    }
    ui.cleanup(() => {
      stopped = true;
      clearTimeout(timer);
    });
    await tick();
  }

  async function releasePage(main, actions, release, token) {
    const [software, variants] = await Promise.all([
      api("get_software", { parameters: { software: release.software_id } }),
      list("list_release_variants", { release: release.id }),
    ]);
    if (!ui.current(token)) return;
    const available = release.availability?.kind === "available";
    const promote = button(
      "Promote release",
      () => promotion({ software: software.id }, release),
      "button primary",
    );
    promote.disabled = !available || release.state === "rejected";
    if (promote.disabled)
      promote.title = "This release is not eligible for publication.";
    actions.append(
      promote,
      button(
        "Withdraw release",
        () =>
          operationForm(
            "withdraw_release",
            { release: release.id },
            release.revision,
            release,
          ),
        "button danger",
      ),
    );
    const overview = section(main, "Release");
    properties(overview, {
      Software: link(software.name, "software", software.id),
      Version: release.version,
      "Stage reached": label(release.state),
      "Publication eligibility": display(release.availability),
      Created: timestamp(release.created_at),
    });
    const evidence = section(main, "Verified artifacts and compatibility");
    variantEvidence(evidence, variants);
    evidence.append(
      el(
        "p",
        "Review platform compatibility and the build evidence before publishing. Artifact downloads preserve the exact digest.",
        "muted",
      ),
    );
    evidence.append(link("Continue to Munki delivery","delivery",software.id,"button primary"));
    advanced(main, release);
  }

  async function recipePicker(parent, initialRevision) {
    const recipes = await collection("list_recipes");
    if (!parent.isConnected) return null;
    const recipe = select(parent, "Recipe *", [
      ["", "Choose a recipe"],
      ...recipes.map((item) => [item.id, item.name]),
    ]);
    recipe.required = true;
    const revision = select(
      parent,
      "Recipe revision *",
      initialRevision
        ? [[initialRevision, "Current pinned revision · " + initialRevision]]
        : [["", "Choose a recipe first"]],
      initialRevision || "",
    );
    revision.required = true;
    revision.dataset.field = "recipe_revision";
    // An existing exact revision remains selected until the operator deliberately chooses another.
    if (initialRevision) recipe.required = false;
    let generation = 0;
    recipe.addEventListener("change", async () => {
      const request = ++generation;
      revision.disabled = true;
      try {
        const values = recipe.value
          ? await list("list_recipe_revisions", { recipe: recipe.value })
          : [];
        if (request !== generation || !parent.isConnected) return;
        revision.replaceChildren(new Option("Choose an exact revision", ""));
        for (const item of values)
          revision.append(
            new Option(
              "Revision " +
                item.sequence +
                " · " +
                item.builder +
                " · " +
                item.id,
              item.id,
            ),
          );
      } catch (error) {
        showError(error);
      } finally {
        if (request === generation) revision.disabled = false;
      }
    });
    return revision;
  }

  async function form(operation, parameters = {}, initial = {}) {
    if (operation === "promote_channel") return promotion(parameters, initial);
    const updating = operation === "update_build_target";
    const isRun = operation === "create_run";
    const title = isRun
      ? "Start a build"
      : updating
        ? "Edit build target"
        : "Create build target";
    const body = openDialog(title);
    const form = el("form");
    body.append(form);
    let current = initial;
    if (updating)
      current = decodeResource(
        await api("get_build_target", {
          parameters: { target: parameters.target },
        }),
      );
    const software = await collection("list_software");
    if (!form.isConnected) return;
    const name = !isRun
      ? field(form, "Name *", "text", current.name || "")
      : null;
    if (name) {
      name.required = true;
      name.dataset.field = "name";
    }
    const softwareInput = select(
      form,
      "Software *",
      [
        ["", "Choose software"],
        ...software.map((item) => [
          item.id,
          item.name + " (" + item.slug + ")",
        ]),
      ],
      current.software_id || parameters.software || "",
    );
    softwareInput.required = true;
    softwareInput.disabled = updating;
    softwareInput.dataset.field = "software";
    const revisionInput = await recipePicker(form, current.recipe_revision_id);
    if (!revisionInput || !form.isConnected) return;
    let schedule, interval, unit, enabled;
    if (!isRun) {
      schedule = select(
        form,
        "Schedule *",
        [
          ["manual", "Manual"],
          ["interval", "Recurring"],
        ],
        current.schedule?.kind || "manual",
      );
      schedule.dataset.field = "schedule";
      const periodic = el("div", null, "interval-fields");
      form.append(periodic);
      const seconds = current.schedule?.every_seconds || 3600;
      const size =
        seconds % 86400 === 0
          ? 86400
          : seconds % 3600 === 0
            ? 3600
            : seconds % 60 === 0
              ? 60
              : 1;
      interval = field(periodic, "Every", "number", seconds / size);
      interval.min = "1";
      interval.step = "1";
      unit = select(
        periodic,
        "Unit",
        [
          ["1", "seconds"],
          ["60", "minutes"],
          ["3600", "hours"],
          ["86400", "days"],
        ],
        size,
      );
      function policy() {
        periodic.hidden = schedule.value === "manual";
        interval.required = !periodic.hidden;
      }
      schedule.addEventListener("change", policy);
      policy();
      enabled = select(
        form,
        "Triggering",
        [
          ["false", "Disabled"],
          ["true", "Enabled"],
        ],
        current.enabled ?? false,
      );
      form.append(
        el(
          "p",
          "New targets start disabled. Enabling a recurring target can queue work immediately. Changing its interval lets the server set the next check.",
          "callout",
        ),
      );
    }
    const advancedFields = el("details", null, "advanced");
    advancedFields.append(el("summary", "Build parameters (advanced)"));
    form.append(advancedFields);
    const params = jsonField(
      advancedFields,
      "Parameters (JSON)",
      current.parameters || {},
    );
    const review = el("p", null, "callout");
    form.append(review);
    function preview() {
      review.textContent = isRun
        ? "Build the selected exact recipe revision once."
        : (enabled.value === "true" ? "Enabled" : "Disabled") +
          " · " +
          (schedule.value === "manual"
            ? "Manual builds only"
            : "Every " +
              interval.value +
              " " +
              unit.selectedOptions[0].textContent);
    }
    form.addEventListener("change", preview);
    preview();
    confirmation(
      form,
      "I have reviewed the software, exact recipe revision and execution policy.",
    );
    const idempotencyKey = crypto.randomUUID();
    submitForm(form, isRun ? "Start build" : "Save build target", async () => {
      if (revisionInput.disabled)
        throw new Error("Wait for the recipe revisions to load.");
      const payload = {
        recipe_revision: revisionInput.value,
        parameters: object(JSON.parse(params.value)),
      };
      if (!updating) payload.software = softwareInput.value;
      if (!isRun) {
        payload.name = name.value;
        payload.enabled = enabled.value === "true";
        const seconds = Number(interval.value) * Number(unit.value);
        if (
          schedule.value === "interval" &&
          (!Number.isSafeInteger(seconds) || seconds < 60 || seconds > 31536000)
        )
          throw new Error("Use an interval from 60 seconds through 365 days.");
        payload.schedule =
          schedule.value === "manual"
            ? { kind: "manual" }
            : { kind: "interval", every_seconds: seconds };
      }
      const value = decodeResource(
        await api(operation, {
          parameters: updating ? { target: current.id } : {},
          body: payload,
          ...(updating ? { revision: reviewedRevision(current.revision) } : {}),
          ...(isRun ? { idempotency_key: idempotencyKey } : {}),
        }),
      );
      await navigate(isRun ? "runs" : "targets", value.id);
    });
  }

  async function promotion(parameters, selected = {}) {
    const body = openDialog("Promote release");
    const review = el("form");
    body.append(review);
    const software = decodeResource(
      await api("get_software", {
        parameters: { software: parameters.software || selected.software_id },
      }),
    );
    const [releases, channels] = await Promise.all([
      collection("list_releases", { software: software.id }),
      list("list_channels", { software: software.id }),
    ]);
    if (!review.isConnected) return;
    review.append(el("p", software.name, "eyebrow"));
    const eligible = releases.filter(
      (item) =>
        item.availability?.kind === "available" && item.state !== "rejected",
    );
    const release = select(
      review,
      "Release *",
      [
        ["", "Choose a release"],
        ...eligible.map((item) => [
          item.id,
          item.version + " · " + item.state + " · " + item.id,
        ]),
      ],
      selected.id || "",
    );
    release.required = true;
    release.dataset.field = "release_id";
    const channel = select(
      review,
      "Channel *",
      [
        ["testing", "Testing"],
        ["stable", "Stable"],
      ],
      parameters.channel || "testing",
    );
    const variant = select(review, "Variant", [
      ["", "Resolve by platform compatibility"],
    ]);
    const beforeAfter = el("p", null, "callout");
    review.append(beforeAfter);
    const evidence = el("div", null, "promotion-evidence");
    review.append(evidence);
    const reason = field(review, "Reason", "text");
    reason.dataset.field = "reason";
    const confirmed = confirmation(
      review,
      "I have reviewed this publication change and its artifacts.",
    );
    let generation = 0;
    let loadedRelease = "";
    let variants = [];
    function describe() {
      const before = channels.find((item) => item.name === channel.value);
      const previous = releases.find((item) => item.id === before?.release_id);
      const after = eligible.find((item) => item.id === release.value);
      beforeAfter.textContent =
        label(channel.value) +
        ": " +
        (previous?.version || (before ? before.release_id : "Not published")) +
        " → " +
        (after?.version || "Choose a release") +
        ". " +
        (before
          ? "Replaces the current channel selection."
          : "Creates this channel.");
      confirmed.checked = false;
    }
    async function loadEvidence() {
      const token = ++generation;
      loadedRelease = "";
      variant.disabled = true;
      evidence.replaceChildren();
      try {
        variants = release.value
          ? await list("list_release_variants", { release: release.value })
          : [];
        if (token !== generation || !review.isConnected) return;
        variant.replaceChildren(
          new Option("Resolve by platform compatibility", ""),
        );
        for (const item of variants)
          variant.append(
            new Option(
              item.platform + " / " + item.architecture + " · " + item.id,
              item.id,
            ),
          );
        variantEvidence(evidence, variants);
        loadedRelease = release.value;
      } catch (error) {
        showError(error);
      } finally {
        if (token === generation) variant.disabled = false;
      }
      describe();
    }
    release.addEventListener("change", loadEvidence);
    channel.addEventListener("change", describe);
    variant.addEventListener("change", describe);
    describe();
    submitForm(review, "Promote release", async () => {
      if (loadedRelease !== release.value || variant.disabled)
        throw new Error("Wait for the release evidence to load.");
      const before = channels.find((item) => item.name === channel.value);
      const payload = {
        release_id: release.value,
        ...(variant.value ? { pinned_variant_id: variant.value } : {}),
        ...(reason.value ? { reason: reason.value } : {}),
      };
      await api("promote_channel", {
        parameters: { software: software.id, channel: channel.value },
        revision: reviewedRevision(before?.revision ?? 0),
        body: payload,
      });
      await navigate("software", software.id);
    });
    if (release.value) await loadEvidence();
  }

  async function discovery() {
    const token = ui.begin();
    const { main } = heading("Add software", "Choose an installer, review its source, then test a build before scheduling or promotion.");
    main.append(el("p", "1. Choose software → 2. Review source and settings → 3. Build → 4. Inspect artifact → 5. Promote", "workflow-steps"));
    const sourcePanel = section(main, "Recipe sources");
    sourcePanel.append(el("p", "Use a worker’s existing AutoPkg inventory, or inspect a repository without running its recipes.", "muted"));
    const setup = el("details");
    setup.append(el("summary", "Connect an existing AutoPkg inventory"), el("p", "Start the worker with --discover-autopkg. It publishes its inventory every five minutes. Run it as the AutoPkg account, or select a worker-local --autopkg-prefs file. Discovery does not update repositories or run recipes.", "muted"));
    sourcePanel.append(setup);
    const repo = el("details");
    repo.append(el("summary", "Scan a recipe repository"));
    const repoForm = el("form");
    const url = field(repoForm, "Repository HTTPS URL", "url"); url.required = true;
    const revision = field(repoForm, "Pinned Git commit"); revision.required = true; revision.pattern = "[a-f0-9]{40}";
    const starter = button("Use reviewed starter recipes", () => {
      repo.open = true; url.value = starterSource.locator; revision.value = starterSource.revision;
    }, "button secondary");
    sourcePanel.append(starter);
    repoForm.append(el("p", "The starter source includes reviewed Firefox and Thunderbird package recipes and the VLC disk image recipe. Review the exact source below; scanning does not accept trust or build software.", "muted"));
    const scanStatus = el("div"); scanStatus.setAttribute("role", "status");
    let scanGeneration = 0;
    submitForm(repoForm, "Scan repository", async () => {
      const generation = ++scanGeneration;
      const scan = decodeResource(await api("create_recipe_catalog_scan", { idempotency_key: crypto.randomUUID(), body: { producer: "autopkg", source: { locator: url.value, revision: revision.value } } }));
      if (!ui.current(token) || generation !== scanGeneration) return;
      const status = el("p", "Scan queued. Waiting for an AutoPkg worker…", "callout");
      scanStatus.replaceChildren(status);
      let checks = 0;
      async function poll() {
        if (!ui.current(token) || generation !== scanGeneration) return;
        try {
          const result = decodeResource(await api("get_recipe_catalog_scan", { parameters: { scan: scan.id } }));
          if (!ui.current(token) || generation !== scanGeneration) return;
          if (result.snapshot_id) { await discovery(); return; }
          if (["failed", "cancelled"].includes(result.state)) {
            status.textContent = "Scan " + result.state + ". Review worker availability and repository access in Recipes → Recipe catalog scans."; return;
          }
          status.textContent = "Scan " + label(result.state).toLowerCase() + ". This page updates automatically.";
          if (++checks < 300) setTimeout(poll, 2000);
          else { status.textContent = "The scan is still pending. Automatic checks paused."; scanStatus.append(button("Check again", () => { checks = 0; poll(); })); }
        } catch (error) {
          if (!ui.current(token) || generation !== scanGeneration) return;
          status.textContent = "Could not check the scan. " + error.message;
          scanStatus.append(button("Retry scan status", poll));
        }
      }
      await poll();
    });
    repo.append(repoForm, scanStatus); sourcePanel.append(repo);
    const [allSnapshots, workers] = await Promise.all([collection("list_recipe_catalog_snapshots"), collection("list_workers")]);
    if (!ui.current(token)) return;
    const snapshots = allSnapshots.filter(item => item.producer === "autopkg");
    const names = new Map(workers.map(worker => [worker.id, worker.name || worker.id]));
    const capable = workers.filter(worker => worker.advertised_capabilities?.includes("builder.autopkg") && worker.allowed_capabilities?.includes("builder.autopkg"));
    const workerStatus = el("div", null, "worker-summary");
    if (!capable.length) workerStatus.append(el("p", "No AutoPkg-capable workers are registered. Connect a macOS worker before scanning or building.", "callout warning"));
    for (const worker of capable) workerStatus.append(el("p", `${worker.name || worker.id} · ${worker.enabled ? "Enabled" : "Disabled"} · Last seen ${worker.last_seen_at ? formatTime(worker.last_seen_at) : "never"}`, "small muted"));
    sourcePanel.append(workerStatus);
    snapshots.sort((a, b) => b.observed_at.localeCompare(a.observed_at));
    const latest = snapshots.filter((item, i, all) => all.findIndex(other => other.worker_id === item.worker_id && other.source.locator === item.source.locator) === i);
    if (!latest.length) {
      repo.open = true;
      sourcePanel.append(el("p", "No recipe inventory has been received. Use the reviewed starter recipes above, or connect an existing inventory.", "callout"));
      return;
    }
    const sourceLabel = el("label", "Available inventories", "field");
    const source = el("select"); source.setAttribute("aria-label", "Available inventories");
    sourceLabel.append(source); sourcePanel.append(sourceLabel);
    for (const item of latest) {
      const title = (item.source.locator.startsWith("stabbur-worker:") ? "Worker inventory" : item.source.locator) + " · " + names.get(item.worker_id) + " · " + formatTime(item.observed_at);
      const option = el("option", title); option.value = item.id; source.append(option);
    }
    const inventory = section(main, "Choose software and installer");
    let selectionGeneration = 0;
    async function load() {
      const selectedGeneration = ++selectionGeneration;
      const snapshotId = source.value;
      inventory.replaceChildren(el("h2", "Choose software and installer"), el("p", "Loading inventory…", "muted"));
      const snapshot = decodeRecipeSnapshot(await api("get_recipe_catalog_snapshot", { parameters: { snapshot: snapshotId } }));
      if (!ui.current(token) || selectedGeneration !== selectionGeneration) return;
      const manifest = snapshot.manifest;
      const options = manifest.recipes.map(entry => recipeChoice(entry, manifest));
      inventory.replaceChildren(el("h2", "Choose software and installer"));
      if (options.some(choice => !choice.entry.guidance)) inventory.append(el("p", "This inventory contains older entries without recipe guidance. Scan the source again with an updated worker before importing them.", "callout warning"));
      const search = field(inventory, "Search software or recipe", "search");
      const filters = el("div", null, "toolbar"); filters.setAttribute("aria-label", "Recipe filters");
      const entries = el("div");
      const selected = new Map();
      const form = el("form", null, "import-form");
      const choices = el("div", null, "import-names");
      form.append(el("h3", "Review selected installers"), el("p", "Each installer has separate output settings. Imported targets are manual and disabled; review and enable a target to run its first build.", "muted"), choices);
      const review = submitForm(form, "Review sources and import plan", async () => {
        if (!selected.size) throw new Error("Select at least one artifact recipe.");
        const selections = [...selected].map(([identifier, inputs]) => ({ identifier, slug: inputs.slug.value, name: inputs.name.value, architecture: inputs.architecture.value, minimum_macos: inputs.minimum.value || null, version_variable: inputs.version.value, artifact_variable: inputs.artifact.value, media_type: inputs.media.value }));
        if (new Set(selections.map(selection => selection.slug)).size !== selections.length) throw new Error("Choose one installer per software, or give each selected installer a unique software slug.");
        const desired = object(await request("/api/recipe-import", { snapshot: snapshotId, selections }));
        for(const selection of selections) {
          const preset=options.find(choice=>choice.entry.identifier===selection.identifier)?.preset;
          const software=desired.software.find(item=>item.slug===selection.slug);
          if(preset&&software)software.installation={install:{stabbur_munki:preset},detection:{}};
        }
        if (ui.current(token) && selectedGeneration === selectionGeneration) await reviewCatalog(desired);
      });
      review.disabled = true;
      inventory.append(filters, entries, form);
      let page = 0;
      let view = options.some(choice => choice.recommended) ? "recommended" : options.some(choice => choice.artifact) ? "artifacts" : "setup";
      const filterButtons = new Map();
      for (const [value, title] of [["recommended", "Recommended"], ["artifacts", "Artifact recipes"], ["setup", "Needs setup"], ["all", "All discovered"]]) {
        const control = button(title, () => { view = value; page = 0; render(); }, "button secondary");
        filterButtons.set(value, control); filters.append(control);
      }
      function addSelection(choice) {
        const row = el("fieldset", null, "import-names-row"); row.append(el("legend", choice.name + " — " + choice.title));
        const slug = field(row, "Software slug", "text", choice.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")); slug.required = true;
        const name = field(row, "Software name", "text", choice.name); name.required = true;
        const architectureLabel = el("label", "Installer architecture", "field");
        const architecture = el("select"); architecture.required = true; architecture.setAttribute("aria-label", "Installer architecture for " + choice.name);
        for (const [value, title] of [["", "Confirm the installer’s architecture"], ["aarch64", "Apple silicon (arm64)"], ["x86_64", "Intel (x86_64)"], ["universal", "Universal"]]) {
          const option = el("option", title); option.value = value; architecture.append(option);
        }
        architectureLabel.append(architecture); row.append(architectureLabel);
        row.append(el("p", "Choose the architecture contained in the installer. It may differ from the worker’s architecture.", "small muted"));
        const minimum = field(row, "Minimum macOS (optional)");
        const outputs = el("details"); outputs.open = !choice.outputs; outputs.append(el("summary", "Advanced output settings"));
        const version = field(outputs, "Version output variable", "text", choice.outputs?.version || ""); version.required = true;
        const artifact = field(outputs, "Installer output variable", "text", choice.outputs?.artifact || ""); artifact.required = true;
        const media = field(outputs, "Installer media type", "text", choice.outputs?.media || "application/octet-stream"); media.required = true;
        outputs.append(el("p", choice.outputs ? "Suggested for this exact source revision; a successful test build is still required." : "Confirm the recipe’s actual outputs. Downloads often use pathname; generated packages often use pkg_path. Version variables vary by recipe.", "muted"));
        for (const input of [version, artifact, media]) input.addEventListener("invalid", () => { outputs.open = true; });
        row.append(outputs); choices.append(row);
        selected.set(choice.entry.identifier, { row, slug, name, architecture, minimum, version, artifact, media });
      }
      function render() {
        entries.replaceChildren();
        for (const [key, control] of filterButtons) control.setAttribute("aria-pressed", String(view === key));
        const filtered = filterRecipeChoices(options, view, search.value);
        const count = el("p", filtered.length + (filtered.length === 1 ? " recipe · " : " recipes · ") + selected.size + " selected", "muted"); entries.append(count);
        if (!filtered.length) entries.append(el("p", view === "recommended" ? "No reviewed starter preset matches this snapshot. Browse Artifact recipes, or scan the reviewed starter source." : "No recipes match this filter.", "callout"));
        let previousName;
        for (const choice of filtered.slice(page * 50, (page + 1) * 50)) {
          if (choice.name !== previousName) { entries.append(el("h3", choice.name)); previousName = choice.name; }
          const entry = choice.entry;
          const card = el("article", null, "plan-change recipe-choice");
          const labelNode = el("label", null, "confirm");
          const check = el("input"); check.type = "checkbox"; check.setAttribute("aria-label", "Select " + entry.identifier); check.checked = selected.has(entry.identifier); check.disabled = !choice.selectable;
          labelNode.append(check, document.createTextNode(" " + choice.title)); card.append(labelNode, el("span", choice.status, "badge"), el("p", choice.reason, "muted"));
          for (const diagnostic of choice.diagnostics) card.append(el("p", diagnostic.detail, "callout " + (diagnostic.severity === "error" ? "error" : "warning")));
          const pins = el("details"); pins.append(el("summary", "Recipe, parents and exact sources"));
          properties(pins, { Recipe: entry.identifier, Parents: entry.parents.length ? entry.parents.join(", ") : "None" });
          for (const pin of entry.import_sources || []) properties(pins, { Repository: pin.locator, Commit: pin.revision });
          pins.append(el("p", "Purpose describes known processors in the parent chain. Review all source code; this classification is not execution verification.", "small muted")); card.append(pins);
          check.addEventListener("change", () => {
            if (check.checked) {
              if (selected.size >= 100) { check.checked = false; showError(new Error("Import at most 100 recipes at a time.")); return; }
              addSelection(choice);
            } else { selected.get(entry.identifier)?.row.remove(); selected.delete(entry.identifier); }
            review.disabled = !selected.size;
            count.textContent = filtered.length + (filtered.length === 1 ? " recipe · " : " recipes · ") + selected.size + " selected";
          }); entries.append(card);
        }
        const controls = el("div", null, "actions");
        const previous = button("Previous recipes", () => { page--; render(); }, "button secondary"); previous.disabled = page === 0;
        const next = button("Next recipes", () => { page++; render(); }, "button secondary"); next.disabled = (page + 1) * 50 >= filtered.length;
        controls.append(previous, next); entries.append(controls);
      }
      search.addEventListener("input", () => { page = 0; render(); }); render();
    }
    source.addEventListener("change", () => load().catch(showError));
    await load();
  }

  async function catalog(importedManifest = null) {
    const token = ui.begin();
    const { main } = heading(
      "Catalog plans",
      "Review software, pinned recipe revisions and recurring targets together.",
    );
    const panel = section(main, "Review desired state");
    panel.append(
      el(
        "p",
        importedManifest ? "Review the imported source pins, output selectors and disabled targets below. No recipe trust is accepted automatically." : "Choose a catalog JSON file. You will see each proposed change before applying it.",
        "muted",
      ),
    );
    const file = field(panel, "Catalog file", "file");
    file.accept = ".json,application/json";
    const results = el("div");
    let manifest, plan;
    let selectedGeneration = 0;
    const applyForm = el("form");
    const confirmed = confirmation(
      applyForm,
      "I have reviewed every change, source pin and target that will be enabled.",
    );
    const apply = submitForm(applyForm, "Apply reviewed plan", async () => {
      if (!manifest || !plan)
        throw new Error("Generate and review a fresh plan first.");
      const result = await request("/api/catalog/apply", { manifest, plan });
      plan = null;
      apply.disabled = true;
      applyForm.hidden = true;
      confirmed.checked = false;
      showResult("Catalog applied", result);
      for(const software of manifest.software)panel.append(link("Continue with "+software.name,"software",software.slug,"button primary"));
      panel.append(el("p", "Next: review and enable the imported manual target, build once, then inspect its artifact before promotion or scheduling.", "callout"), link("Review build targets", "targets", undefined, "button primary"));
    });
    apply.disabled = true;
    applyForm.hidden = true;
    file.addEventListener("change", () => {
      selectedGeneration++;
      manifest = null;
      plan = null;
      apply.disabled = true;
      applyForm.hidden = true;
      results.replaceChildren();
    });
    const generate = button(
      "Generate plan",
      async () => {
        const selection = ++selectedGeneration;
        const selected = file.files[0];
        if (!selected && !importedManifest) throw new Error("Choose a catalog file.");
        if (selected && selected.size > 1024 * 1024)
          throw new Error("Catalog files must be at most 1 MiB.");
        generate.disabled = true;
        apply.disabled = true;
        applyForm.hidden = true;
        plan = null;
        try {
          const desired = object(selected ? JSON.parse(await selected.text()) : importedManifest);
          const reviewed = object(
            await request("/api/catalog/plan", { manifest: desired }),
          );
          if (!Array.isArray(reviewed.actions))
            throw new Error("Unexpected catalog plan.");
          if (selection !== selectedGeneration || !ui.current(token)) return;
          manifest = desired;
          plan = reviewed;
          results.replaceChildren();
          results.append(
            el(
              "h2",
              reviewed.actions.length
                ? reviewed.actions.length +
                    (reviewed.actions.length === 1
                      ? " proposed change"
                      : " proposed changes")
                : "Everything is up to date",
            ),
          );
          for (const action of reviewed.actions) {
            const card = el("article", null, "plan-change");
            card.append(el("h3", catalogActionTitle(action)));
            if (action.target) {
              const target = action.target;
              card.append(
                el(
                  "p",
                  (target.enabled ? "Will be enabled" : "Will be disabled") +
                    " · " +
                    scheduleDescription(target.schedule),
                  target.enabled ? "callout warning" : "muted",
                ),
              );
              if (target.enabled && target.schedule.kind === "interval")
                card.append(
                  el("p", "This recurring target may queue work immediately."),
                );
            }
            if (action.action === "create_recipe_revision") {
              const existing = (await collection("list_recipes")).find(
                (item) => item.name === action.recipe,
              );
              const revisions = existing
                ? await list("list_recipe_revisions", { recipe: existing.id })
                : [];
              const before = revisions.find(
                (item) => item.sequence === action.expected_sequence - 1,
              );
              const pinDiff = el("div", null, "pin-diff");
              pinDiff.append(el("h4", "Source pins and build definition"));
              const definition = action.revision.definition;
              properties(pinDiff, {
                "Current recipe": before?.definition?.entrypoint || "No previous revision",
                "Proposed recipe": definition.entrypoint || action.revision.builder,
                "Version output": definition.output?.version_pointer?.replace("/stabbur/outputs/", "") || "See exact change",
              });
              for (const variant of definition.output?.variants || []) properties(pinDiff, {
                "Installer architecture": label(variant.architecture),
                "Minimum macOS": variant.minimum_macos || "Not specified",
                "Installer output": variant.artifacts.map(artifact => artifact.path_pointer.replace("/stabbur/outputs/", "")).join(", "),
              });
              for (const pin of definition.sources || []) properties(pinDiff, { Repository: pin.url, "Exact commit": pin.commit });
              card.append(pinDiff);
            }
            const details = el("details");
            details.append(el("summary", "Exact change"));
            renderValue(details, action);
            card.append(details);
            results.append(card);
          }
          if (selection !== selectedGeneration || !ui.current(token)) return;
          applyForm.hidden = !reviewed.actions.length;
          confirmed.checked = false;
          apply.disabled = !reviewed.actions.length;
        } finally {
          generate.disabled = false;
        }
      },
      "button secondary",
    );
    panel.append(generate, results, applyForm);
    if (importedManifest) generate.click();
  }

  return { enrich, resource, form, catalog, discovery };
}
