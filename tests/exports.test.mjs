import test from 'node:test';
import assert from 'node:assert/strict';
import {decodeExport,decodeExportPlan,defaultSelection} from '../public/exports.js';

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
