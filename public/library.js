import { object, decodePage, routeHash, formatTime, label } from "./model.js";

export const libraryViews = Object.freeze([
  ["all", "All applications"], ["attention", "Needs attention"],
  ["review", "Awaiting review"], ["failed", "Failing checks"],
  ["blocked", "No compatible worker"], ["not_built", "Not built"],
]);
export function decodeLibrary(value) {
  const page = decodePage(value);
  return { ...page, items: page.items.map(item => {
    const row = object(item);
    for (const key of ["id", "slug", "name"]) if (typeof row[key] !== "string") throw new Error("Unexpected library response");
    for (const key of ["outstanding_runs", "blocked_targets", "review_count"]) if (!Number.isSafeInteger(row[key]) || row[key] < 0) throw new Error("Unexpected library counts");
    if (!Array.isArray(row.channels) || !row.channels.every(c => typeof c.name === "string" && typeof c.version === "string")) throw new Error("Unexpected library channels");
    if (row.latest_run_state !== null && !["queued", "running", "failed", "succeeded", "cancelled"].includes(row.latest_run_state)) throw new Error("Unexpected build state");
    for (const key of ["latest_run_id", "review_release_id"]) if (row[key] !== null && typeof row[key] !== "string") throw new Error("Unexpected library identity");
    if ((row.review_count > 0) !== (row.review_release_id !== null)) throw new Error("Unexpected review evidence");
    return row;
  }) };
}
export function decodeCapabilityQueues(value) {
  const status = object(value), groups = status.capability_queues ?? [];
  if (!Array.isArray(groups) || groups.length > 200 || (status.capability_queues_truncated !== undefined && typeof status.capability_queues_truncated !== "boolean")) throw new Error("Unexpected queue response");
  for (const value of groups) {
    const group = object(value);
    if (!Array.isArray(group.required_capabilities) || !group.required_capabilities.every(c => typeof c === "string")) throw new Error("Unexpected queue requirements");
    for (const key of ["queued_jobs", "matching_workers", "workers_with_active_leases"]) if (!Number.isSafeInteger(group[key]) || group[key] < 0) throw new Error("Unexpected queue counts");
    if (group.workers_with_active_leases > group.matching_workers || typeof group.oldest_queued_at !== "string" || !Number.isFinite(Date.parse(group.oldest_queued_at))) throw new Error("Unexpected queue observations");
  }
  return { groups, truncated: status.capability_queues_truncated ?? false };
}
export function attentionReasons(row) {
  const reasons = [];
  if (row.blocked_targets) reasons.push(`${row.blocked_targets} ${row.blocked_targets === 1 ? "target needs" : "targets need"} a compatible worker`);
  if (row.latest_run_state === "failed" && !row.outstanding_runs) reasons.push("Latest check failed");
  if (row.review_count) reasons.push(`${row.review_count} ${row.review_count === 1 ? "release awaits" : "releases await"} review`);
  return reasons;
}
export function createSelection(limit = 100) {
  const selected = new Map();
  return Object.freeze({
    has: id => selected.has(id),
    values: () => [...selected.values()],
    clear: () => selected.clear(),
    set(row, checked) {
      if (!checked) { selected.delete(row.id); return; }
      if (!selected.has(row.id) && selected.size >= limit) throw new Error(`Select at most ${limit} applications per export.`);
      selected.set(row.id, row);
    },
  });
}
export function libraryParameters(hash, attention = false) {
  const values = new URLSearchParams(hash.split("?")[1] || "");
  const view = values.get("view") || (attention ? "attention" : "all");
  return { q: values.get("q") || "", view: libraryViews.some(([key]) => key === view) ? view : "all", sort: values.get("sort") === "newest" ? "newest" : "name" };
}

export function createLibrary(ui) {
  const { element: el, button, field, api, heading, navigate, showError } = ui;
  async function page(attention = false) {
    const token = ui.begin(), query = libraryParameters(location.hash, attention);
    const {main, head} = heading(attention ? "Needs attention" : "Library", attention
      ? "Current blockers and releases awaiting review. Open an application to inspect its evidence and next action."
      : "Maintain your applications, review their builds, and choose what to deliver.");
    const actions = el("div", null, "actions");
    actions.append(button("Add software from recipes", () => navigate("discovery"), "button primary"), button("Refresh", () => load(null), "button secondary"));
    actions.append(button("＋ Software",()=>ui.operationForm("create_software"),"button secondary"));
    head.append(actions);
    if(attention){
      const queues=el("details",null,"panel resource-section");queues.append(el("summary","Worker queues by capability"));main.append(queues);
      let loaded=false;queues.addEventListener("toggle",async()=>{if(!queues.open||loaded)return;loaded=true;
        try{const status=decodeCapabilityQueues(await api("operational_status"));if(!ui.current(token))return;
          for(const group of status.groups){const row=el("p");row.append(el("strong",group.required_capabilities.join(" + ")||"No additional capability requirements"),document.createTextNode(` · ${group.queued_jobs} queued · ${group.matching_workers} compatible workers · ${group.workers_with_active_leases} with active leases · oldest ${formatTime(group.oldest_queued_at)}`));if(!group.matching_workers)row.append(el("span"," · No compatible worker available","status-text"));queues.append(row);}
          if(!status.groups.length)queues.append(el("p","No queued jobs."));
          if(status.truncated)queues.append(el("p","Showing the first 200 capability groups.","muted"));
          queues.append(el("p","Active leases show current work. A compatible worker may already be busy.","small muted"));
        }catch{queues.append(el("p","Queue diagnostics are unavailable for this account.","muted"));}
      });
    }
    const filters = el("div", null, "filters"), search = field(filters, "Search all applications", "search", query.q);
    search.maxLength = 200;
    const choose = (title, options, value) => {
      const wrap = el("label", title, "field"), input = el("select");
      input.setAttribute("aria-label", title);
      for (const [key, text] of options) input.append(new Option(text, key));
      input.value = value; wrap.append(input); filters.append(wrap); return input;
    };
    const view = choose("View", libraryViews, query.view), sort = choose("Sort", [["name","Name"],["newest","Recently added"]], query.sort);
    const saved = el("div", null, "toolbar");
    for (const [key, text] of libraryViews.filter(([v]) => v !== "all")) {
      const a = el("a", text, "chip"); a.href = `#/attention?view=${key}`; saved.append(a);
    }
    main.append(filters, saved, el("p", "Bookmark or share this URL to return to the same search and view.", "small muted"));
    const selection = createSelection(), selectionBar = el("div", null, "toolbar");
    const selectedCount = el("span", "0 selected"), toExport = button("Create export from selection", () => ui.exportSelection(selection.values()), "button primary");
    toExport.disabled = true;
    selectionBar.append(selectedCount, toExport, button("Clear selection", () => { selection.clear(); draw(); }, "button secondary"));
    main.append(selectionBar);
    const columns = el("details", null, "advanced"), switches = new Map(); columns.append(el("summary", "Columns"));
    for (const [key,text] of [["channels","Channels"],["check","Latest check"],["next","Next check"]]) {
      const wrap=el("label",text,"confirmation"), check=el("input"); check.type="checkbox";check.checked=true;
      wrap.prepend(check); columns.append(wrap);switches.set(key,check);check.addEventListener("change",draw);
    }
    main.append(columns);
    const status = el("p", "Loading…", "small muted"); status.setAttribute("role","status");
    const content = el("section", null, "panel library-table"), paging = el("div", null, "toolbar");
    const previous=button("Previous",()=>{const cursor=back.pop()??null;load(cursor,false);},"button secondary"), next=button("Next",()=>{back.push(currentCursor);load(nextCursor,false);},"button secondary");
    paging.append(previous,next);main.append(status,content,paging);
    let rows=[], currentCursor=null, nextCursor=null, back=[], serial=0, timer;
    function draw() {
      const focused = content.contains(document.activeElement) ? document.activeElement.getAttribute("aria-label") : null;
      content.replaceChildren(); selectedCount.textContent=`${selection.values().length} selected across pages`;toExport.disabled=!selection.values().length;
      if (!rows.length) { content.append(el("p", "No applications match this view.", "empty")); return; }
      const table=el("table"), head=el("thead"), headers=el("tr"), body=el("tbody");
      const selectPage=el("input");selectPage.type="checkbox";selectPage.setAttribute("aria-label","Select this page");selectPage.checked=rows.every(row=>selection.has(row.id));
      selectPage.indeterminate=!selectPage.checked&&rows.some(row=>selection.has(row.id));
      selectPage.addEventListener("change",()=>{try{if(selectPage.checked&&new Set([...selection.values().map(r=>r.id),...rows.map(r=>r.id)]).size>100)throw new Error("Select at most 100 applications per export.");rows.forEach(row=>selection.set(row,selectPage.checked));}catch(error){showError(error);}draw();});
      const first=el("th");first.append(selectPage);headers.append(first,el("th","Application"));
      for(const [key,text] of [["channels","Channels"],["check","Latest check"],["next","Next check"]])if(switches.get(key).checked)headers.append(el("th",text));
      headers.append(el("th","Needs attention"),el("th","Action"));head.append(headers);
      for(const row of rows){
        const tr=el("tr"), select=el("td"), check=el("input");check.type="checkbox";check.checked=selection.has(row.id);check.setAttribute("aria-label",`Select ${row.name}`);
        check.addEventListener("change",()=>{try{selection.set(row,check.checked);}catch(error){showError(error);}draw();});select.append(check);
        const name=el("td"), link=el("a",row.name);link.href=routeHash("software",row.id);name.append(link,el("small",row.slug,"muted"));tr.append(select,name);
        if(switches.get("channels").checked)tr.append(el("td",row.channels.map(c=>`${c.name}: ${c.version}`).join(" · ")||"None"));
        if(switches.get("check").checked){const cell=el("td",row.outstanding_runs?`${row.outstanding_runs} builds queued or running`:row.latest_run_state?label(row.latest_run_state):"Not built");if(row.last_success_at)cell.append(el("small",`Last success ${formatTime(row.last_success_at)}`,"muted"));tr.append(cell);}
        if(switches.get("next").checked)tr.append(el("td",formatTime(row.next_run_at)));
        const reasons=attentionReasons(row), attentionCell=el("td");for(const reason of reasons)attentionCell.append(el("div",reason,"status-text"));if(!reasons.length)attentionCell.textContent="—";tr.append(attentionCell);
        const action=el("td"), a=el("a",row.review_release_id?"Review release":row.latest_run_state==="failed"&&!row.outstanding_runs?"Inspect failure":"Open application","button secondary");
        a.href=row.review_release_id?routeHash("releases",row.review_release_id):row.latest_run_state==="failed"&&!row.outstanding_runs&&row.latest_run_id?routeHash("runs",row.latest_run_id):routeHash("software",row.id);action.append(a);tr.append(action);body.append(tr);
      }
      table.append(head,body);content.append(table);
      if(focused) [...content.querySelectorAll("input[aria-label]")].find(input=>input.getAttribute("aria-label")===focused)?.focus();
    }
    async function load(cursor=null,reset=true){
      const request=++serial; if(reset)back=[];
      previous.disabled=true;next.disabled=true;status.textContent="Loading…";
      try{
        const result=decodeLibrary(await api("software_library",{query:{q:search.value,view:view.value,sort:sort.value,limit:"50",...(cursor?{cursor}:{})}}));
        if(!ui.current(token)||request!==serial)return;
        rows=result.items;currentCursor=cursor;nextCursor=result.nextCursor;draw();
        status.textContent=`${rows.length} applications on this page${nextCursor?" · More results available":" · End of results"}`;
        previous.disabled=!back.length;next.disabled=!nextCursor;
      }catch(error){if(ui.current(token)&&request===serial){status.textContent="Could not load this view. Refresh to retry.";showError(error);}}
    }
    function changed(){clearTimeout(timer);++serial;const params=new URLSearchParams({q:search.value,view:view.value,sort:sort.value});history.replaceState(null,"",`#/${attention?"attention":"software"}?${params}`);timer=setTimeout(()=>load(),200);}
    search.addEventListener("input",changed);view.addEventListener("change",changed);sort.addEventListener("change",changed);
    const keyboard=event=>{if(event.key==="/"&&!/INPUT|TEXTAREA|SELECT/.test(event.target.tagName)&&!document.querySelector("dialog[open]")){event.preventDefault();search.focus();}};
    document.addEventListener("keydown",keyboard);ui.cleanup(()=>{clearTimeout(timer);document.removeEventListener("keydown",keyboard);++serial;});
    await load();
  }
  return {page};
}
