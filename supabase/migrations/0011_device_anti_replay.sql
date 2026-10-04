-- Anti-rejeu des requêtes signées du PC : chaque horodatage doit être strictement croissant.
alter table public.devices add column if not exists last_ts bigint;

-- Accepte l'horodatage s'il est plus récent que le dernier vu (mise à jour atomique).
create or replace function jarvis_private.accept_device_ts(p_device uuid, p_ts bigint) returns boolean
language sql volatile set search_path = '' as $$
  with u as (
    update public.devices set last_ts = p_ts
    where id = p_device and (last_ts is null or last_ts < p_ts)
    returning 1
  )
  select exists (select 1 from u);
$$;
revoke all on function jarvis_private.accept_device_ts(uuid, bigint) from public, anon, authenticated;
grant usage on schema jarvis_private to service_role;
grant execute on function jarvis_private.accept_device_ts(uuid, bigint) to service_role;

-- Exposée au client serveur via une fonction publique réservée à service_role.
create or replace function public.device_accept_ts(p_device uuid, p_ts bigint) returns boolean
language sql volatile security definer set search_path = '' as $$
  select jarvis_private.accept_device_ts(p_device, p_ts);
$$;
revoke all on function public.device_accept_ts(uuid, bigint) from public, anon, authenticated;
grant execute on function public.device_accept_ts(uuid, bigint) to service_role;
