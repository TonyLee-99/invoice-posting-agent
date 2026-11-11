-- Live sandbox finding (INC-16): requestids derived from local sequence numbers repeat after a database reset or
-- restore, and QBO answers a repeated requestid with its cached original response, even if that Bill was deleted.
-- Each installation gets a random namespace so its requestids never collide with another database's on one realm.
create table installation (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now()
);
insert into installation default values;

alter table recovery_queue drop constraint recovery_queue_kind_check;
alter table recovery_queue add constraint recovery_queue_kind_check check (kind in (
  'unknown_outcome', 'ambiguous_remote', 'remote_rejected', 'reconcile_mismatch', 'orphan_remote_bill', 'auth_failure',
  'requestid_collision'));
