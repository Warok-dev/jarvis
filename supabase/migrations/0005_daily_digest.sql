-- Récap du matin (8 h, heure de Toronto).
alter table public.notifications drop constraint notifications_kind_check;
alter table public.notifications add constraint notifications_kind_check
  check (kind in ('new_assignment', 'due_changed', 'reminder_24h', 'reminder_3h', 'daily_digest', 'skipped'));
