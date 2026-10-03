import test from 'node:test';
import assert from 'node:assert/strict';
import {decodeExport,decodeExportPlan,defaultSelection,sameExportDefinition,decodeExportSnapshot} from '../public/exports.js';

test('saved definitions preserve exact pins and keep display text literal',()=>{
 const raw={id:'export',revision:1,generation:0,definition:{slug:'staff',name:'<img src=x onerror=alert(1)>',catalog:'production',destination:'hosted',selections:[{software:'app',source:{kind:'release',release:'opaque-id'},architectures:[],settings:null}]}};
 assert.equal(decodeExport(raw).definition.selections[0].source.release,'opaque-id');
 assert.equal(decodeExport(raw).definition.name,raw.definition.name);
 for(const changed of[{generation:-1},{revision:0},{definition:{...raw.definition,destination:'arbitrary-url'}}])assert.throws(()=>decodeExport({...raw,...changed}));
});
test('blocked preview cannot be accepted as ready and versions are opaque',()=>{
 const change={name:'App',action:'update',before:['2026.preview-9'],after:['release-Z'],detail:null};
 const plan={export:'export',fingerprint:'a'.repeat(64),ready:true,changes:[change],items:[]};
 assert.equal(decodeExportPlan(plan).changes[0].after[0],'release-Z');
 assert.throws(()=>decodeExportPlan({...plan,changes:[{...change,action:'blocked'}]}));
 assert.throws(()=>decodeExportPlan({...plan,fingerprint:'../../secret'}));
});
test('selection reuses library installation settings without inventing detection',()=>{
 assert.equal(defaultSelection({id:'new'}).settings,null);
 const selected=defaultSelection({id:'firefox',installation:{install:{stabbur_munki:{format:'pkg',application:'Firefox.app',bundle_id:'org.mozilla.firefox'}}}});
 assert.deepEqual(selected.source,{kind:'channel',channel:'testing'});
 assert.deepEqual(selected.settings.detection,{kind:'application',name:'Firefox.app',bundle_id:'org.mozilla.firefox'});
});

test('unchanged preview preserves its revision while selection changes still save',()=>{
 const original={name:'Staff',slug:'staff',catalog:'managed',destination:'hosted',selections:[{software:'a',source:{kind:'channel',channel:'testing'},architectures:[],settings:null},{software:'b',source:{kind:'release',release:'exact'},architectures:[],settings:null}]};
 assert(sameExportDefinition(original,{...original,selections:[...original.selections].reverse()}));
 assert(!sameExportDefinition(original,{...original,catalog:'production'}));
 assert(!sameExportDefinition(original,{...original,selections:original.selections.slice(1)}));
});
test('published versions retain withdrawn entries as unavailable history',()=>{
 const raw={snapshot:{generation:1,definition:{destination:'hosted',catalog:'managed'},items:[{name:'App',version:'release-Z',release:'id',architectures:['aarch64']}]},unavailable_releases:['id']};
 assert.equal(decodeExportSnapshot(raw).snapshot.items[0].version,'release-Z');
 assert.throws(()=>decodeExportSnapshot({...raw,snapshot:{...raw.snapshot,generation:0}}));
});
