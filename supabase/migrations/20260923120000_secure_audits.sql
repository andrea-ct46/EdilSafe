-- Preserve existing profiles, counters and files. No document is moved or deleted.
alter table public.profili add column if not exists scansioni_periodo date not null
  default date_trunc('month', timezone('UTC', now()))::date;
alter table public.profili enable row level security;
revoke all on public.profili from anon, authenticated;
grant select on public.profili to authenticated;

alter function public.gestisci_nuovo_utente() set search_path = '';
revoke execute on function public.gestisci_nuovo_utente() from public, anon, authenticated;
revoke execute on function public.rls_auto_enable() from public, anon, authenticated;

create table public.audit_runs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  period date not null,
  status text not null check (status in ('running','completed','failed')),
  created_at timestamptz not null default now(),
  finished_at timestamptz,
  file_name text not null,
  context_type text not null,
  result jsonb,
  error_code text
);
alter table public.audit_runs enable row level security;
revoke all on public.audit_runs from public, anon, authenticated;
grant select on public.audit_runs to authenticated;
grant all on public.audit_runs to service_role;
create policy audit_runs_read_own on public.audit_runs for select to authenticated
  using (user_id = (select auth.uid()));
create index audit_runs_user_created_idx on public.audit_runs(user_id, created_at desc);

create function public.reserve_audit(p_user_id uuid, p_file_name text, p_context_type text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  profile public.profili%rowtype;
  current_period date := date_trunc('month', timezone('UTC', now()))::date;
  expired_count integer;
  job_id uuid;
begin
  select * into profile from public.profili where id = p_user_id for update;
  if not found then return jsonb_build_object('error','PROFILE_MISSING'); end if;
  if profile.scansioni_periodo <> current_period then
    update public.profili set scansioni_periodo=current_period, scansioni_effettuate=0 where id=p_user_id;
    profile.scansioni_effettuate := 0;
  end if;
  with expired as (
    update public.audit_runs set status='failed', finished_at=now(), error_code='TIMEOUT'
    where user_id=p_user_id and status='running' and created_at < now() - interval '3 minutes'
    returning period
  ) select count(*) filter(where period=current_period) into expired_count from expired;
  if expired_count > 0 then
    update public.profili set scansioni_effettuate=greatest(0, coalesce(scansioni_effettuate,0)-expired_count)
    where id=p_user_id returning scansioni_effettuate into profile.scansioni_effettuate;
  end if;
  if exists(select 1 from public.audit_runs where user_id=p_user_id and status='running') then
    return jsonb_build_object('error','AUDIT_BUSY');
  end if;
  if not coalesce(profile.piu_attivo,false) and coalesce(profile.scansioni_effettuate,0)>=5 then
    return jsonb_build_object('error','QUOTA_EXCEEDED');
  end if;
  insert into public.audit_runs(user_id,period,status,file_name,context_type)
    values(p_user_id,current_period,'running',left(p_file_name,255),left(p_context_type,200)) returning id into job_id;
  update public.profili set scansioni_effettuate=coalesce(scansioni_effettuate,0)+1 where id=p_user_id;
  return jsonb_build_object('id',job_id,'is_plus',coalesce(profile.piu_attivo,false),'nome_impresa',profile.nome_impresa);
end;
$$;

create function public.finish_audit(p_audit_id uuid, p_result jsonb, p_error_code text default null)
returns boolean language plpgsql security definer set search_path = '' as $$
declare job public.audit_runs%rowtype;
begin
  select * into job from public.audit_runs where id=p_audit_id;
  if not found then return false; end if;
  -- Always lock profile before job, matching reserve_audit's lock order.
  perform 1 from public.profili where id=job.user_id for update;
  select * into job from public.audit_runs where id=p_audit_id for update;
  if job.status <> 'running' then return false; end if;
  update public.audit_runs set status=case when p_error_code is null then 'completed' else 'failed' end,
    finished_at=now(), result=p_result, error_code=p_error_code where id=p_audit_id;
  if p_error_code is not null then
    update public.profili set scansioni_effettuate=greatest(0,coalesce(scansioni_effettuate,0)-1)
      where id=job.user_id and scansioni_periodo=job.period;
  end if;
  return true;
end;
$$;
revoke all on function public.reserve_audit(uuid,text,text) from public, anon, authenticated;
revoke all on function public.finish_audit(uuid,jsonb,text) from public, anon, authenticated;
grant execute on function public.reserve_audit(uuid,text,text) to service_role;
grant execute on function public.finish_audit(uuid,jsonb,text) to service_role;

drop policy "Isola eliminazione per impresa" on storage.objects;
drop policy "Isola lettura per impresa" on storage.objects;
drop policy "Isola upload per impresa" on storage.objects;
create policy edil_documents_read_own on storage.objects for select to authenticated
  using (bucket_id='documenti-cantieri' and owner_id=(select auth.uid())::text);
create policy edil_documents_delete_own on storage.objects for delete to authenticated
  using (bucket_id='documenti-cantieri' and owner_id=(select auth.uid())::text);
create policy edil_documents_insert_own on storage.objects for insert to authenticated
  with check (bucket_id='documenti-cantieri' and owner_id=(select auth.uid())::text
    and exists(select 1 from public.profili where id=(select auth.uid()) and piu_attivo=true)
    and ((storage.foldername(name))[1]=(select auth.uid())::text
      or (storage.foldername(name))[1]=(select regexp_replace(coalesce(nullif(nome_impresa,''),'Impresa_Generica'),'[^a-zA-Z0-9]','_','g') from public.profili where id=(select auth.uid()))));
