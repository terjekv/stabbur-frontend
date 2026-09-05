/** Runtime contracts at browser response boundaries. No secrets are persisted. */
export function object(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Unexpected server response');
  return value;
}
export function decodeSession(value) {
  const result = object(value); const principal = object(result.principal);
  if (typeof principal.name !== 'string' || !Array.isArray(principal.roles) || !principal.roles.every(role => typeof role === 'string') || typeof result.csrf !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(result.csrf) || !Number.isFinite(Date.parse(result.expires_at))) throw new Error('Unexpected session response');
  return Object.freeze({name: principal.name, roles: Object.freeze([...principal.roles]), csrf: result.csrf, expiresAt: result.expires_at});
}
export function decodePage(value) {
  if (Array.isArray(value)) return {items: value.map(object), nextCursor: null};
  const page = object(value);
  if (!Array.isArray(page.items) || (page.next_cursor != null && typeof page.next_cursor !== 'string')) throw new Error('Unexpected page response');
  return {items: page.items.map(object), nextCursor: page.next_cursor ?? null};
}
export function label(value) { return String(value).replaceAll('_', ' ').replace(/\b\w/g, char => char.toUpperCase()); }
export function display(value) {
  if (value == null) return '—';
  if (Array.isArray(value)) return value.map(display).join(', ');
  if (typeof value === 'object') return value.kind ? label(value.kind) : JSON.stringify(value);
  return String(value);
}
export function decodeLogs(items) {
  const decoder = new TextDecoder();
  return items.map(item => {
    if (typeof item.message_base64 !== 'string' || item.message_base64.length > 1500000) throw new Error('Unexpected log response');
    return decoder.decode(Uint8Array.from(atob(item.message_base64), char => char.charCodeAt(0)));
  }).join('');
}
export const groups = Object.freeze([
  {id:'software', title:'Software', description:'Published versions, channels and delivery readiness.', list:'list_software', create:'create_software', get:'get_software', key:'software', columns:['name','slug','revision'], tags:['software','releases']},
  {id:'targets', title:'Build targets', description:'Pinned recipes and recurring checks for your software.', list:'list_build_targets', create:'create_build_target', get:'get_build_target', key:'target', columns:['name','enabled','next_run_at','revision'], tags:['build-targets']},
  {id:'runs', title:'Runs', description:'Follow builds from queue to verified, immutable artifacts.', list:'list_runs', create:'create_run', get:'get_run', key:'run', columns:['id','state','created_at','completed_at'], tags:['runs','jobs']},
  {id:'recipes', title:'Recipes', description:'Versioned build instructions with reviewed source pins.', list:'list_recipes', create:'create_recipe', get:'get_recipe', key:'recipe', columns:['name','revision','created_at'], tags:['recipes','recipe-catalogs','recipe-catalog-scans']},
  {id:'workers', title:'Workers', description:'Capabilities, availability and graceful draining.', list:'list_workers', create:'provision_worker', get:'get_worker', key:'worker', columns:['name','enabled','draining','last_seen_at'], tags:['workers']},
  {id:'stores', title:'Storage', description:'Configured stores and immutable artifact locations.', list:'list_stores', get:'get_store', key:'store', columns:['name','role','enabled'], tags:['stores','artifacts']},
  {id:'access', title:'Access', description:'People, roles and revocable credentials.', list:'list_principals', create:'create_principal', get:'get_principal', key:'principal', columns:['name','kind','roles','enabled'], tags:['auth']},
  {id:'audit', title:'Audit history', description:'Append-only records of administrative decisions.', list:'list_audit_events', columns:['occurred_at','action','resource_kind','resource_id'], tags:['audit']},
]);
