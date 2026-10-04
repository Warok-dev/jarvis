-- Étape 1 : suivi des devoirs.
-- Le worker écrit avec la clé secrète (contourne RLS) ; les apps ne peuvent
-- que lire leurs devoirs et changer le statut.

create table public.assignments (
  id                 uuid primary key default gen_random_uuid(),
  user_id            uuid not null references auth.users (id) on delete cascade,
  source             text not null check (source in ('brightspace_ical', 'mail', 'manual')),
  external_id        text not null,              -- UID iCal, id du mail, etc.
  course_code        text,
  course_name        text,
  term               text,                       -- ex. 2026-automne
  title              text not null,
  item_type          text not null default 'item' check (item_type in ('item', 'quiz', 'checklist')),
  due_at             timestamptz,
  description        text,
  url                text,
  status             text not null default 'todo' check (status in ('todo', 'in_progress', 'done')),
  status_changed_at  timestamptz,
  status_changed_by  text,                       -- 'desktop', 'mobile', 'voice', 'worker'
  removed_at         timestamptz,                -- disparu du flux (masqué ou supprimé par le prof)
  first_seen_at      timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  version            integer not null default 1,
  unique (user_id, source, external_id)
);

create index assignments_user_due on public.assignments (user_id, due_at) where removed_at is null;

-- Journal de tout ce qui arrive à un devoir : sert aux notifications et à l'historique.
create table public.assignment_events (
  id             bigint generated always as identity primary key,
  assignment_id  uuid not null references public.assignments (id) on delete cascade,
  user_id        uuid not null references auth.users (id) on delete cascade,
  type           text not null check (type in ('created', 'due_changed', 'status_changed', 'removed', 'restored')),
  payload        jsonb not null default '{}',
  created_at     timestamptz not null default now()
);

create index assignment_events_user_time on public.assignment_events (user_id, created_at desc);

-- Horodatage et version gérés par le serveur, jamais par les clients.
create function public.assignments_before_update() returns trigger
language plpgsql as $$
begin
  new.updated_at := now();
  new.version := old.version + 1;
  if new.status is distinct from old.status then
    new.status_changed_at := now();
  end if;
  return new;
end $$;

create trigger assignments_before_update
  before update on public.assignments
  for each row execute function public.assignments_before_update();

-- Journalisation automatique, quel que soit l'auteur du changement.
create function public.assignments_log_events() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    insert into assignment_events (assignment_id, user_id, type, payload)
    values (new.id, new.user_id, 'created', jsonb_build_object('due_at', new.due_at));
    return new;
  end if;

  if new.due_at is distinct from old.due_at then
    insert into assignment_events (assignment_id, user_id, type, payload)
    values (new.id, new.user_id, 'due_changed', jsonb_build_object('from', old.due_at, 'to', new.due_at));
  end if;
  if new.status is distinct from old.status then
    insert into assignment_events (assignment_id, user_id, type, payload)
    values (new.id, new.user_id, 'status_changed',
            jsonb_build_object('from', old.status, 'to', new.status, 'by', new.status_changed_by));
  end if;
  if new.removed_at is not null and old.removed_at is null then
    insert into assignment_events (assignment_id, user_id, type) values (new.id, new.user_id, 'removed');
  elsif new.removed_at is null and old.removed_at is not null then
    insert into assignment_events (assignment_id, user_id, type) values (new.id, new.user_id, 'restored');
  end if;
  return new;
end $$;

create trigger assignments_log_events
  after insert or update on public.assignments
  for each row execute function public.assignments_log_events();

-- Sécurité : chaque utilisateur ne voit que ses lignes.
alter table public.assignments enable row level security;
alter table public.assignment_events enable row level security;

create policy "lire ses devoirs" on public.assignments
  for select to authenticated using (user_id = (select auth.uid()));
create policy "changer le statut de ses devoirs" on public.assignments
  for update to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy "lire son journal" on public.assignment_events
  for select to authenticated using (user_id = (select auth.uid()));

-- Les apps ne peuvent modifier que le statut, pas les dates ni les titres.
revoke insert, update, delete on public.assignments from anon, authenticated;
grant update (status, status_changed_by) on public.assignments to authenticated;
revoke insert, update, delete on public.assignment_events from anon, authenticated;

-- Synchronisation en temps réel vers le PC et le téléphone.
alter publication supabase_realtime add table public.assignments;
