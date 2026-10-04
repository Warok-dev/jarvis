-- Lance la synchronisation Brightspace toutes les 30 minutes.
-- Prérequis : les secrets Vault « jarvis_sync_url » et « jarvis_cron_secret »
-- (générés dans supabase/.local/setup-cron.sql, jamais commités).

create extension if not exists pg_cron;
create extension if not exists pg_net;

select cron.schedule(
  'sync-brightspace',
  '*/30 * * * *',
  $$
  select net.http_post(
    url     := (select decrypted_secret from vault.decrypted_secrets where name = 'jarvis_sync_url'),
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'jarvis_cron_secret')
    ),
    body    := '{}'::jsonb,
    timeout_milliseconds := 60000
  );
  $$
);
