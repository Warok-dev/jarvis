-- Lance la fonction notify toutes les 5 minutes.
-- Prérequis : secret Vault « jarvis_notify_url » (créé par scripts/apply-cron-notify.ts) et « jarvis_cron_secret ».

select cron.schedule(
  'notify',
  '*/5 * * * *',
  $$
  select net.http_post(
    url     := (select decrypted_secret from vault.decrypted_secrets where name = 'jarvis_notify_url'),
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'jarvis_cron_secret')
    ),
    body    := '{}'::jsonb,
    timeout_milliseconds := 60000
  );
  $$
);
