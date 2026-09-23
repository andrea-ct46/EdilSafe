import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';

const a = '11111111-1111-4111-8111-111111111111', b = '22222222-2222-4222-8222-222222222222';
const db = new PGlite();
await db.exec(`
create role anon; create role authenticated; create role service_role bypassrls;
create schema auth; create schema storage;
grant usage on schema public,auth,storage to anon,authenticated,service_role;
create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
create function storage.foldername(text) returns text[] language sql immutable as $$select (string_to_array($1,'/'))[1:array_length(string_to_array($1,'/'),1)-1]$$;
create table auth.users(id uuid primary key);
create table public.profili(id uuid primary key references auth.users, nome_impresa text, email text, p_iva text, crediti integer default 3, piu_attivo boolean default false, scansioni_effettuate integer default 0);
create function public.gestisci_nuovo_utente() returns trigger language plpgsql security definer as $$begin return new; end$$;
create function public.rls_auto_enable() returns event_trigger language plpgsql security definer as $$begin return; end$$;
alter table public.profili enable row level security;
create policy "Permetti lettura profilo utente" on public.profili for select using(auth.uid()=id);
grant all on public.profili to anon,authenticated,service_role;
create table storage.objects(id uuid primary key default gen_random_uuid(), bucket_id text, name text, owner_id text);
alter table storage.objects enable row level security;
grant select,insert,delete on storage.objects to authenticated;
create policy "Isola eliminazione per impresa" on storage.objects for delete using(true);
create policy "Isola lettura per impresa" on storage.objects for select using(true);
create policy "Isola upload per impresa" on storage.objects for insert with check(true);
insert into auth.users values('${a}'),('${b}');
insert into public.profili(id,nome_impresa,piu_attivo) values('${a}','Stesso Nome',false),('${b}','Stesso Nome',true);
insert into storage.objects(bucket_id,name,owner_id) values('documenti-cantieri','Stesso_Nome/a.pdf','${a}'),('documenti-cantieri','Stesso_Nome/b.pdf','${b}');
`);
await db.exec(await readFile(new URL('../supabase/migrations/20260923120000_secure_audits.sql', import.meta.url), 'utf8'));
async function asUser(id, fn) {
  await db.exec(`begin; set local role authenticated; select set_config('request.jwt.claim.sub','${id}',true);`);
  try { return await fn(); } finally { await db.exec('rollback'); }
}
async function reserve() { return (await db.query('select public.reserve_audit($1,$2,$3) as job',[a,'test.pdf','Generico'])).rows[0].job; }
async function finish(id, error = null) { return (await db.query('select public.finish_audit($1,$2::jsonb,$3) as done',[id,error ? null : '{}',error])).rows[0].done; }

test('migration preserves existing profiles and files', async () => {
  assert.equal((await db.query('select count(*)::int as n from public.profili')).rows[0].n,2);
  assert.equal((await db.query('select count(*)::int as n from storage.objects')).rows[0].n,2);
});
test('same company name never grants access to another owner document', async () => {
  await asUser(a, async () => {
    assert.deepEqual((await db.query('select name from storage.objects')).rows.map(r=>r.name),['Stesso_Nome/a.pdf']);
    assert.equal((await db.query('delete from storage.objects where owner_id=$1 returning id',[b])).rows.length,0);
  });
});
test('client cannot edit plan/counter or invoke trusted RPCs', async () => {
  for (const sql of ["update public.profili set piu_attivo=true", "select public.reserve_audit(null,'x','x')", 'select public.finish_audit(null,null,null)']) {
    await assert.rejects(asUser(a, () => db.query(sql)), /permission denied/);
  }
});
test('Free user cannot upload, Plus owner can use UUID or legacy folder', async () => {
  await assert.rejects(asUser(a, () => db.query("insert into storage.objects(bucket_id,name,owner_id) values('documenti-cantieri',$1,$2)",[`${a}/test.pdf`,a])), /row-level security/);
  await asUser(b, async () => {
    await db.query("insert into storage.objects(bucket_id,name,owner_id) values('documenti-cantieri',$1,$2)",[`${b}/test.pdf`,b]);
    await db.query("insert into storage.objects(bucket_id,name,owner_id) values('documenti-cantieri',$1,$2)",['Stesso_Nome/test.pdf',b]);
  });
  await assert.rejects(asUser(b, () => db.query("insert into storage.objects(bucket_id,name,owner_id) values('documenti-cantieri',$1,$2)",[`${b}/test.pdf`,a])), /row-level security/);
});
test('reservation prevents overlapping jobs and stops at five completed Free audits', async () => {
  for (let i=0;i<5;i++) {
    const job=await reserve(); assert.ok(job.id);
    assert.equal((await reserve()).error,'AUDIT_BUSY');
    assert.equal(await finish(job.id),true);
  }
  assert.equal((await reserve()).error,'QUOTA_EXCEEDED');
  assert.equal((await db.query('select scansioni_effettuate as n from public.profili where id=$1',[a])).rows[0].n,5);
});
test('month reset, idempotent refunds, timeout recovery and private history', async () => {
  await db.query("update public.profili set scansioni_periodo='2020-01-01' where id=$1",[a]);
  const job = await reserve(); assert.ok(job.id);
  assert.equal(await finish(job.id,'AI_PROVIDER'),true);
  assert.equal(await finish(job.id,'AI_PROVIDER'),false);
  assert.equal((await db.query('select scansioni_effettuate as n from public.profili where id=$1',[a])).rows[0].n,0);
  const expired = await reserve();
  await db.query("update public.audit_runs set created_at=now()-interval '4 minutes' where id=$1",[expired.id]);
  const next = await reserve(); assert.ok(next.id);
  assert.equal((await db.query('select scansioni_effettuate as n from public.profili where id=$1',[a])).rows[0].n,1);
  assert.equal(await finish(expired.id),false);
  await asUser(b, async () => assert.equal((await db.query('select * from public.audit_runs')).rows.length,0));
});
test.after(async () => db.close());
