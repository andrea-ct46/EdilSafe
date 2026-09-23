import test from 'node:test';
import assert from 'node:assert/strict';
import { generateWithFallback } from '../supabase/functions/audit/provider.mjs';

test('primary overload switches to fallback without charging an extra audit', async () => {
  const calls=[];
  const out=await generateWithFallback({model:'primary',fallbackModel:'backup',options:{method:'POST'},delay:async()=>{},fetcher:async url=>{calls.push(url);return new Response('{}',{status:calls.length===1?503:200});}});
  assert.equal(out.model,'backup');assert.equal(calls.length,2);assert.ok(calls[1].includes('/backup:'));
});
test('invalid key/configuration never triggers fallback attempts', async () => {
  let calls=0;
  await assert.rejects(generateWithFallback({model:'primary',fallbackModel:'backup',options:{},delay:async()=>{},fetcher:async()=>{calls++;return new Response('{}',{status:403});}}),e=>e.code==='AI_PROVIDER_403');
  assert.equal(calls,1);
});
test('unavailable primary and fallback stop after three attempts', async () => {
  let calls=0;
  await assert.rejects(generateWithFallback({model:'primary',fallbackModel:'backup',options:{},delay:async()=>{},fetcher:async()=>{calls++;return new Response('{}',{status:503});}}),e=>e.code==='AI_PROVIDER_503');
  assert.equal(calls,3);
});
