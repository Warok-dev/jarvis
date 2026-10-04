-- Recalcule le planning chaque matin (10 h 30 UTC : 6 h 30 l'été, 5 h 30 l'hiver à Toronto).
-- Prérequis : secret Vault « jarvis_plan_url » (scripts/apply-cron-plan.ts) et « jarvis_cron_secret ».
select cron.schedule(
  'plan',
  '30 10 * * *',
  $$
  select net.http_post(
    url     := (select decrypted_secret from vault.decrypted_secrets where name = 'jarvis_plan_url'),
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'jarvis_cron_secret')
    ),
    body    := '{}'::jsonb,
    timeout_milliseconds := 60000
  );
  $$
);
