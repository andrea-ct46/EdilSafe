import test from 'node:test';
import assert from 'node:assert/strict';
import {readCompany, companyFolder} from '../supabase/functions/audit/company.mjs';
const raw={identificazione:'CERTA',nome:'Alfa Srl',identificativo_fiscale:'IT12345678901',evidenza:'Pagina 1: impresa Alfa'};
test('same tax identity reuses folder across name variations and paginated lists',async()=>{
  const storage={list:async(owner,{offset})=>({data:offset===0?Array.from({length:100},(_,i)=>({name:`Company_${i}`,id:null})):[{name:'ALFA_COSTRUZIONI__12345678901',id:null}]})};
  assert.equal(await companyFolder(readCompany(raw),storage,'owner'),'ALFA_COSTRUZIONI__12345678901');
});
test('ambiguous and unsupported identities stay unclassified; folder paths cannot traverse',async()=>{
  assert.equal(readCompany({...raw,identificazione:'INCERTA'}),null);
  assert.equal(readCompany({...raw,evidenza:''}),null);
  assert.equal(await companyFolder(null,{},'owner'),'Da_classificare');
  const company=readCompany({...raw,nome:'../Alfà / Srl',identificativo_fiscale:''});
  assert.equal(await companyFolder(company,{},'owner'),'ALFA_SRL');
});
