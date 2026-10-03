import test from 'node:test';
import assert from 'node:assert/strict';
import {decodeDelivery,nextStep} from '../public/delivery.js';
import {recipeChoice,starterSource} from '../public/recipe-model.js';

test('software journey gives an actionable next step for setup, failure, build and delivery',()=>{
 const target={id:'target',software_id:'app'};
 assert.equal(nextStep({channels:[]},[]).group,'discovery');
 assert.equal(nextStep({channels:[]},[target]).group,'targets');
 for(const state of ['queued','running','failed'])assert.equal(nextStep({channels:[],latest_run:{id:'run',state}},[target]).group,'runs');
 assert.equal(nextStep({channels:[],latest_run:{id:'run',state:'succeeded'}},[target]).group,'runs');
 assert.equal(nextStep({channels:[{name:'testing'}],latest_run:{state:'succeeded'}},[target]).group,'delivery');
});
test('delivery decoder rejects malformed publication identity and state',()=>{
 assert.equal(decodeDelivery({configured:false}).configured,false);
 const valid={configured:true,revision:1,url:'https://console.example/munki',entries:[{spec:{channel:'testing',software:'firefox'},version:'release-x',release:'opaque',digest:'a'.repeat(64),tested:false}]};
 assert.equal(decodeDelivery(valid).entries[0].version,'release-x');
 for(const revision of [-1,1.5,'1'])assert.throws(()=>decodeDelivery({...valid,revision}));
 assert.throws(()=>decodeDelivery({...valid,entries:[{...valid.entries[0],digest:'../../secret'}]}));
});
test('additional reviewed recipes require exactly the reviewed source closure',()=>{
 for(const identifier of ['com.github.autopkg.download.ThunderbirdSignedPkg','com.github.autopkg.download.VLC']){
  const entry={identifier,guidance:{name:identifier,purpose:'fetch_artifact'},import_sources:[starterSource]};
  const choice=recipeChoice(entry,{diagnostics:[]});assert.equal(choice.recommended,true);assert.equal(choice.outputs.version,'version');assert.equal(choice.outputs.artifact,'pathname');
  assert.equal(recipeChoice({...entry,import_sources:[{...starterSource,revision:'b'.repeat(40)}]},{diagnostics:[]}).recommended,false);
  assert.equal(recipeChoice(entry,{diagnostics:[{identifier,code:'parent_trust_required'}]}).selectable,false);
 }
 const chrome={identifier:'com.github.autopkg.download.googlechrome',guidance:{purpose:'fetch_artifact'},import_sources:[starterSource]};
 assert.equal(recipeChoice(chrome,{diagnostics:[]}).recommended,false,'Chrome root download recipe does not provide a version mapping');
});
