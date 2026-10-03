import { object, routeHash, formatTime } from "./model.js";
const actions = new Set(["add", "update", "unchanged", "remove", "blocked"]);
export function decodeExport(value) {
  const record=object(value), def=object(record.definition);
  if (typeof record.id!=="string" || !Number.isSafeInteger(record.revision) || record.revision<1 || !Number.isSafeInteger(record.generation) || record.generation<0 || typeof def.name!=="string" || typeof def.slug!=="string" || typeof def.catalog!=="string" || !["hosted","download"].includes(def.destination) || !Array.isArray(def.selections) || def.selections.length>100) throw new Error("Unexpected saved export response");
  for(const selection of def.selections) {
    const source=object(selection.source);
    if(typeof selection.software!=="string" || !["channel","release"].includes(source.kind) || typeof source[source.kind]!=="string" || !Array.isArray(selection.architectures))throw new Error("Unexpected export selection");
  }
  return record;
}
export function decodeExportPlan(value) {
  const plan=object(value);
  if(typeof plan.export!=="string" || typeof plan.ready!=="boolean" || !/^[a-f0-9]{64}$/.test(plan.fingerprint) || !Array.isArray(plan.items) || !Array.isArray(plan.changes))throw new Error("Unexpected export preview");
  for(const change of plan.changes) if(!actions.has(change.action)||typeof change.name!=="string"||!Array.isArray(change.before)||!Array.isArray(change.after)||![...change.before,...change.after].every(v=>typeof v==="string") || (change.detail!==null&&typeof change.detail!=="string"))throw new Error("Unexpected export change");
  if(plan.ready && plan.changes.some(c=>c.action==="blocked"))throw new Error("Blocked export cannot be ready");
  return plan;
}
export function defaultSelection(software) {
  const preset=software.installation?.install?.stabbur_munki;
  return {software:software.id,source:{kind:"channel",channel:"testing"},architectures:[],settings:preset?.application&&preset?.bundle_id?{format:preset.format||"pkg",detection:{kind:"application",name:preset.application,bundle_id:preset.bundle_id},display_name:"",description:"",category:""}:null};
}
export function createExports(ui) {
  const {api,request,element:el,button,field,heading,openDialog,showError,navigate}=ui;
  const link=(text,group,id)=>{const a=el("a",text,"button secondary");a.href=routeHash(group,id);return a;};
  const select=(parent,label,choices,value)=>{const wrap=el("label",label,"field"),input=el("select");input.setAttribute("aria-label",label);for(const [key,text]of choices){const option=el("option",text);option.value=key;input.append(option);}input.value=value;wrap.append(input);parent.append(wrap);return input;};
  function confirmation(parent,text){const label=el("label",null,"confirmation"),check=el("input");check.type="checkbox";check.required=true;label.append(check,document.createTextNode(text));parent.append(label);return check;}
  function submit(form,text,action){const b=el("button",text,"button primary");b.type="submit";form.append(b);form.addEventListener("submit",async e=>{e.preventDefault();if(!form.reportValidity())return;b.disabled=true;try{await action();}catch(error){showError(error);}finally{b.disabled=false;}});return b;}
  async function collection(operation,parameters={}){const result=[],seen=new Set();let cursor;do{const page=object(await api(operation,{parameters,query:{limit:"200",...(cursor?{cursor}:{})}}));if(!Array.isArray(page.items))throw new Error("Unexpected list response");result.push(...page.items);cursor=page.next_cursor;if(cursor&&(seen.has(cursor)||seen.size>=100))throw new Error("List pagination did not finish");seen.add(cursor);}while(cursor);return result;}
  async function page(id){
    const token=ui.begin();
    if(id)return editor(id,token);
    const {main,actions:headingActions}=heading("Exports","Choose software from your library, review a batch, then publish it to Munki or download repository files.");
    const create=button("New export",()=>navigate("exports","new"),"button primary");(headingActions||main).append(create);
    const records=(await collection("list_exports")).map(decodeExport);if(!ui.current(token))return;
    if(!records.length){const empty=el("section",null,"panel resource-section");empty.append(el("h2","Build your library. Export what you need."),el("p","An export remembers which applications to include, which channels to follow, and how Munki detects installed versions. You review updates together before publishing."),link("Browse software","software"));main.append(empty);}
    for(const record of records){const card=el("article",null,"panel resource-section");card.append(el("h2",record.definition.name),el("p",`${record.definition.selections.length} applications · ${record.definition.destination==="hosted"?"Hosted Munki repository":"Files for an existing repository"} · ${record.generation?`Published snapshot ${record.generation}`:"Draft"}`),button("Open export",()=>navigate("exports",record.id),"button primary"));main.append(card);}
    const legacy=el("details",null,"advanced");legacy.append(el("summary","Earlier Munki publications"),el("p","Existing publications made with the earlier delivery screen remain available at their original addresses. New exports are managed here."),link("Open earlier delivery screen","delivery"));main.append(legacy);
  }
  async function editor(id,token){
    const fresh=id==="new";
    let record=fresh?null:decodeExport(await api("get_export",{parameters:{export:id}}));
    const software=await collection("list_software");if(!ui.current(token))return;
    const draft=record?structuredClone(record.definition):{name:"",slug:"",destination:"hosted",catalog:"testing",selections:[]};
    const selections=new Map(draft.selections.map(s=>[s.software,s]));
    const {main}=heading(fresh?"New export":draft.name,"Save your software selection once. When builds are approved, preview the changes and publish the whole batch.");
    main.append(link("All exports","exports"));
    const form=el("form",null,"panel resource-section");main.append(form);
    form.append(el("h2","Destination"));
    const name=field(form,"Export name","text",draft.name);name.required=true;name.maxLength=200;name.placeholder="For example, Staff Macs";
    const slug=field(form,"Short name","text",draft.slug);slug.required=true;slug.pattern="[a-z0-9]+(?:-[a-z0-9]+)*";slug.maxLength=63;slug.placeholder="staff-macs";
    if(fresh)name.addEventListener("input",()=>{if(!slug.dataset.edited)slug.value=name.value.toLowerCase().replace(/[^a-z0-9]+/g,"-").replace(/^-|-$/g,"").slice(0,63);});slug.addEventListener("input",()=>slug.dataset.edited="true");
    const destination=select(form,"Deliver using",[["hosted","Hosted Munki repository"],["download","Files for my existing Munki repository"]],draft.destination);
    const catalog=field(form,"Munki catalog","text",draft.catalog);catalog.required=true;catalog.pattern=slug.pattern;catalog.maxLength=63;
    const destinationHelp=el("p",null,"muted");form.append(destinationHelp);const explain=()=>destinationHelp.textContent=destination.value==="hosted"?"Stabbur serves the published snapshot. Configure managed Macs once in Destination setup below.":"Download installers, pkginfo and catalogs together. Keep using your existing Munki manifests and device settings.";destination.addEventListener("change",explain);explain();
    form.append(el("h2","Software to include"),el("p","Follow a channel to pick up its approved release in the next preview, or pin an exact release. Publishing remains an explicit action.","muted"));
    const search=field(form,"Find software","search","");search.placeholder="Search your library";
    const count=el("p",null,"export-selection-count");form.append(count);
    const list=el("div",null,"export-selection-list");form.append(list);
    const cards=[];
    const updateCount=()=>count.textContent=`${selections.size} of ${software.length} applications selected`;
    for(const app of software){
      const row=el("article",null,"export-selection"),top=el("div",null,"export-selection-heading"),label=el("label",null,"confirmation"),check=el("input");check.type="checkbox";check.checked=selections.has(app.id);label.append(check,document.createTextNode(app.name));top.append(label);row.append(top);list.append(row);
      const controls=el("div",null,"export-selection-controls");row.append(controls);
      function draw(){controls.replaceChildren();controls.hidden=!check.checked;if(!check.checked)return;const selection=selections.get(app.id);
        const choices=[["testing","Follow testing"],["stable","Follow stable"],["pin","Pin exact release"]];if(selection.source.kind==="channel"&&!choices.some(([v])=>v===selection.source.channel))choices.push([selection.source.channel,`Follow ${selection.source.channel}`]);
        const source=select(controls,`Version for ${app.name}`,choices,selection.source.kind==="release"?"pin":selection.source.channel);
        const releaseWrap=el("div");controls.append(releaseWrap);
        async function pin(){releaseWrap.replaceChildren(el("p","Loading releases…","muted"));try{const releases=await collection("list_releases",{software:app.id});if(!releaseWrap.isConnected||source.value!=="pin")return;releaseWrap.replaceChildren();const approved=releases.filter(r=>["testing","stable"].includes(r.state)&&r.availability?.kind==="available");const initial=selection.source.kind==="release"?selection.source.release:"";const release=select(releaseWrap,`Pinned release for ${app.name}`,[["","Choose an approved release"],...approved.map(r=>[r.id,`${r.version} · ${r.state}`])],initial);release.required=true;release.addEventListener("change",()=>selection.source={kind:"release",release:release.value});}catch(error){showError(error);}}
        source.addEventListener("change",()=>{if(source.value==="pin"){selection.source={kind:"release",release:""};pin();}else{selection.source={kind:"channel",channel:source.value};releaseWrap.replaceChildren();}});if(source.value==="pin")pin();
        const arch=select(controls,`Macs for ${app.name}`,[["both","Apple silicon and Intel"],["aarch64","Apple silicon"],["x86_64","Intel"]],selection.architectures.length===1?selection.architectures[0]:"both");arch.addEventListener("change",()=>selection.architectures=arch.value==="both"?[]:[arch.value]);
        const settings=button(selection.settings?"Review installation settings":"Set installation settings",()=>settingsDialog(app,selection,draw),"button secondary");controls.append(settings);if(!selection.settings)controls.append(el("p","Save as a draft now; installation settings are required before publishing.","muted"));
      }
      check.addEventListener("change",()=>{if(check.checked){if(selections.size>=100){check.checked=false;showError(new Error("An export supports up to 100 applications."));return;}selections.set(app.id,defaultSelection(app));}else selections.delete(app.id);draw();updateCount();});draw();cards.push({row,text:`${app.name} ${app.slug}`.toLowerCase()});
    }
    if(!software.length)list.append(el("p","Your software library is empty."),link("Add software from recipes","discovery"));
    search.addEventListener("input",()=>cards.forEach(({row,text})=>row.hidden=!text.includes(search.value.toLowerCase())));updateCount();
    async function save(){if(!form.reportValidity())return null;const definition={name:name.value,slug:slug.value,destination:destination.value,catalog:catalog.value,selections:[...selections.values()]};record=decodeExport(await api(record?"update_export":"create_export",{...(record?{parameters:{export:record.id},revision:record.revision}:{}),body:definition}));return record;}
    submit(form,"Save selection",async()=>{const saved=await save();if(saved)navigate("exports",saved.id);});
    form.append(button("Preview batch",async()=>{try{const saved=await save();if(saved)await preview(saved);}catch(error){showError(error);}},"button secondary"));
    if(record){
      const published=el("section",null,"panel resource-section");published.append(el("h2","Published snapshot"));main.append(published);
      if(record.generation){published.append(el("p",`Snapshot ${record.generation}. Saving a selection does not change what devices receive.`));const download=el("a","Download repository files","button secondary");download.href=`/api/exports/${encodeURIComponent(record.id)}/snapshots/${record.generation}/download`;download.download="";published.append(download,el("p","The archive contains pkgs, pkgsinfo and catalogs. It contains no manifests. For an existing repository, merge the selected files, regenerate its catalogs with makecatalogs, and keep managing assignments there.","muted"));}
      else published.append(el("p","Nothing published yet. Preview the batch to see what is ready."));
      if(record.generation&&record.definition.destination==="hosted")setup(published,record);
      const history=el("details",null,"advanced");history.append(el("summary","Publication history"));published.append(history);let loaded=false;history.addEventListener("toggle",async()=>{if(!history.open||loaded)return;try{let after="0";const seen=new Set();do{const page=object(await api("list_export_history",{parameters:{export:record.id},query:{after,limit:"200"}}));if(!Array.isArray(page.items))throw new Error("Unexpected export history");for(const snapshot of page.items)history.append(el("p",`Snapshot ${snapshot.generation} · ${snapshot.items.length} installers · ${formatTime(snapshot.created_at)}`));after=page.next_cursor;if(after&&seen.has(after))throw new Error("History pagination did not finish");seen.add(after);}while(after);loaded=true;}catch(error){showError(error);}});
    }
  }
  function settingsDialog(app,selection,refresh){
    const body=openDialog(`Installation settings · ${app.name}`),form=el("form");body.append(form);const settings=selection.settings||{format:"pkg",detection:{kind:"application",name:"",bundle_id:""},display_name:"",description:"",category:""};
    form.append(el("p","These settings are reused when this export follows a newer release. The release version must match the installed application's version or package receipt."));
    const format=select(form,"Installer format",[["pkg","Installer package (.pkg)"],["dmg_app","Application in disk image (.dmg)"]],settings.format);
    const detection=select(form,"Detect installation by",[["application","Application bundle"],["receipt","Package receipt"]],settings.detection.kind);
    const application=field(form,"Application filename","text",settings.detection.name||"");application.placeholder="Firefox.app";
    const bundle=field(form,"Bundle identifier","text",settings.detection.bundle_id||"");bundle.placeholder="org.mozilla.firefox";
    const receipt=field(form,"Package identifier","text",settings.detection.package_id||"");
    const display=field(form,"Display name (optional)","text",settings.display_name);const description=field(form,"Description (optional)","text",settings.description);const category=field(form,"Category (optional)","text",settings.category);
    function fields(){if(format.value==="dmg_app")detection.value="application";detection.disabled=format.value==="dmg_app";const app=detection.value==="application";for(const input of[application,bundle]){input.parentElement.hidden=!app;input.required=app;}receipt.parentElement.hidden=app;receipt.required=!app;}
    detection.addEventListener("change",fields);format.addEventListener("change",fields);fields();
    submit(form,"Use these settings",async()=>{selection.settings={format:format.value,detection:detection.value==="application"?{kind:"application",name:application.value,bundle_id:bundle.value}:{kind:"receipt",package_id:receipt.value},display_name:display.value,description:description.value,category:category.value};refresh();body.closest("dialog").close();});
  }
  async function preview(record){
    const plan=decodeExportPlan(await api("plan_export",{parameters:{export:record.id}}));
    const body=openDialog(`Preview · ${record.definition.name}`),form=el("form");body.append(form);
    form.append(el("p",plan.ready?"All selected applications are ready. Publishing replaces the complete snapshot in one operation.":"Resolve the blocked applications before publishing. The current published snapshot will remain available.",plan.ready?"callout":"callout warning"));
    if(!plan.changes.length)form.append(el("p","This export is empty. Publishing it creates an empty repository."));
    for(const change of plan.changes){const row=el("article",null,"recipe-choice");row.append(el("strong",`${change.action.toUpperCase()} · ${change.name}`),el("p",`${change.before.join(", ")||"—"} → ${change.after.join(", ")||"—"}`));if(change.detail)row.append(el("p",change.detail,"callout warning"));form.append(row);}
    if(plan.changes.some(c=>c.action==="remove"))form.append(el("p","Removing an application stops offering it. It does not uninstall copies already on Macs.","muted"));
    if(plan.ready){confirmation(form,"I have reviewed this batch and its installation settings.");const publish=submit(form,record.definition.destination==="hosted"?"Publish snapshot":"Prepare download snapshot",async()=>{publish.textContent="Verifying installers and publishing…";try{await request("/api/exports/apply",plan);body.closest("dialog").close();await navigate("exports",record.id);}finally{publish.textContent="Publish snapshot";}});}
  }
  function setup(parent,record){
    const details=el("details",null,"advanced");details.append(el("summary","Destination setup · connect Macs"),el("p",`${location.origin}/munki/exports/${record.id}`),el("p","Download a profile once per managed group. Later snapshots appear at the same repository address. The normal profile offers selected applications in Managed Software Center; the test profile requests installation of every selected application."));
    if(location.protocol==="http:")details.append(el("p","This local HTTP address is for development. Other Macs need a reachable HTTPS deployment.","callout warning"));
    for(const [test,text] of[[false,"Download managed Mac profile"],[true,"Download disposable test Mac profile"]])details.append(button(text,()=>{const body=openDialog(text),form=el("form");body.append(form);form.append(el("p",test?"Use a disposable Mac with Munki installed. This profile requests installation of all applications in the published snapshot.":"This profile contains a repository-only credential. Distribute it to managed Macs with Munki installed."));confirmation(form,"I have reviewed the destination and will protect this profile.");submit(form,"Download profile",async()=>{await request(`/api/exports/${encodeURIComponent(record.id)}/profile`,{reviewed:true,test_all:test});body.closest("dialog").close();});},"button secondary"));
    details.append(button("Revoke all downloaded profiles",()=>{const body=openDialog("Revoke device access"),form=el("form");body.append(form);form.append(el("p","Every previously downloaded profile for this export will stop working. Download and distribute replacement profiles afterwards."));confirmation(form,"I understand this interrupts device access.");submit(form,"Revoke profiles",async()=>{await api("revoke_export_readers",{parameters:{export:record.id}});body.closest("dialog").close();});},"button danger"));parent.append(details);
  }
  return {page};
}
