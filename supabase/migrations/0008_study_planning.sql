-- Planning de révision.

-- Durée estimée par l'utilisateur (sinon : estimation automatique selon le titre).
alter table public.assignments add column estimated_minutes integer check (estimated_minutes between 5 and 3000);
grant update (estimated_minutes) on public.assignments to authenticated;

-- Disponibilités et réglages (null = valeurs par défaut du planificateur).
create table public.study_preferences (
  user_id     uuid primary key references auth.users (id) on delete cascade,
  prefs       jsonb not null,
  updated_at  timestamptz not null default now()
);
alter table public.study_preferences enable row level security;
create policy "gérer ses préférences" on public.study_preferences
  for all to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

-- Créneaux occupés (cours importés depuis l'horaire uOttawa, plus tard autres calendriers).
create table public.busy_blocks (
  id           bigint generated always as identity primary key,
  user_id      uuid not null references auth.users (id) on delete cascade,
  source       text not null check (source in ('timetable', 'manual')),
  external_id  text not null,
  title        text,
  starts_at    timestamptz not null,
  ends_at      timestamptz not null check (ends_at > starts_at),
  unique (user_id, source, external_id)
);
create index busy_blocks_user_time on public.busy_blocks (user_id, starts_at);
alter table public.busy_blocks enable row level security;
create policy "lire ses créneaux occupés" on public.busy_blocks
  for select to authenticated using (user_id = (select auth.uid()));
revoke insert, update, delete on public.busy_blocks from anon, authenticated;

-- Blocs de travail proposés par le planificateur (recalculés, jamais modifiés à la main).
create table public.study_blocks (
  id             bigint generated always as identity primary key,
  user_id        uuid not null references auth.users (id) on delete cascade,
  assignment_id  uuid not null references public.assignments (id) on delete cascade,
  starts_at      timestamptz not null,
  ends_at        timestamptz not null,
  created_at     timestamptz not null default now()
);
create index study_blocks_user_time on public.study_blocks (user_id, starts_at);
alter table public.study_blocks enable row level security;
create policy "lire son planning" on public.study_blocks
  for select to authenticated using (user_id = (select auth.uid()));
revoke insert, update, delete on public.study_blocks from anon, authenticated;

-- Dernier calcul : quand, et ce qui n'a pas pu être placé avant l'échéance.
create table public.study_plan_runs (
  user_id      uuid primary key references auth.users (id) on delete cascade,
  computed_at  timestamptz not null default now(),
  unscheduled  jsonb not null default '[]'
);
alter table public.study_plan_runs enable row level security;
create policy "lire son dernier calcul" on public.study_plan_runs
  for select to authenticated using (user_id = (select auth.uid()));
revoke insert, update, delete on public.study_plan_runs from anon, authenticated;
