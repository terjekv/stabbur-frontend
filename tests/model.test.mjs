import {test} from 'node:test';
import assert from 'node:assert/strict';
import {decodeSession,decodePage,display} from '../public/model.js';
test('session decoder accepts only complete bounded session facts',()=>{
  const input={principal:{name:'admin',roles:['admin']},csrf:'A'.repeat(43),expires_at:'2026-09-01T12:00:00Z'};
  const session=decodeSession(input);assert.equal(session.name,'admin');assert.ok(Object.isFrozen(session));
  for(const bad of [{...input,csrf:'bad'},{...input,expires_at:'never'},{...input,principal:{name:'admin',roles:'admin'}}])assert.throws(()=>decodeSession(bad));
});
test('pages preserve opaque cursors and reject malformed envelopes',()=>{
  assert.deepEqual(decodePage({items:[{name:'a'}],next_cursor:'opaque'}),{items:[{name:'a'}],nextCursor:'opaque'});
  assert.throws(()=>decodePage({items:[],next_cursor:8}));assert.throws(()=>decodePage({items:[null]}));
});
test('display keeps malicious text literal for textContent rendering',()=>{
  assert.equal(display('<img src=x onerror=alert(1)>'),'<img src=x onerror=alert(1)>');
});
