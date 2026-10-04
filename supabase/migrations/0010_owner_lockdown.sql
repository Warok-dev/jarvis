-- Verrouillage : Jarvis n'a qu'un utilisateur. Même si un autre compte existait un jour
-- (inscriptions désactivées dans la config Auth), il ne pourrait rien lire ni écrire.

-- Propriétaire, dans un schéma non exposé par l'API.
create schema if not exists jarvis_private;
revoke all on schema jarvis_private from public, anon, authenticated;
create table if not exists jarvis_private.owner (
  user_id uuid primary key references auth.users (id) on delete cascade,
  singleton boolean not null default true unique check (singleton)
);
-- Le premier (et seul) compte du projet devient le propriétaire.
insert into jarvis_private.owner (user_id)
select id from auth.users order by created_at limit 1
on conflict do nothing;

create or replace function public.is_owner() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from jarvis_private.owner o where o.user_id = (select auth.uid()));
$$;
revoke all on function public.is_owner() from public, anon;
grant execute on function public.is_owner() to authenticated;

-- Politique restrictive sur chaque table : s'ajoute (ET) aux politiques existantes.
do $$
declare t text;
begin
  foreach t in array array['assignments', 'assignment_events', 'push_subscriptions', 'notifications', 'devices',
                           'pc_commands', 'study_preferences', 'busy_blocks', 'study_blocks', 'study_plan_runs']
  loop
    execute format('drop policy if exists "propriétaire uniquement" on public.%I', t);
    execute format('create policy "propriétaire uniquement" on public.%I as restrictive for all to authenticated '
                   'using ((select public.is_owner())) with check ((select public.is_owner()))', t);
  end loop;
end $$;

-- Privilèges : les visiteurs non connectés n'ont plus aucun droit sur les tables.
revoke all on all tables in schema public from anon;
revoke truncate, references, trigger on all tables in schema public from authenticated;
revoke usage, select on all sequences in schema public from anon, authenticated;
alter default privileges for role postgres in schema public revoke all on tables from anon;
alter default privileges for role postgres in schema public revoke all on functions from anon, public;

-- Fonctions : appelables seulement par qui en a besoin, chemin de recherche verrouillé.
revoke execute on function public.desktop_online(uuid) from public, anon;
grant execute on function public.desktop_online(uuid) to authenticated, service_role;
alter function public.desktop_online(uuid) set search_path = '';
create or replace function public.desktop_online(p_user uuid) returns boolean
language sql stable set search_path = '' as $$
  select exists (
    select 1 from public.devices
    where user_id = p_user and kind = 'desktop' and last_seen_at > now() - interval '3 minutes'
  );
$$;
alter function public.assignments_log_events() set search_path = '';
alter function public.assignments_before_update() set search_path = '';
revoke execute on function public.assignments_log_events(), public.assignments_before_update() from public, anon, authenticated;

-- Le trigger de journalisation, avec search_path vide, doit qualifier ses tables.
create or replace function public.assignments_log_events() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'INSERT' then
    insert into public.assignment_events (assignment_id, user_id, type, payload)
    values (new.id, new.user_id, 'created', jsonb_build_object('due_at', new.due_at));
    return new;
  end if;
  if new.due_at is distinct from old.due_at then
    insert into public.assignment_events (assignment_id, user_id, type, payload)
    values (new.id, new.user_id, 'due_changed', jsonb_build_object('from', old.due_at, 'to', new.due_at));
  end if;
  if new.status is distinct from old.status then
    insert into public.assignment_events (assignment_id, user_id, type, payload)
    values (new.id, new.user_id, 'status_changed',
            jsonb_build_object('from', old.status, 'to', new.status, 'by', new.status_changed_by));
  end if;
  if new.removed_at is not null and old.removed_at is null then
    insert into public.assignment_events (assignment_id, user_id, type) values (new.id, new.user_id, 'removed');
  elsif new.removed_at is null and old.removed_at is not null then
    insert into public.assignment_events (assignment_id, user_id, type) values (new.id, new.user_id, 'restored');
  end if;
  return new;
end $$;
revoke execute on function public.assignments_log_events() from public, anon, authenticated;

-- Valeurs bornées : abonnements push seulement vers les vrais services de notification.
alter table public.push_subscriptions
  add constraint ps_endpoint_push_service check (
    length(endpoint) <= 1024 and endpoint ~ '^https://(fcm\.googleapis\.com|web\.push\.apple\.com|[a-z0-9.-]+\.push\.services\.mozilla\.com|[a-z0-9.-]+\.notify\.windows\.com)/'),
  add constraint ps_keys_len check (length(p256dh) <= 200 and length(auth) <= 100 and coalesce(length(device_label), 0) <= 100);

-- Au plus 3 appareils abonnés (ton iPhone, et de la marge pour un navigateur).
create or replace function jarvis_private.limit_push_subscriptions() returns trigger
language plpgsql set search_path = '' as $$
begin
  if (select count(*) from public.push_subscriptions where user_id = new.user_id) >= 3 then
    raise exception 'Trop d''appareils abonnés aux notifications (3 au maximum).';
  end if;
  return new;
end $$;
drop trigger if exists limit_push_subscriptions on public.push_subscriptions;
create trigger limit_push_subscriptions before insert on public.push_subscriptions
  for each row execute function jarvis_private.limit_push_subscriptions();

alter table public.study_preferences
  add constraint prefs_ok check (jsonb_typeof(prefs) = 'object' and pg_column_size(prefs) <= 16384);

alter table public.assignments
  add constraint status_by_ok check (
    status_changed_by is null or status_changed_by ~ '^(voice-)?(desktop|mobile|web)$' or status_changed_by = 'worker');
