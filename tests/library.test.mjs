import test from 'node:test';
import assert from 'node:assert/strict';
import {decodeLibrary,decodeCapabilityQueues,attentionReasons,createSelection,libraryParameters} from '../public/library.js';
import {restoredDefinition,snapshotDiff} from '../public/exports.js';
const row={id:'a',slug:'app',name:'App',channels:[],latest_run_id:'run',latest_run_state:'failed',review_release_id:null,review_count:0,blocked_targets:0,outstanding_runs:0};
test('attention distinguishes an unresolved failure from replacement work',()=>{
 assert.deepEqual(attentionReasons(row),['Latest check failed']);
 assert.deepEqual(attentionReasons({...row,outstanding_runs:1}),[]);
 assert.deepEqual(attentionReasons({...row,latest_run_state:'succeeded',review_count:1}),['1 release awaits review']);
 assert.throws(()=>decodeLibrary({items:[{...row,review_count:1}],next_cursor:null}));
 assert.throws(()=>decodeLibrary({items:[{...row,blocked_targets:-1}],next_cursor:null}));
 assert.equal(decodeLibrary({items:[row],next_cursor:'opaque'}).nextCursor,'opaque');
});
test('selection persists independent of fetched pages and cannot exceed the export limit',()=>{
 const selected=createSelection(2);selected.set(row,true);selected.set({...row,id:'b'},true);
 assert.throws(()=>selected.set({...row,id:'c'},true));assert.equal(selected.values().length,2);
 selected.set(row,false);selected.set({...row,id:'c'},true);assert.deepEqual(selected.values().map(r=>r.id),['b','c']);
 const values=selected.values();values.pop();assert.equal(selected.values().length,2);
 selected.clear();assert.equal(selected.values().length,0);
});
test('shared views preserve query semantics and reject unsupported filters',()=>{
 assert.deepEqual(libraryParameters('#/attention?q=release%2BZ&view=review&sort=newest',true),{q:'release+Z',view:'review',sort:'newest'});
 assert.equal(libraryParameters('#/attention',true).view,'attention');
 assert.equal(libraryParameters('#/software?view=invalid').view,'all');
});
test('restoration pins actual snapshot releases and preserves the destination',()=>{
 const item={software:'app',name:'App',release:'exact',version:'release-Z',digest:'a'.repeat(64),architectures:['aarch64'],settings:{format:'pkg'},minimum_macos:'13',maximum_macos:null};
 const current={name:'Staff',slug:'staff',catalog:'production',destination:'hosted',selections:[]};
 const restored=restoredDefinition(current,{items:[item,{...item,architectures:['x86_64']}]});
 assert.equal(restored.catalog,'production');assert.deepEqual(restored.selections[0].source,{kind:'release',release:'exact'});
 assert.deepEqual(restored.selections[0].architectures,['aarch64','x86_64']);
 assert.equal(current.selections.length,0);
 assert.throws(()=>restoredDefinition(current,{items:[item,{...item,release:'different'}]}));
 assert.equal(snapshotDiff([item],[{...item,digest:'b'.repeat(64)}])[0].changed,true);
 assert.equal(snapshotDiff([item],[{...item,minimum_macos:'14'}])[0].changed,true);
 assert.equal(snapshotDiff([item],[item])[0].changed,false);
});

test('queue observations validate counts and complete capability groups',()=>{
 const group={required_capabilities:['builder.autopkg','os.macos'],queued_jobs:3,matching_workers:2,workers_with_active_leases:1,oldest_queued_at:'2026-10-03T00:00:00Z'};
 assert.equal(decodeCapabilityQueues({capability_queues:[group]}).groups.length,1);
 assert.throws(()=>decodeCapabilityQueues({capability_queues:[{...group,workers_with_active_leases:3}]}));
 assert.throws(()=>decodeCapabilityQueues({capability_queues:[{...group,required_capabilities:'os.macos'}]}));
 assert.deepEqual(decodeCapabilityQueues({}),{groups:[],truncated:false});
});
