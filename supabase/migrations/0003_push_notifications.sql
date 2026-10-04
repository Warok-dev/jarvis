-- Notifications push (Web Push, y compris l'app installée sur iPhone).

-- Un abonnement par appareil/navigateur. Créé par l'app, utilisé par la fonction notify.
create table public.push_subscriptions (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null references auth.users (id) on delete cascade,
  endpoint         text not null unique,
  p256dh           text not null,
  auth             text not null,
  device_label     text,
  created_at       timestamptz not null default now(),
  last_success_at  timestamptz,
  failure_count    integer not null default 0
);

alter table public.push_subscriptions enable row level security;
create policy "gérer ses abonnements" on public.push_subscriptions
  for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
revoke update on public.push_subscriptions from anon, authenticated;

-- Historique des notifications. dedup_key garantit qu'une même notification
-- (nouveau devoir, rappel J-1 pour une échéance donnée…) n'est créée qu'une fois.
create table public.notifications (
  id             bigint generated always as identity primary key,
  user_id        uuid not null references auth.users (id) on delete cascade,
  dedup_key      text not null,
  kind           text not null check (kind in ('new_assignment', 'due_changed', 'reminder_24h', 'reminder_3h', 'skipped')),
  assignment_id  uuid references public.assignments (id) on delete cascade,
  title          text,
  body           text,
  url            text,
  created_at     timestamptz not null default now(),
  sent_at        timestamptz,
  unique (user_id, dedup_key)
);

create index notifications_user_time on public.notifications (user_id, created_at desc);

alter table public.notifications enable row level security;
create policy "lire ses notifications" on public.notifications
  for select to authenticated using (user_id = (select auth.uid()));
revoke insert, update, delete on public.notifications from anon, authenticated;

-- Les devoirs déjà connus avant cette migration ne doivent pas déclencher
-- une rafale de « nouveau devoir » au premier passage.
insert into public.notifications (user_id, dedup_key, kind, assignment_id)
select user_id, 'event:' || id, 'skipped', assignment_id
from public.assignment_events
on conflict do nothing;
