import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parseHTML } from 'linkedom';
const html=await readFile(new URL('../index.html',import.meta.url),'utf8');
const {window, document}=parseHTML(html);
globalThis.window=window; globalThis.document=document;
globalThis.alert=()=>{}; globalThis.confirm=()=>false;
let authChange;
const client={auth:{onAuthStateChange(cb){authChange=cb;},getSession:async()=>({data:{session:{access_token:'test',user:{id:'user-1'}}}}),signOut:async()=>{authChange('SIGNED_OUT');return {};}},from(table){return {select(){return this;},eq(){return this;},single:async()=>({data:{piu_attivo:false,scansioni_effettuate:0,scansioni_periodo:new Date().toISOString().slice(0,7)+'-01'}}),order(){return this;},limit:async()=>({data:[]})};}};
window.supabase={createClient:()=>client};
const hostile='<img src=x onerror=alert(1)>';
let requests=0;
globalThis.fetch=async()=>{requests++;return new Response(JSON.stringify({stato_generale:'DA_VERIFICARE',controlli:[{documento:hostile,stato:'GIALLO',dettaglio:hostile}],email_sollecito:'Email generata',warnings:[]}));};
await import('../assets/app.js');
const $=id=>document.getElementById(id);
const wait=async fn=>{for(let i=0;i<100;i++){if(fn())return;await new Promise(r=>setTimeout(r,10));}throw Error('UI timeout');};
test('HTML loads the module without stray scripts and displays authenticated dashboard',()=>{
  assert.equal(document.querySelectorAll('script[type="module"]').length,1);
  assert.ok(!html.includes('String.fromCharCode(...new Uint8Array'));
  assert.equal($('dashboardView').classList.contains('hidden'),false);
});
test('real UI batch displays individual failures, escaped text and generated email',async()=>{
  Object.defineProperty($('fileInput'),'files',{value:[new File(['bad'],'bad.pdf'),new File(['%PDF-1.7\nfixture'],'good.pdf')],configurable:true});
  $('fileInput').dispatchEvent(new window.Event('change'));
  $('btnAnalyze').click();
  assert.equal($('btnAnalyze').disabled,true);
  await wait(()=>$('loading').classList.contains('hidden'));
  assert.equal(requests,1); assert.equal($('btnAnalyze').disabled,false);
  assert.match($('statusBanner').textContent,/1 analizzati.*1 non riusciti/);
  assert.match($('checkList').textContent,/bad.pdf/); assert.ok($('checkList').textContent.includes(hostile));
  assert.equal($('checkList').querySelector('img'),null);
  assert.match($('emailBox').value,/Email generata/);
});
test('sign out clears reports and history',async()=>{
  $('btnLogout').click();await wait(()=>$('dashboardView').classList.contains('hidden'));
  assert.equal($('checkList').textContent,'');assert.equal($('emailBox').value,'');assert.equal($('historyList').textContent,'');
});
