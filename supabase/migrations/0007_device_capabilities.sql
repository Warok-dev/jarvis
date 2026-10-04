-- Ce que le PC annonce à chaque battement : apps ouvrables (identifiant + nom) et
-- autorisation des commandes à distance (interrupteur dans le menu de Jarvis).
alter table public.devices
  add column apps jsonb not null default '[]',
  add column remote_enabled boolean not null default false;

grant select (apps, remote_enabled) on public.devices to authenticated;
