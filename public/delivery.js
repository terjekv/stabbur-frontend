import { object, routeHash, formatTime } from "./model.js";

export function decodeDelivery(value) {
  const result=object(value);
  if (typeof result.configured!=="boolean") throw new Error("Unexpected delivery response");
  if (!result.configured) return Object.freeze({configured:false});
  if (!Number.isSafeInteger(result.revision) || result.revision<0 || typeof result.url!=="string" || !Array.isArray(result.entries)) throw new Error("Unexpected delivery response");
  const entries=result.entries.map(raw=>{
    const entry=object(raw), spec=object(entry.spec);
    if (!["testing","stable"].includes(spec.channel) || typeof spec.software!=="string" || typeof entry.version!=="string" || typeof entry.release!=="string" || !/^[a-f0-9]{64}$/.test(entry.digest) || typeof entry.tested!=="boolean") throw new Error("Unexpected publication entry");
    return Object.freeze({...entry,spec:Object.freeze(spec)});
  });
  return Object.freeze({...result,entries:Object.freeze(entries)});
}
export function nextStep(status,targets,deliveryEntries=[]) {
  if (!targets.length) return {title:"Choose build instructions",detail:"Add a reviewed recipe to create the first installer.",group:"discovery"};
  const latest=status.latest_run;
  if (latest && ["queued","running"].includes(latest.state)) return {title:"Follow your build",detail:"The worker is preparing your installer. Progress and logs update automatically.",group:"runs",id:latest.id};
  if (latest?.state==="failed") return {title:"Resolve the failed build",detail:"Open the build for its cause and next action.",group:"runs",id:latest.id};
  if (!latest || latest.state!=="succeeded") return {title:"Review and build",detail:"Check the source and worker, then create your first installer.",group:"targets",id:targets[0].id};
  if (!status.channels.length) return {title:"Review your installer",detail:"A successful build is ready for review. Promote the exact release to testing before delivery.",group:"runs",id:latest.id};
  if (!deliveryEntries.length) return {title:"Publish to a test Mac",detail:"Choose installation and detection settings, then publish the testing channel to Munki.",group:"delivery",id:targets[0].software_id};
  return {title:"Test and publish",detail:"Verify installation and a second update check on a test Mac before stable delivery.",group:"delivery",id:targets[0].software_id};
}

export function createDelivery(ui) {
  const {api,request,element:el,button,field,heading,openDialog,showError,navigate}=ui;
  const link=(text,group,id)=>{const a=el("a",text,"button secondary");a.href=routeHash(group,id);return a;};
  function select(form,label,choices,value="") {
    const wrap=el("label",label,"field"),input=el("select");input.setAttribute("aria-label",label);
    for(const [value,text] of choices) { const option=el("option",text);option.value=value;input.append(option); }
    input.value=value;wrap.append(input);form.append(wrap);return input;
  }
  function confirm(form,text) {
    const label=el("label",null,"confirmation"),input=el("input");input.type="checkbox";input.required=true;
    label.append(input,document.createTextNode(text));form.append(label);return input;
  }
  function submit(form,text,action) {
    const control=el("button",text,"button primary");control.type="submit";form.append(control);
    form.addEventListener("submit",async event=>{event.preventDefault();if(!form.reportValidity())return;control.disabled=true;control.textContent=text.startsWith("Publish")?"Verifying installer and publishing…":"Applying…";try{await action();}catch(error){showError(error);}finally{control.disabled=false;control.textContent=text;}});
    return control;
  }
  async function page(softwareId) {
    const token=ui.begin();
    const {main}=heading("Munki delivery","Publish reviewed installers, connect a test Mac, and see exactly what devices can receive.");
    const state=decodeDelivery(await request("/api/delivery"));
    if(!ui.current(token))return;
    if(!state.configured) {
      main.append(el("p","Munki delivery has not been configured on this console. The macOS test installer configures it automatically. For a separate deployment, the console administrator must configure its private delivery storage.","callout warning"));return;
    }
    main.append(el("p","Devices use a separate read-only repository credential. Stabbur login credentials are never sent to them.","muted"));
    const destination=el("section",null,"panel resource-section");destination.append(el("h2","Repository"),el("p",`Testing: ${state.url}/testing`),el("p",`Stable: ${state.url}/stable`),el("p",state.updated_at?`Last change: ${state.last_action} · ${formatTime(state.updated_at)}`:"No installers published yet.","muted"));main.append(destination);
    for(const channel of ["testing","stable"]) destination.append(button(`Download ${channel} Mac profile`,async()=>{
      try {await request("/api/delivery/profile",{channel});}catch(error){showError(error);}
    },"button secondary"));
    destination.append(el("p","Use one delivery profile per Mac. Install Munki on the test Mac, then open the downloaded configuration profile in System Settings. The general profile offers published apps in Managed Software Center. An application-specific test profile below requests that application's installation. Profiles contain the repository read credential; distribute them only to managed Macs.","muted"));
    if(state.url.startsWith("http://"))destination.append(el("p","This is a local test repository. Its loopback address works only on this Mac. A separate test Mac requires a console deployed at a reachable HTTPS address.","callout warning"));
    if(softwareId) {
      const software=object(await api("get_software",{parameters:{software:softwareId}}));
      const channels=(await api("list_channels",{parameters:{software:software.id}}));
      if(!ui.current(token))return;
      const items=Array.isArray(channels)?channels:channels.items;
      const panel=el("section",null,"panel resource-section");panel.append(el("h2",software.name),link("Back to software","software",software.id));
      if(!items.length)panel.append(el("p","First review a successful build and promote its release to testing.","callout"));
      for(const channel of items.filter(c=>["testing","stable"].includes(c.name)))panel.append(button(`Publish ${software.name} to ${channel.name}`,()=>publishForm(software,channel,state),"button primary"));
      main.append(panel);
    }else destination.append(link("Choose software to publish","software"));
    const published=el("section",null,"panel resource-section");published.append(el("h2","Published versions"));main.append(published);
    const entries=state.entries;
    if(!entries.length)published.append(el("p","No versions are available to Munki yet. Publishing a Stabbur channel alone does not add it here.","muted"));
    for(const entry of entries) {
      const card=el("article",null,"recipe-choice");card.append(el("h3",`${entry.name} ${entry.version}`),el("p",`${entry.spec.channel} · ${entry.spec.architecture} · ${entry.tested?"Test confirmed":"Test pending"}`),el("p",`Installer: ${entry.spec.format} · Detection: ${entry.spec.detection.kind}`));
      const actions=el("div",null,"actions");
      actions.append(button("Download application test profile",async()=>{try{await request("/api/delivery/profile",{channel:entry.spec.channel,software:entry.spec.software});}catch(error){showError(error);}},"button secondary"));
      actions.append(button("Remove from Munki",()=>{
        const body=openDialog("Remove from Munki"),form=el("form");body.append(form);
        form.append(el("p",`Remove ${entry.name} ${entry.version} from every Munki channel. Already downloaded or installed copies cannot be recalled.`));
        confirm(form,"I have reviewed this removal.");submit(form,"Remove published version",async()=>{await request("/api/delivery/remove",{release:entry.release,expected_revision:state.revision,reviewed:true});await navigate("delivery",softwareId);});
      },"button danger"));card.append(actions);published.append(card);
    }
    const test=el("section",null,"panel resource-section");test.append(el("h2","Test before stable delivery"));
    const steps=el("ol");for(const text of ["Publish to testing and install the application-specific profile on a disposable test Mac.","Open Managed Software Center, check for updates, and install the application.","Open the application and confirm its version. Check for updates again; the same version must not be offered again.","For an upgrade, start with the previous version installed and repeat the checks.","Promote the tested release to stable, then publish it here and confirm the test passed."])steps.append(el("li",text));
    test.append(steps);main.append(test);
  }
  async function publishForm(software,channel,state) {
    const body=openDialog("Publish to Munki"),form=el("form");body.append(form);
    const release=object(await api("get_release",{parameters:{release:channel.release_id}}));
    if(!form.isConnected)return;
    form.append(el("h2",`${software.name} ${release.version} → ${channel.name}`),el("p","This creates the repository catalog and manifests and verifies the downloaded installer. Review how Munki will install it and recognize that it is already installed.","muted"));
    const preset=software.installation?.install?.stabbur_munki || {};
    const architecture=select(form,"Test Mac architecture",[["aarch64","Apple silicon"],["x86_64","Intel"]],"aarch64");
    const macos=field(form,"Test Mac macOS version","text","");macos.required=true;macos.placeholder="For example, 15.0";
    const format=select(form,"Installer format",[["pkg","Installer package (.pkg)"],["dmg_app","Application in a disk image (.dmg)"]],preset.format||"pkg");
    const detection=select(form,"Detect installed software using",[["application","Application name and bundle identifier"],["receipt","Package receipt"]],"application");
    const name=field(form,"Application filename","text",preset.application||"");name.placeholder="Firefox.app";
    const bundle=field(form,"Bundle identifier","text",preset.bundle_id||"");bundle.placeholder="org.mozilla.firefox";
    const receipt=field(form,"Package identifier","text","");
    function fields(){const app=detection.value==="application";name.parentElement.hidden=!app;bundle.parentElement.hidden=!app;receipt.parentElement.hidden=app;name.required=app;bundle.required=app;receipt.required=!app;}
    detection.addEventListener("change",fields);fields();
    form.append(el("p","The release version is used for installed-state detection. If the application's bundle version or receipt version differs, fix the recipe's version output before publishing.","callout"));
    const tested=confirm(form,"I verified installation and confirmed that a second update check does not offer this version again.");tested.required=channel.name==="stable";
    confirm(form,"I reviewed this exact release, installer format, architecture and detection settings.");
    submit(form,`Publish to ${channel.name}`,async()=>{
      await request("/api/delivery/publish",{spec:{software:software.slug,channel:channel.name,architecture:architecture.value,macos:macos.value,format:format.value,detection:detection.value==="application"?{kind:"application",name:name.value,bundle_id:bundle.value}:{kind:"receipt",package_id:receipt.value}},release:release.id,expected_revision:state.revision,reviewed:true,test_confirmed:tested.checked});
      await navigate("delivery",software.id);
    });
  }
  return {page};
}
