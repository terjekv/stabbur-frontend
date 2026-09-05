import {object, decodeSession, decodePage, decodeLogs, display, label, groups} from './model.js';
const root = document.querySelector('#app');
const dialog = document.querySelector('#dialog');
const notice = document.querySelector('#notice');
let session = null;
let contract;
let current = groups[0];
let generation = 0;
let expiryTimer;
const descriptions = {permission_denied:'Your account does not have permission for this action.', revision_changed:'This item changed. Refresh and review it before trying again.', conflict:'The action conflicts with current server state.', plan_changed:'The catalog plan changed. Review a fresh plan before applying.', validation_failed:'The server rejected these values. Check the form and its constraints.', try_again_later:'Too many requests. Wait a minute and try again.', server_unavailable:'The Stabbur server could not complete this request.', session_expired:'Your session ended. Sign in again.'};
function element(tag, text, className) { const node = document.createElement(tag); if (text != null) node.textContent = text; if (className) node.className = className; return node; }
function button(text, action, className='button') { const node = element('button', text, className); node.type='button'; node.addEventListener('click', () => Promise.resolve().then(action).catch(showError)); return node; }
function showError(error) { notice.textContent = error.message || 'The operation failed.'; notice.className='visible error'; }
function announce(text) { notice.textContent=text; notice.className='visible'; }
function expire() { session=null; clearTimeout(expiryTimer); dialog.close(); generation++; showLogin(); }
function establish(value) { session=decodeSession(value); clearTimeout(expiryTimer); expiryTimer=setTimeout(expire, Math.max(0,Date.parse(session.expiresAt)-Date.now())); }
async function request(path, payload, options={}) {
  const headers = payload === undefined ? {} : {'content-type':'application/json', ...(session ? {'x-csrf-token':session.csrf}:{}), ...options.headers};
  const response = await fetch(path, {method:payload === undefined ? 'GET':'POST', credentials:'same-origin', cache:'no-store', redirect:'error', headers, ...(payload === undefined ? {} : {body:JSON.stringify(payload)})});
  if (!response.ok) {
    const problem = await response.json().catch(() => ({}));
    if (response.status===401 && session) expire();
    throw new Error((descriptions[problem.code] ?? `Request failed (${response.status}).`) + (problem.request_id ? ` Reference: ${problem.request_id}` : ''));
  }
  if (response.headers.get('content-disposition')?.startsWith('attachment;')) {
    const blob=await response.blob(); const url=URL.createObjectURL(blob); const link=element('a'); link.href=url; link.download='stabbur-credential.json'; link.click(); setTimeout(() => URL.revokeObjectURL(url),1000);
    return {message:'Credential downloaded. Move it to protected storage; this value is shown only once.'};
  }
  return response.status===204 ? {message:'Completed'} : response.json();
}
function api(id, input={}) { return request(`/api/operation/${encodeURIComponent(id)}`,input); }
function showLogin() {
  root.replaceChildren(); const panel=element('main',null,'login'); panel.append(element('div','S','mark'),element('p','STABBUR','eyebrow'),element('h1','Your software.\nUnder control.'),element('p','Sign in with your Stabbur account to manage builds, releases and delivery.','muted'));
  const form=element('form'); const username=field(form,'Username','text'); username.autocomplete='username'; username.required=true;
  const password=field(form,'Password','password'); password.autocomplete='current-password'; password.required=true;
  const submit=element('button','Sign in','button primary'); submit.type='submit'; form.append(submit);
  form.addEventListener('submit',async event => { event.preventDefault(); submit.disabled=true; notice.textContent=''; const credentials={username:username.value,password:password.value}; password.value=''; try { establish(await request('/api/login',credentials,{headers:{'x-stabbur-login':'1'}})); renderShell(); await loadGroup(current); } catch(error) { showError(error); } finally { credentials.password=''; submit.disabled=false; } });
  panel.append(form,element('p','Credentials are exchanged directly by this console’s session server.','small muted')); root.append(panel); username.focus();
}
function field(parent,title,type='text',value='') { const wrapper=element('label',title,'field'); const input=element('input'); input.type=type; input.value=value; wrapper.append(input); parent.append(wrapper); return input; }
function renderShell() {
  root.replaceChildren(); const sidebar=element('aside',null,'sidebar'); const brand=element('div',null,'brand'); brand.append(element('span','S','mark'),element('span','Stabbur')); sidebar.append(brand,element('p','MANAGEMENT','eyebrow'));
  const nav=element('nav'); nav.setAttribute('aria-label','Management');
  for (const group of groups) { const item=button(group.title,() => loadGroup(group),'nav-item'); item.dataset.group=group.id; nav.append(item); }
  nav.append(button('Catalog plans',showCatalog,'nav-item')); sidebar.append(nav);
  const account=element('div',null,'account'); account.append(element('strong',session.name),element('small',session.roles.join(', ')),button('Sign out',async () => { await request('/api/logout',{}); expire(); },'link')); sidebar.append(account);
  const main=element('main',null,'main'); main.id='main'; root.append(sidebar,main);
}
function heading(title,description) { const main=document.querySelector('#main'); main.replaceChildren(); const head=element('header',null,'page-head'); const copy=element('div'); copy.append(element('p','WORKSPACE / '+title.toUpperCase(),'eyebrow'),element('h1',title),element('p',description,'muted')); head.append(copy); main.append(head); return {main,head}; }
async function loadGroup(group) {
  current=group; const requestGeneration=++generation;
  document.querySelectorAll('[data-group]').forEach(node => node.classList.toggle('active',node.dataset.group===group.id));
  const {main,head}=heading(group.title,group.description);
  const actions=element('div',null,'actions'); actions.append(button('Refresh',() => loadGroup(group),'button secondary'));
  if(group.create) actions.append(button('＋ '+label(group.create.replace('create_','').replace('provision_','')),() => operationForm(group.create),'button primary'));
  head.append(actions);
  const related=contract.operations.filter(op => group.tags.includes(op.tag) && !op.parameters.some(p=>p.in==='path') && op.id!==group.list && op.id!==group.create);
  if(related.length) { const menu=element('div',null,'toolbar'); for(const op of related) menu.append(button(label(op.id),()=>operationForm(op.id),'chip')); main.append(menu); }
  if(group.id==='software' || group.id==='workers') {
    const status=element('div',null,'metrics'); main.append(status);
    api('operational_status').then(value => { if(requestGeneration!==generation)return; for(const [key,title] of [['queued_jobs','Queued jobs'],['running_jobs','Running'],['failed_jobs','Failed'],['draining_workers','Draining workers']]) { const card=element('div',null,'metric'); card.append(element('strong',display(value[key])),element('span',title)); status.append(card); } }).catch(()=>status.remove());
  }
  const content=element('section',null,'panel'); content.append(element('p','Loading…','muted')); main.append(content);
  let cursor=null; const seen=new Set();
  async function page(append=false) {
    const operation=contract.operations.find(op=>op.id===group.list);
    const query=operation.parameters.some(p=>p.in==='query'&&p.name==='limit') ? {limit:'50', ...(cursor ? {cursor}:{})} : {};
    const value=decodePage(await api(group.list,{query})); if(requestGeneration!==generation)return;
    if(!append)content.replaceChildren(); content.querySelector('.load-more')?.remove();
    if(!value.items.length&&!append)content.append(element('div','No items yet. Create one to get started.','empty'));
    if(value.items.length)content.append(table(value.items,group.columns,item=>detail(group,item)));
    cursor=value.nextCursor;
    if(cursor) { if(seen.has(cursor))throw new Error('The server repeated a pagination cursor. Refresh this view.'); seen.add(cursor); const more=button('Load more',async()=>{more.disabled=true;try{await page(true);}finally{more.disabled=false;}},'button secondary load-more'); content.append(more); }
  }
  try { await page(); } catch(error) { content.replaceChildren(element('p',error.message,'error empty')); }
}
function table(items,columns,select) {
  const container=element('div',null,'table-wrap'); const table=element('table'); const thead=element('thead'); const head=element('tr'); for(const column of columns) head.append(element('th',label(column))); thead.append(head); table.append(thead); const body=element('tbody');
  for(const item of items) { const row=element('tr'); columns.forEach((column,index)=>{const cell=element('td'); if(index===0&&select)cell.append(button(display(item[column]),()=>select(item),'row-link')); else cell.append(element('span',display(item[column]),['state','enabled','draining'].includes(column)?'badge':''));row.append(cell);});body.append(row); }
  table.append(body);container.append(table);return container;
}
async function detail(group,item) {
  if(!group.key) { showResult(group.title,item); return; }
  const identity=String(item.id ?? item.name ?? item.slug); const params={[group.key]:identity};
  if(group.key==='channel'&&item.software_id)params.software=String(item.software_id);
  const value=group.get?await api(group.get,{parameters:params}):item;
  const body=openDialog(value.name ?? value.slug ?? group.title); renderValue(body,value);
  const actions=element('div',null,'detail-actions');
  const operations=contract.operations.filter(op=>op.id!==group.get && op.parameters.some(p=>p.in==='path'&&p.name===group.key));
  for(const op of operations) actions.append(button(label(op.id),()=>operationForm(op.id,params,op.parameters.filter(p=>p.in==='path').length===Object.keys(params).length?value.revision:undefined),'button secondary'));
  if(group.id==='software') actions.prepend(button('Delivery & build status',async()=>showResult('Software status',await api('software_status',{parameters:params})),'button primary'));
  body.append(actions);
}
function openDialog(title) { dialog.replaceChildren(); const head=element('div',null,'dialog-head'); const h=element('h2',title);h.id='dialog-title';head.append(h,button('Close',()=>dialog.close(),'link'));const body=element('div',null,'dialog-body');dialog.append(head,body);if(!dialog.open)dialog.showModal();return body; }
function renderValue(parent,value,onItem) {
  if(Array.isArray(value)) { if(value.some(item=>item===null||typeof item!=='object'||Array.isArray(item))){const list=element('ul');for(const item of value)list.append(element('li',display(item)));parent.append(list);return;} if(!value.length){parent.append(element('p','No items','muted'));return;} parent.append(table(value,Object.keys(object(value[0])).slice(0,6),onItem??(item=>showResult('Details',item)))); return; }
  if(value && typeof value==='object') {
    if(typeof value.digest==='string'&&/^[a-f0-9]{64}$/.test(value.digest)){const link=element('a','Download artifact','button secondary');link.href='/api/download/'+value.digest;link.download=value.digest;parent.append(link);}
    if(Array.isArray(value.items)) { if(value.items[0]?.message_base64){parent.append(element('pre',decodeLogs(value.items),'logs'));}else{renderValue(parent,value.items,onItem);} if(value.next_cursor)parent.append(element('p','More results are available. Use the cursor in the operation form: '+value.next_cursor,'small')); return; }
    const list=element('dl',null,'properties'); for(const [key,item] of Object.entries(value)) {list.append(element('dt',label(key)));const detail=element('dd');if(item&&typeof item==='object'){const disclosure=element('details');disclosure.append(element('summary',Array.isArray(item)?`${item.length} items`:label(item.kind??'Details')));const box=element('div');renderValue(box,item);disclosure.append(box);detail.append(disclosure);}else detail.textContent=display(item);list.append(detail);}parent.append(list);return;
  }
  parent.append(element('p',display(value)));
}
function showResult(title,value,sourceId){const body=openDialog(title);const resources={list_releases:{title:'Release',key:'release',get:'get_release'},list_channels:{title:'Channel',key:'channel',get:'get_channel'},list_api_tokens:{title:'API token',key:'token',get:null},list_recipe_revisions:{title:'Revision',key:'revision',get:null},list_build_target_runs:{title:'Run',key:'run',get:'get_run'},list_recipe_runs:{title:'Run',key:'run',get:'get_run'},list_jobs:{title:'Job',key:'job',get:'get_job'},list_recipe_catalog_scans:{title:'Catalog scan',key:'scan',get:'get_recipe_catalog_scan'},list_recipe_catalog_snapshots:{title:'Catalog snapshot',key:'snapshot',get:'get_recipe_catalog_snapshot'}};const resource=resources[sourceId];renderValue(body,value,resource?item=>detail(resource,item):undefined);}
function resolveSchema(schema){const value=schema?.$ref?{...(contract.schemas[schema.$ref.split('/').at(-1)]??{}),...schema}:schema??{};return {...value,type:Array.isArray(value.type)?value.type.find(type=>type!=='null'):value.type};}
function bodyFields(form,schema) {
  schema=resolveSchema(schema);
  if(!schema.properties){const box=element('label','Configuration (JSON)','field');const input=element('textarea');input.rows=12;input.value='{}';box.append(input);form.append(box);return ()=>JSON.parse(input.value);}
  const getters=[];
  for(const [name,raw] of Object.entries(schema.properties)) {
    const property=resolveSchema(raw);const required=schema.required?.includes(name);const wrapper=element('label',label(name)+(required?' *':''),'field');let input;
    if(property.enum){input=element('select');if(!required)input.append(new Option('Use default',''));for(const value of property.enum)input.append(new Option(label(value),value));}
    else if(property.type==='boolean'){input=element('select');if(!required)input.append(new Option('Use default',''));input.append(new Option('Yes','true'),new Option('No','false'));}
    else if(['object','array'].includes(property.type)||property.oneOf||property.anyOf||property.properties){input=element('textarea');input.rows=4;input.placeholder=property.type==='array'?'[]':'{}';}
    else{input=element('input');input.type=/password|secret/.test(name)?'password':property.type==='integer'||property.type==='number'?'number':'text';if(input.type==='password')input.autocomplete='new-password';if(property.minimum!=null)input.min=property.minimum;if(property.maximum!=null)input.max=property.maximum;}
    input.required=!!required;input.setAttribute('aria-label',label(name)+(required?' *':''));wrapper.append(input);if(property.description){const help=element('small',property.description,'muted');help.id='field-help-'+crypto.randomUUID();input.setAttribute('aria-describedby',help.id);wrapper.append(help);}form.append(wrapper);
    getters.push(()=>{if(input.value==='')return null;let value=input.value;if(input.tagName==='TEXTAREA')value=JSON.parse(value);else if(property.type==='boolean')value=value==='true';else if(property.type==='integer'||property.type==='number'){value=Number(value);if(!Number.isSafeInteger(value)&&property.type==='integer')throw new Error('Use an integer within the safe numeric range.');}return [name,value];});
  }
  return ()=>Object.fromEntries(getters.map(get=>get()).filter(Boolean));
}
function operationForm(id,parameters={},revision) {
  const operation=contract.operations.find(op=>op.id===id);if(!operation)throw new Error('Operation is unavailable in this contract.');
  const body=openDialog(label(id));const form=element('form');const input={parameters:{...parameters},query:{}};const getters=[];
  for(const parameter of operation.parameters){if(parameter.in==='path'||parameter.in==='query'){const value=field(form,label(parameter.name)+(parameter.required?' *':''),'text',parameters[parameter.name]??'');value.required=!!parameter.required;getters.push(()=>{if(value.value)input[parameter.in==='path'?'parameters':'query'][parameter.name]=value.value;});}
    else if(parameter.name.toLowerCase()==='if-match'){const value=field(form,'Current revision *','number',revision??'');value.required=true;value.min=id==='promote_channel'?'0':'1';if(id==='promote_channel')form.append(element('p','Use revision 0 to create a channel that does not yet exist.','small muted'));getters.push(()=>{input.revision=Number(value.value);if(!Number.isSafeInteger(input.revision)||input.revision<Number(value.min))throw new Error('A valid current revision is required.');});}
    else if(parameter.name.toLowerCase()==='idempotency-key'){input.idempotency_key=crypto.randomUUID();}}
  const getBody=operation.body?bodyFields(form,operation.body):null;
  const mutation=operation.method!=='get';
  if(mutation){const warning=element('p',operation.credential_download?'This creates a credential file. Protect the download and remove it from shared download folders.':'Review these values before applying. The server will check your permissions and reject stale revisions.','callout');form.append(warning);const labelNode=element('label',null,'confirm');const checkbox=element('input');checkbox.type='checkbox';checkbox.required=true;labelNode.append(checkbox,document.createTextNode(' I have reviewed this action.'));form.append(labelNode);}
  const submit=element('button',mutation?'Apply '+label(id).toLowerCase():'Show results','button primary');submit.type='submit';form.append(submit);
  form.addEventListener('submit',async event=>{event.preventDefault();submit.disabled=true;try{for(const get of getters)get();if(getBody)input.body=getBody();const result=await api(id,input);for(const password of form.querySelectorAll('input[type=password]'))password.value='';showResult(label(id),result,id);if(mutation)announce('Action completed.');}catch(error){showError(error);}finally{delete input.body;submit.disabled=false;}});body.append(form);
}
function showCatalog(){generation++;const {main}=heading('Catalog plans','Review software, pinned recipe revisions and recurring targets together.');const panel=element('section',null,'panel catalog');panel.append(element('h2','Review desired state'),element('p','Choose a catalog JSON file. Planning reads current state; applying requires the reviewed plan to remain current.','muted'));const file=field(panel,'Catalog file','file');file.accept='.json,application/json';let manifest;let plan;const results=element('div');const apply=button('Apply reviewed plan',async()=>{if(!manifest||!plan)throw new Error('Review a plan first.');if(!confirm('Apply this reviewed catalog plan, including any enabled recurring targets?'))return;apply.disabled=true;try{const result=await request('/api/catalog/apply',{manifest,plan});showResult('Catalog applied',result);plan=null;}finally{apply.disabled=!plan;}},'button primary');apply.disabled=true;
file.addEventListener('change',()=>{manifest=null;plan=null;apply.disabled=true;results.replaceChildren();});
const review=button('Generate plan',async()=>{const selected=file.files[0];if(!selected)throw new Error('Choose a catalog file.');if(selected.size>1024*1024)throw new Error('Catalog files must be at most 1 MiB.');manifest=object(JSON.parse(await selected.text()));plan=await request('/api/catalog/plan',{manifest});results.replaceChildren();renderValue(results,plan);apply.disabled=false;},'button secondary');panel.append(review,results,apply);main.append(panel);}
async function start(){try{contract=object(await (await fetch('/assets/contract.json',{cache:'no-store'})).json());if(!Array.isArray(contract.operations))throw new Error('Invalid console contract');try{establish(await request('/api/session'));renderShell();await loadGroup(current);}catch{showLogin();}}catch(error){root.replaceChildren(element('p','The console could not load its contract.','error'));showError(error);}}
start();
