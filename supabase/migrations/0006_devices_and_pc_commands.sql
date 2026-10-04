-- Appareils (le PC d'abord) et commandes envoyées au PC.
--
-- Le PC n'utilise pas la session Supabase de l'utilisateur : il possède un secret d'appareil
-- (généré sur le PC, stocké dans le Gestionnaire d'identifiants Windows) avec lequel il signe
-- ses appels (HMAC). Le serveur s'en sert aussi pour signer les commandes et dériver le canal
-- temps réel privé du PC. Ce secret n'est lisible que par la clé secrète du serveur.

create table public.devices (
  id            uuid primary key,                 -- généré par le PC
  user_id       uuid not null references auth.users (id) on delete cascade,
  kind          text not null check (kind in ('desktop')),
  label         text,                             -- nom de l'ordinateur
  secret        text not null,                    -- base64url, 32 octets
  created_at    timestamptz not null default now(),
  last_seen_at  timestamptz                       -- battement de cœur du PC
);

alter table public.devices enable row level security;
create policy "voir ses appareils" on public.devices
  for select to authenticated using (user_id = (select auth.uid()));
create policy "retirer ses appareils" on public.devices
  for delete to authenticated using (user_id = (select auth.uid()));
-- Les apps voient leurs appareils mais jamais le secret ; seul le serveur écrit.
revoke all on public.devices from anon, authenticated;
grant select (id, user_id, kind, label, created_at, last_seen_at) on public.devices to authenticated;
grant delete on public.devices to authenticated;

-- PC considéré en ligne si son dernier battement date de moins de 3 minutes.
create function public.desktop_online(p_user uuid) returns boolean
language sql stable as $$
  select exists (
    select 1 from public.devices
    where user_id = p_user and kind = 'desktop' and last_seen_at > now() - interval '3 minutes'
  );
$$;

-- File de commandes pour le PC. Expiration courte : un PC qui sort de veille
-- n'exécute jamais une commande d'il y a une heure.
create table public.pc_commands (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references auth.users (id) on delete cascade,
  device_id    uuid not null references public.devices (id) on delete cascade,
  steps        jsonb not null,                  -- liste d'actions de la liste blanche
  summary      text not null,                   -- description lisible (« Ouvrir VS Code »)
  status       text not null default 'pending'
               check (status in ('pending', 'running', 'done', 'failed', 'rejected', 'expired')),
  result       text,
  created_at   timestamptz not null default now(),
  expires_at   timestamptz not null default now() + interval '2 minutes',
  finished_at  timestamptz
);

create index pc_commands_device_pending on public.pc_commands (device_id, created_at) where status in ('pending', 'running');

alter table public.pc_commands enable row level security;
create policy "voir ses commandes" on public.pc_commands
  for select to authenticated using (user_id = (select auth.uid()));
revoke insert, update, delete on public.pc_commands from anon, authenticated;
