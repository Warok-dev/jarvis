-- Anti-rejeu par nonce (remplace l'horodatage croissant de 0011, incompatible avec des requêtes
-- parallèles du PC) : chaque requête signée porte un identifiant aléatoire qui ne sert qu'une fois.
drop function if exists public.device_accept_ts(uuid, bigint);
drop function if exists jarvis_private.accept_device_ts(uuid, bigint);
alter table public.devices drop column if exists last_ts;

create table if not exists jarvis_private.device_nonces (
  device_id  uuid not null references public.devices (id) on delete cascade,
  nonce      text not null check (length(nonce) between 16 and 64),
  seen_at    timestamptz not null default now(),
  primary key (device_id, nonce)
);
create index if not exists device_nonces_seen on jarvis_private.device_nonces (seen_at);

-- Vrai si le nonce est nouveau (et l'enregistre) ; faux si déjà vu. Purge ce qui dépasse
-- la fenêtre de fraîcheur (les requêtes plus anciennes sont refusées de toute façon).
create or replace function public.device_accept_nonce(p_device uuid, p_nonce text) returns boolean
language plpgsql volatile security definer set search_path = '' as $$
declare inserted int;
begin
  delete from jarvis_private.device_nonces where seen_at < now() - interval '10 minutes';
  insert into jarvis_private.device_nonces (device_id, nonce) values (p_device, p_nonce)
  on conflict do nothing;
  get diagnostics inserted = row_count;
  return inserted = 1;
end $$;
revoke all on function public.device_accept_nonce(uuid, text) from public, anon, authenticated;
grant execute on function public.device_accept_nonce(uuid, text) to service_role;
