-- Core schema for the posting service. Money columns are integer minor units (bigint).

create table vendors (
  vendor_id text primary key,
  name text not null,
  aliases jsonb not null default '[]',
  tax_id text,
  qbo_vendor_id text not null,
  currency text not null,
  expense_account_ref text not null default '7'
);

create table purchase_orders (
  po_number text primary key,
  vendor_id text not null references vendors,
  currency text not null,
  kind text not null check (kind in ('goods', 'services')),
  status text not null check (status in ('open', 'closed')),
  tax_rate numeric,
  freight_allowance_minor bigint not null default 0,
  lines jsonb not null
);

create table goods_receipts (
  gr_number text primary key,
  po_number text not null references purchase_orders,
  received_at date not null,
  lines jsonb not null
);

create table invoice_statuses (status text primary key);
insert into invoice_statuses values
  ('RECEIVED'), ('PARSED'), ('EXTRACTED'), ('MATCHED'), ('AUTO_APPROVED'), ('NEEDS_REVIEW'), ('APPROVED'),
  ('REJECTED'), ('POSTING'), ('POSTED'), ('RECONCILED'), ('RECOVERY');

-- Legal status transitions; a trigger rejects anything else, so a code bug cannot skip a state.
create table invoice_transitions (
  from_status text references invoice_statuses,
  to_status text references invoice_statuses,
  primary key (from_status, to_status)
);
insert into invoice_transitions values
  ('RECEIVED', 'PARSED'), ('PARSED', 'EXTRACTED'), ('RECEIVED', 'EXTRACTED'), ('EXTRACTED', 'MATCHED'),
  ('MATCHED', 'AUTO_APPROVED'), ('MATCHED', 'NEEDS_REVIEW'), ('MATCHED', 'REJECTED'),
  ('NEEDS_REVIEW', 'APPROVED'), ('NEEDS_REVIEW', 'REJECTED'),
  -- edits send the invoice back through matching
  ('EXTRACTED', 'MATCHED'), ('MATCHED', 'MATCHED'), ('NEEDS_REVIEW', 'MATCHED'), ('AUTO_APPROVED', 'MATCHED'),
  ('APPROVED', 'MATCHED'), ('REJECTED', 'MATCHED'),
  ('AUTO_APPROVED', 'POSTING'), ('APPROVED', 'POSTING'),
  ('POSTING', 'POSTED'), ('POSTING', 'RECOVERY'),
  ('POSTED', 'RECONCILED'), ('POSTED', 'RECOVERY'), ('RECONCILED', 'RECOVERY'), ('RECONCILED', 'RECONCILED'),
  ('RECOVERY', 'POSTED'), ('RECOVERY', 'POSTING'), ('RECOVERY', 'REJECTED'), ('RECOVERY', 'RECONCILED')
on conflict do nothing;

create table invoices (
  id bigserial primary key,
  source_sha256 text,
  source_name text,
  source_mime text,
  parsed_text text,
  extracted jsonb,
  extraction_meta jsonb,
  fields jsonb not null,
  content_hash text not null,
  version int not null default 1,
  status text not null references invoice_statuses,
  vendor_id text references vendors,
  invoice_number_norm text,
  match jsonb,
  decision text,
  explanation jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
-- Duplicate-invoice guard: one live invoice per vendor + normalized number.
create unique index invoices_vendor_number_uniq on invoices (vendor_id, invoice_number_norm)
  where status <> 'REJECTED' and vendor_id is not null and invoice_number_norm is not null and invoice_number_norm <> '';

create function check_invoice_transition() returns trigger language plpgsql as $$
begin
  if new.status is distinct from old.status then
    if not exists (select 1 from invoice_transitions where from_status = old.status and to_status = new.status) then
      raise exception 'illegal invoice transition % -> %', old.status, new.status using errcode = 'P0001';
    end if;
  end if;
  new.updated_at := now();
  return new;
end $$;
create trigger invoices_transition before update on invoices for each row execute function check_invoice_transition();

create table approvals (
  id bigserial primary key,
  invoice_id bigint not null references invoices,
  approved_content_hash text not null,
  approved_version int not null,
  approver text not null,
  created_at timestamptz not null default now(),
  voided_at timestamptz,
  void_reason text
);
create unique index approvals_one_valid on approvals (invoice_id) where voided_at is null;

create table po_line_reservations (
  invoice_id bigint not null references invoices,
  approval_id bigint not null references approvals,
  po_number text not null references purchase_orders,
  line_no int not null,
  quantity numeric not null,
  active boolean not null default true,
  primary key (approval_id, po_number, line_no)
);

create table outbox (
  id bigserial primary key,
  invoice_id bigint not null references invoices,
  approval_id bigint not null unique references approvals,
  kind text not null default 'post_bill',
  idempotency_key text not null unique,
  request_id text not null unique,
  realm_id text not null,
  doc_number text not null,
  vendor_ref text not null,
  payload text not null,          -- exact bytes sent to QBO; never recomputed
  payload_hash text not null,
  status text not null check (status in ('pending', 'in_flight', 'done', 'cancelled', 'dead')),
  attempts int not null default 0,
  claim_gen int not null default 0,
  available_at timestamptz not null default now(),
  lease_owner text,
  lease_until timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index outbox_one_live_per_invoice on outbox (invoice_id) where status in ('pending', 'in_flight');
create index outbox_claimable on outbox (available_at) where status in ('pending', 'in_flight');

create table post_attempts (
  id bigserial primary key,
  outbox_id bigint not null references outbox,
  attempt_no int not null,
  claim_gen int not null,
  worker text not null,
  request_id text not null,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  outcome text check (outcome in ('created', 'adopted', 'unknown', 'query_failed', 'rejected', 'throttled', 'auth_failed', 'ambiguous', 'released')),
  remote_bill_id text,
  http_status int,
  error text
);

create table postings (
  invoice_id bigint primary key references invoices,
  outbox_id bigint not null references outbox,
  realm_id text not null,
  bill_id text not null,
  doc_number text not null,
  vendor_ref text not null,
  total_minor bigint not null,
  currency text not null,
  payload_hash text not null,
  adopted boolean not null default false,
  posted_at timestamptz not null default now(),
  -- A Bill deleted in QBO and acknowledged by a person keeps its history row but is no longer live.
  voided_at timestamptz,
  void_reason text,
  unique (realm_id, bill_id)
);

create table recovery_queue (
  id bigserial primary key,
  invoice_id bigint references invoices,
  outbox_id bigint references outbox,
  bill_id text,
  kind text not null check (kind in ('unknown_outcome', 'ambiguous_remote', 'remote_rejected', 'reconcile_mismatch', 'orphan_remote_bill', 'auth_failure')),
  detail jsonb not null default '{}',
  opened_at timestamptz not null default now(),
  resolved_at timestamptz,
  resolution text,
  resolved_by text,
  evidence jsonb
);
create unique index recovery_one_open on recovery_queue (coalesce(invoice_id, 0), coalesce(bill_id, ''), kind) where resolved_at is null;

create table audit_log (
  id bigserial primary key,
  at timestamptz not null default now(),
  actor text not null,
  invoice_id bigint references invoices,
  action text not null,
  from_status text,
  to_status text,
  detail jsonb not null default '{}'
);
create index audit_by_invoice on audit_log (invoice_id, id);

create table qbo_tokens (
  id int primary key default 1 check (id = 1),
  tokens jsonb not null,
  version int not null
);

create table reconciliation_runs (
  id bigserial primary key,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  status text not null default 'running' check (status in ('running', 'complete', 'partial')),
  checkpoint int not null default 0,
  counts jsonb not null default '{}'
);
