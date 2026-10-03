import { decodeLibrary } from "./library.js";
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
export function sameExportDefinition(left,right) {
  const canonical=value=>Array.isArray(value)?value.map(canonical):value&&typeof value==="object"?Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])])):value;
  const normalized=definition=>({...definition,selections:[...definition.selections].sort((a,b)=>a.software.localeCompare(b.software))});
  return JSON.stringify(canonical(normalized(left)))===JSON.stringify(canonical(normalized(right)));
}
export function decodeExportSnapshot(value) {
  const view=object(value),snapshot=object(view.snapshot);
  if(!Number.isSafeInteger(snapshot.generation)||snapshot.generation<1||!Array.isArray(snapshot.items)||snapshot.items.length>400||!Array.isArray(view.unavailable_releases)||!view.unavailable_releases.every(id=>typeof id==="string"))throw new Error("Unexpected published snapshot");
  if(!["hosted","download"].includes(snapshot.definition?.destination)||typeof snapshot.definition?.catalog!=="string")throw new Error("Unexpected snapshot destination");
  for(const item of snapshot.items)if(typeof item.name!=="string"||typeof item.version!=="string"||typeof item.release!=="string"||!Array.isArray(item.architectures)||!item.architectures.every(a=>["aarch64","x86_64"].includes(a)))throw new Error("Unexpected published installer");
  return view;
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

  let pendingSelection=[];
  async function page(id){
    const token=ui.begin();
    if(id)return editor(id,token);
    const {main,head}=heading("Exports","Saved application selections and reviewed publication snapshots.");
    head.append(button("New export",()=>navigate("exports","new"),"button primary"));
    const list=el("section"), more=button("Load more exports",()=>load(),"button secondary");main.append(list,more);
    let cursor=null,serial=0;
    async function load(){const call=++serial;more.disabled=true;try{
      const page=object(await api("list_exports",{query:{limit:"50",...(cursor?{cursor}:{})}}));
      if(!ui.current(token)||call!==serial)return;
      if(!Array.isArray(page.items))throw new Error("Unexpected exports page");
      for(const value of page.items){const record=decodeExport(value),card=el("article",null,"panel resource-section");
        card.append(el("h2",record.definition.name),el("p",`${record.definition.selections.length} applications · ${record.definition.destination==="hosted"?"Hosted Munki repository":"Repository files"} · ${record.generation?`Published snapshot ${record.generation}`:"Draft"}`),button("Open export",()=>navigate("exports",record.id),"button primary"));
        const status=el("p","Check whether approved channels or the saved selection differ from publication.","muted");
        const check=button("Check for changes",async()=>{check.disabled=true;try{const plan=decodeExportPlan(await api("plan_export",{parameters:{export:record.id}}));if(!ui.current(token))return;status.textContent=plan.changes.filter(c=>c.action!=="unchanged").map(c=>`${c.action}: ${c.name}`).join(" · ")||"No publication changes.";}finally{check.disabled=false;}},"button secondary");
        card.append(status,check);list.append(card);
      }
      if(!list.children.length)list.append(el("p","No exports yet. Select applications in the library or create an export."));
      if(page.next_cursor&&page.next_cursor===cursor)throw new Error("Export pagination did not advance");
      cursor=page.next_cursor;more.hidden=!cursor;
    }finally{more.disabled=false;}}
    await load();
    const legacy=el("details",null,"advanced");legacy.append(el("summary","Earlier Munki publications"),link("Open earlier delivery screen","delivery"));main.append(legacy);
  }
  async function editor(id,token){
    const fresh=id==="new";
    let record=fresh?null:decodeExport(await api("get_export",{parameters:{export:id}}));
    const metadata=new Map();
    if(!ui.current(token))return;
    const draft=record?structuredClone(record.definition):{name:"",slug:"",destination:"hosted",catalog:"testing",selections:[]};
    const selections=new Map(draft.selections.map(s=>[s.software,s]));
    const initial=fresh?pendingSelection:[];pendingSelection=[];
    for(const app of initial){metadata.set(app.id,app);selections.set(app.id,defaultSelection(app));}
    const {main}=heading(fresh?"New export":draft.name,"Save your software selection once. When builds are approved, preview the changes and publish the whole batch.");
    main.append(link("All exports","exports"));
    const form=el("form",null,"panel resource-section");main.append(form);
    form.append(el("h2","Destination"));
    const name=field(form,"Export name","text",draft.name);name.required=true;name.maxLength=200;name.placeholder="For example, Staff Macs";
    const slug=field(form,"Short name","text",draft.slug);slug.required=true;slug.pattern="[a-z0-9]+(?:-[a-z0-9]+)*";slug.maxLength=63;slug.placeholder="staff-macs";
    if(fresh)name.addEventListener("input",()=>{if(!slug.dataset.edited)slug.value=name.value.toLowerCase().replace(/[^a-z0-9]+/g,"-").replace(/^-|-$/g,"").slice(0,63);});slug.addEventListener("input",()=>slug.dataset.edited="true");
    const destination=select(form,"Deliver using",[["hosted","Hosted Munki repository"],["download","Files for my existing Munki repository"]],draft.destination);
    const catalog=field(form,"Munki catalog","text",draft.catalog);catalog.required=true;catalog.pattern=slug.pattern;catalog.maxLength=63;
    const destinationHelp=el("p",null,"muted");form.append(destinationHelp);const explain=()=>destinationHelp.textContent=destination.value==="hosted"?"Stabbur serves the published snapshot. After publishing, use Destination setup to connect managed Macs.":"Download installers, pkginfo and catalogs together. Keep using your existing Munki manifests and device settings.";destination.addEventListener("change",explain);explain();
    form.append(el("h2","Software to include"),el("p","Follow a channel to pick up its approved release in the next preview, or pin an exact release. Publishing remains an explicit action.","muted"));
    const search=field(form,"Find software","search","");search.placeholder="Search your library";
    const count=el("p",null,"export-selection-count");form.append(count);
    const list=el("div",null,"export-selection-list");form.append(list);
    search.maxLength=200;
    const picker=el("div",null,"export-picker-controls"), mode=select(picker,"Show",[["search","Search results"],["selected","Selected applications"]],"search");
    const more=button("Load more applications",()=>loadSoftware(true),"button secondary");picker.append(more);form.insertBefore(picker,list);
    const updateCount=()=>count.textContent=`${selections.size} applications selected across searches and pages`;
    let cursor=null,querySerial=0,timer;
    function renderApp(app){
      const row=el("article",null,"export-selection"),top=el("div",null,"export-selection-heading"),label=el("label",null,"confirmation"),check=el("input");check.type="checkbox";check.checked=selections.has(app.id);label.append(check,document.createTextNode(app.name));top.append(label);row.append(top);list.append(row);
      const controls=el("div",null,"export-selection-controls");row.append(controls);
      function draw(){controls.replaceChildren();controls.hidden=!check.checked;if(!check.checked)return;const selection=selections.get(app.id);
        const choices=[["testing","Follow testing"],["stable","Follow stable"],["pin","Pin exact release"]];if(selection.source.kind==="channel"&&!choices.some(([v])=>v===selection.source.channel))choices.push([selection.source.channel,`Follow ${selection.source.channel}`]);
        const source=select(controls,`Version for ${app.name}`,choices,selection.source.kind==="release"?"pin":selection.source.channel);
        const releaseWrap=el("div");controls.append(releaseWrap);
        async function pin(){
          releaseWrap.replaceChildren(el("p","Loading releases…","muted"));
          try{
            const initial=selection.source.kind==="release"?selection.source.release:"";
            releaseWrap.replaceChildren();const release=select(releaseWrap,`Pinned release for ${app.name}`,[["","Choose an approved release"]],"");release.required=true;
            const seen=new Set();let cursor=null;
            const add=value=>{if(!seen.has(value.id)&&["testing","stable"].includes(value.state)&&value.availability?.kind==="available"){seen.add(value.id);release.append(new Option(`${value.version} · ${value.state}`,value.id));}};
            if(initial){const value=object(await api("get_release",{parameters:{release:initial}}));add(value);release.value=initial;if(!seen.has(initial))releaseWrap.append(el("p","The pinned release is no longer eligible. Choose another approved release.","callout warning"));}
            const more=button("Load more releases",load,"button secondary");releaseWrap.append(more);
            async function load(){more.disabled=true;try{
              const page=object(await api("list_releases",{parameters:{software:app.id},query:{limit:"50",...(cursor?{cursor}:{})}}));
              if(!releaseWrap.isConnected||source.value!=="pin")return;
              if(!Array.isArray(page.items))throw new Error("Unexpected release page");page.items.forEach(add);
              if(page.next_cursor&&page.next_cursor===cursor)throw new Error("Release pagination did not advance");cursor=page.next_cursor;more.hidden=!cursor;
            }finally{more.disabled=false;}}
            release.addEventListener("change",()=>selection.source={kind:"release",release:release.value});await load();
          }catch(error){showError(error);}
        }
        source.addEventListener("change",()=>{if(source.value==="pin"){selection.source={kind:"release",release:""};pin();}else{selection.source={kind:"channel",channel:source.value};releaseWrap.replaceChildren();}});if(source.value==="pin")pin();
        const arch=select(controls,`Macs for ${app.name}`,[["both","Apple silicon and Intel"],["aarch64","Apple silicon"],["x86_64","Intel"]],selection.architectures.length===1?selection.architectures[0]:"both");arch.addEventListener("change",()=>selection.architectures=arch.value==="both"?[]:[arch.value]);
        const settings=button(selection.settings?"Review installation settings":"Set installation settings",()=>settingsDialog(app,selection,draw),"button secondary");controls.append(settings);if(!selection.settings)controls.append(el("p","Save as a draft now; installation settings are required before publishing.","muted"));
      }
      check.addEventListener("change",async()=>{try{if(check.checked){
        if(selections.size>=100){check.checked=false;throw new Error("An export supports up to 100 applications.");}
        selections.set(app.id,defaultSelection(app));draw();updateCount();check.disabled=true;
        try{const full=object(await api("get_software",{parameters:{software:app.id}}));if(!ui.current(token))return;metadata.set(app.id,full);const selection=selections.get(app.id);if(selection&&!selection.settings)selection.settings=defaultSelection(full).settings;}finally{check.disabled=false;}
      }else selections.delete(app.id);draw();updateCount();}catch(error){showError(error);}});draw();
    }
    async function loadSoftware(append=false){
      const request=++querySerial;more.disabled=true;
      if(!append){cursor=null;list.replaceChildren(el("p","Loading applications…","muted"));}
      try{
        if(mode.value==="selected"){
          more.hidden=true;
          const ids=[...selections.keys()];let index=0;
          await Promise.all(Array.from({length:Math.min(4,ids.length)},async()=>{while(index<ids.length){const id=ids[index++];if(!metadata.has(id))metadata.set(id,object(await api("get_software",{parameters:{software:id}})));}}));
          if(!ui.current(token)||request!==querySerial)return;
          list.replaceChildren();for(const id of ids){const app=metadata.get(id);if(app&&`${app.name} ${app.slug}`.toLowerCase().includes(search.value.toLowerCase()))renderApp(app);}
        }else{
          const page=decodeLibrary(await api("software_library",{query:{q:search.value,view:"all",sort:"name",limit:"50",...(cursor?{cursor}:{})}}));
          if(!ui.current(token)||request!==querySerial)return;
          if(!append)list.replaceChildren();for(const app of page.items)renderApp(app);
          if(page.nextCursor&&page.nextCursor===cursor)throw new Error("Application pagination did not advance");
          cursor=page.nextCursor;more.hidden=!cursor;
        }
        if(!list.children.length)list.append(el("p","No applications match this view.","muted"));
      }catch(error){if(ui.current(token)&&request===querySerial)showError(error);}finally{if(request===querySerial)more.disabled=false;}
    }
    function searchChanged(){++querySerial;clearTimeout(timer);timer=setTimeout(()=>loadSoftware(),200);}
    search.addEventListener("input",searchChanged);mode.addEventListener("change",searchChanged);
    ui.cleanup(()=>{++querySerial;clearTimeout(timer);});
    // Only explicit selections receive detail reads; the library itself stays paginated.
    for(const app of initial){const full=object(await api("get_software",{parameters:{software:app.id}}));if(!ui.current(token))return;metadata.set(app.id,full);selections.set(app.id,defaultSelection(full));}
    updateCount();await loadSoftware();

    async function save(){if(!form.reportValidity())return null;const definition={name:name.value,slug:slug.value,destination:destination.value,catalog:catalog.value,selections:[...selections.values()]};if(record&&sameExportDefinition(definition,record.definition))return record;record=decodeExport(await api(record?"update_export":"create_export",{...(record?{parameters:{export:record.id},revision:record.revision}:{}),body:definition}));return record;}
    submit(form,"Save selection",async()=>{const saved=await save();if(saved)navigate("exports",saved.id);});
    form.append(button("Preview batch",async()=>{try{const saved=await save();if(saved)await preview(saved);}catch(error){showError(error);}},"button secondary"));
    if(record){
      const published=el("section",null,"panel resource-section");published.append(el("h2","Published snapshot"));main.append(published);
      if(record.generation){published.append(el("p",`Snapshot ${record.generation}. Saving a selection does not change what devices receive.`));const download=el("a","Download repository files","button secondary");download.href=`/api/exports/${encodeURIComponent(record.id)}/snapshots/${record.generation}/download`;download.download="";published.append(download,el("p","The archive contains pkgs, pkgsinfo and catalogs. It contains no manifests. For an existing repository, merge the selected files, regenerate its catalogs with makecatalogs, and keep managing assignments there.","muted"));}
      else published.append(el("p","Nothing published yet. Preview the batch to see what is ready."));
      if(record.generation){
        const current=decodeExportSnapshot(await api("get_export_snapshot",{parameters:{export:record.id,generation:String(record.generation)}}));
        if(!ui.current(token))return;
        published.prepend(el("p",`Published catalog: ${current.snapshot.definition.catalog}`,"muted"));
        const versions=el("div",null,"export-published-versions");
        for(const item of current.snapshot.items){const row=el("p");const unavailable=current.unavailable_releases.includes(item.release);row.append(el("strong",`${item.name} ${item.version}`),document.createTextNode(` · ${item.architectures.map(a=>a==="aarch64"?"Apple silicon":"Intel").join(" / ")}${unavailable?" · Unavailable — omitted from hosted delivery":""}`));versions.append(row);}
        if(!current.snapshot.items.length)versions.append(el("p","This published snapshot is empty."));published.append(versions);
        if(current.unavailable_releases.length)published.append(el("p","A published release was withdrawn or rejected. Review a fresh batch before downloading repository files.","callout warning"));
        if(current.snapshot.definition.destination==="hosted")setup(published,record);
        main.insertBefore(published,form);
      }
      const history=el("details",null,"advanced");history.append(el("summary","Publication history"));published.append(history);
      let loaded=false,after="0",loading=false;
      const moreHistory=button("Load more snapshots",loadHistory,"button secondary");history.append(moreHistory);
      async function loadHistory(){if(loading)return;loading=true;moreHistory.disabled=true;try{
        const page=object(await api("list_export_history",{parameters:{export:record.id},query:{after,limit:"20"}}));if(!ui.current(token))return;
        if(!Array.isArray(page.items))throw new Error("Unexpected export history");
        for(const snapshot of page.items){const row=el("article",null,"resource-section");row.append(el("p",`Snapshot ${snapshot.generation} · ${snapshot.items.length} installers · ${formatTime(snapshot.created_at)}`),button("Compare and restore selection",()=>reviewSnapshot(record,snapshot.generation),"button secondary"));history.insertBefore(row,moreHistory);}
        if(page.next_cursor&&page.next_cursor===after)throw new Error("History pagination did not advance");after=page.next_cursor;moreHistory.hidden=!after;loaded=true;
      }finally{loading=false;moreHistory.disabled=false;}}
      history.addEventListener("toggle",()=>{if(history.open&&!loaded)loadHistory().catch(showError);});
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
    if(plan.definition_revision!==record.revision)throw new Error("This export was edited elsewhere. Reload it before reviewing the batch.");
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
  async function reviewSnapshot(record,generation){
    const old=decodeExportSnapshot(await api("get_export_snapshot",{parameters:{export:record.id,generation:String(generation)}}));
    const current=record.generation?decodeExportSnapshot(await api("get_export_snapshot",{parameters:{export:record.id,generation:String(record.generation)}})):null;
    const body=openDialog(`Snapshot ${generation} · compare with current publication`);
    for(const change of snapshotDiff(current?.snapshot.items||[],old.snapshot.items))body.append(el("p",`${change.name}: ${change.before||"—"} → ${change.after||"—"}${change.changed?" · "+change.details.join("; "):" · unchanged"}`));
    body.append(el("p","Restoring saves a draft with exact release pins and the earlier installation settings. Preview and publish that draft separately. Device installations are not rolled back automatically.","muted"));
    if(old.unavailable_releases.length){body.append(el("p","This snapshot contains unavailable releases and cannot be restored.","callout warning"));return;}
    const form=el("form");body.append(form);confirmation(form,"Replace the saved selection with these exact releases.");
    submit(form,"Restore selection as draft",async()=>{await api("update_export",{parameters:{export:record.id},revision:record.revision,body:restoredDefinition(record.definition,old.snapshot)});body.closest("dialog").close();await navigate("exports",record.id);});
  }
  return {page, select(rows){pendingSelection=rows.slice(0,100);}, clearSelection(){pendingSelection=[];}};
}

export function restoredDefinition(current,snapshot){
  const selections=new Map();
  for(const item of snapshot.items){
    if(typeof item.software!=="string"||typeof item.release!=="string"||!item.settings)throw new Error("Snapshot cannot provide a complete installation selection.");
    let selection=selections.get(item.software);
    if(selection&&selection.source.release!==item.release)throw new Error("Snapshot contains conflicting releases.");
    if(!selection){selection={software:item.software,source:{kind:"release",release:item.release},architectures:[],settings:structuredClone(item.settings)};selections.set(item.software,selection);}
    selection.architectures=[...new Set([...selection.architectures,...item.architectures])].sort();
  }
  return {...structuredClone(current),selections:[...selections.values()]};
}
export function snapshotDiff(before,after){
  const group=items=>{const map=new Map();for(const item of items){if(!map.has(item.software))map.set(item.software,[]);map.get(item.software).push(item);}return map;};
  const a=group(before),b=group(after),keys=[...new Set([...a.keys(),...b.keys()])];
  const text=rows=>[...new Set(rows.map(i=>`${i.version} (${i.architectures.join(" / ")})`))].join(", ");
  const identity=rows=>JSON.stringify(rows.map(i=>[i.release,i.digest,i.architectures,i.minimum_macos,i.maximum_macos,i.settings]).sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b))));
  return keys.map(key=>{
    const left=a.get(key)||[],right=b.get(key)||[],details=[];
    const values=(rows,pick)=>JSON.stringify(rows.map(pick).sort((x,y)=>JSON.stringify(x).localeCompare(JSON.stringify(y))));
    if(!left.length)details.push("Application added");else if(!right.length)details.push("Application removed");else{
      if(values(left,i=>i.release)!==values(right,i=>i.release))details.push("Exact release changed");
      if(values(left,i=>i.digest)!==values(right,i=>i.digest))details.push("Installer bytes changed");
      if(values(left,i=>[i.architectures,i.minimum_macos,i.maximum_macos])!==values(right,i=>[i.architectures,i.minimum_macos,i.maximum_macos]))details.push("Hardware or macOS compatibility changed");
      if(values(left,i=>i.settings)!==values(right,i=>i.settings))details.push("Installation or detection settings changed");
    }
    return {name:(right[0]||left[0]).name,before:text(left),after:text(right),changed:identity(left)!==identity(right),details};
  });
}
