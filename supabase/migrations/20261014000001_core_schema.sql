-- Ammar Academy CRM · Phase 2 · core schema
-- Contact → Inquiry chain, activity timeline, follow-ups, custom fields,
-- reference data, personal preferences, notifications and audit history.
-- Payments, support onboarding, shifts and Google Sheets tables arrive in
-- later migrations (Phases 3–4).

create extension if not exists pgcrypto;

-- Internal helpers live here. This schema is not exposed through the Supabase Data API.
create schema if not exists private;

-- ── Types ────────────────────────────────────────────────────────────────
create type public.app_role as enum ('manager', 'sales', 'support');
create type public.stage_key as enum ('new', 'contacting', 'qualified', 'awaiting_payment', 'enrolled', 'lost', 'invalid');
create type public.outcome_key as enum ('no_answer', 'busy', 'reached', 'requested_callback', 'wrong_number');
create type public.contact_type as enum ('student', 'parent', 'other');
create type public.lead_source as enum ('google_sheet', 'manual');
create type public.field_type as enum ('text', 'phone', 'number', 'date', 'dropdown', 'checkbox');
create type public.field_importance as enum ('essential', 'standard', 'additional');
create type public.follow_up_status as enum ('open', 'done', 'cancelled');

-- ── Staff ────────────────────────────────────────────────────────────────
create table public.profiles (
  id uuid primary key references auth.users (id) on delete restrict,
  full_name text not null check (length(trim(full_name)) between 1 and 120),
  email text not null,
  role public.app_role not null,
  active boolean not null default true,
  rotation_order integer not null default 0,
  paused boolean not null default false,
  max_open_leads integer check (max_open_leads is null or max_open_leads > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ── Reference data ───────────────────────────────────────────────────────
create table public.programs (
  id uuid primary key default gen_random_uuid(),
  code text not null unique check (code ~ '^[A-Z0-9]{2,12}$'),
  name text not null,
  active boolean not null default true,
  sort integer not null default 0
);

create table public.cohorts (
  id uuid primary key default gen_random_uuid(),
  program_id uuid not null references public.programs (id),
  name text not null,
  start_date date,
  default_price numeric(12, 2),
  currency text not null default 'EGP' check (currency ~ '^[A-Z]{3}$'),
  active boolean not null default true
);

-- Stages: the label and order are editable; system_key is the fixed business meaning.
create table public.stages (
  id uuid primary key default gen_random_uuid(),
  system_key public.stage_key not null unique,
  label text not null check (length(trim(label)) between 1 and 40),
  sort integer not null,
  is_closed boolean not null,
  agent_selectable boolean not null default true
);

create table public.contact_outcomes (
  id uuid primary key default gen_random_uuid(),
  system_key public.outcome_key not null unique,
  label text not null check (length(trim(label)) between 1 and 40),
  sort integer not null
);

create table public.tags (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(trim(name)) between 1 and 40),
  color text not null check (color in ('orange', 'blue', 'purple', 'red', 'green', 'teal', 'gray')),
  archived boolean not null default false,
  created_by uuid references public.profiles (id),
  created_at timestamptz not null default now()
);
create unique index tags_name_unique on public.tags (lower(name));

-- Single-row settings table.
create table public.app_settings (
  id integer primary key default 1 check (id = 1),
  agents_can_create_tags boolean not null default false,
  agents_can_pause boolean not null default true,
  per_agent_lead_cap_enabled boolean not null default false,
  reminder_minutes_before integer not null default 15 check (reminder_minutes_before between 0 and 1440),
  overdue_after_minutes integer not null default 0 check (overdue_after_minutes between 0 and 1440),
  first_contact_target_minutes integer not null default 15 check (first_contact_target_minutes between 1 and 1440),
  note_edit_window_minutes integer not null default 15 check (note_edit_window_minutes between 0 and 1440),
  handover_trigger text not null default 'qualifying_deposit' check (handover_trigger in ('qualifying_deposit', 'full_payment')),
  -- { "<program_id>": {"kind": "percent"|"amount", "value": n} | null }. Empty until the Academy decides.
  deposit_rule jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

-- ── Contacts and inquiries ───────────────────────────────────────────────
create table public.contacts (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(trim(name)) between 1 and 120),
  phone text not null,
  phone_normalized text not null check (phone_normalized ~ '^\+?[0-9]{8,15}$'),
  phone_secondary text,
  phone_secondary_normalized text check (phone_secondary_normalized is null or phone_secondary_normalized ~ '^\+?[0-9]{8,15}$'),
  contact_type public.contact_type not null default 'student',
  do_not_contact boolean not null default false,
  do_not_contact_reason text,
  created_by uuid references public.profiles (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (not do_not_contact or do_not_contact_reason is not null)
);
-- One phone can belong to one contact; a parent with two children is one contact with two inquiries.
create unique index contacts_phone_unique on public.contacts (phone_normalized);
create index contacts_phone_secondary_idx on public.contacts (phone_secondary_normalized) where phone_secondary_normalized is not null;

create table public.inquiries (
  id uuid primary key default gen_random_uuid(),
  contact_id uuid not null references public.contacts (id),
  program_id uuid not null references public.programs (id),
  student_name text check (student_name is null or length(student_name) <= 120),
  stage_id uuid not null references public.stages (id),
  last_outcome_id uuid references public.contact_outcomes (id),
  sales_owner_id uuid references public.profiles (id),
  primary_tag_id uuid references public.tags (id),
  source public.lead_source not null,
  source_connection_id uuid,
  created_by uuid references public.profiles (id),
  created_at timestamptz not null default now(),
  assigned_at timestamptz,
  first_contact_attempt_at timestamptz,
  last_contact_at timestamptz,
  no_follow_up_reason text,
  lost_reason text,
  reserved boolean not null default false,
  reserved_note text,
  version integer not null default 1
);
create index inquiries_owner_idx on public.inquiries (sales_owner_id);
create index inquiries_contact_idx on public.inquiries (contact_id);
create index inquiries_program_stage_idx on public.inquiries (program_id, stage_id);
create index inquiries_created_idx on public.inquiries (created_at desc);

create table public.inquiry_tags (
  inquiry_id uuid not null references public.inquiries (id) on delete cascade,
  tag_id uuid not null references public.tags (id),
  primary key (inquiry_id, tag_id)
);
create index inquiry_tags_tag_idx on public.inquiry_tags (tag_id);

-- Append-only timeline. Nothing here is ever updated in place except a note body,
-- and then only through edit_note(), which keeps the earlier version.
create table public.activities (
  id uuid primary key default gen_random_uuid(),
  inquiry_id uuid not null references public.inquiries (id) on delete cascade,
  type text not null check (type in (
    'comment', 'contact_attempt', 'stage_change', 'owner_change', 'follow_up_created', 'follow_up_completed',
    'payment_submitted', 'payment_decision', 'handover', 'checklist', 'support_status', 'tag_change',
    'do_not_contact', 'imported', 'resubmitted', 'outreach_shortcut', 'field_change', 'reservation'
  )),
  actor_id uuid references public.profiles (id), -- null = system
  body text check (body is null or length(body) <= 4000),
  meta jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index activities_inquiry_idx on public.activities (inquiry_id, created_at desc);

create table public.note_revisions (
  id uuid primary key default gen_random_uuid(),
  activity_id uuid not null references public.activities (id) on delete cascade,
  body text not null,
  edited_at timestamptz not null default now(),
  edited_by uuid not null references public.profiles (id)
);
create index note_revisions_activity_idx on public.note_revisions (activity_id);

create table public.follow_ups (
  id uuid primary key default gen_random_uuid(),
  inquiry_id uuid not null references public.inquiries (id) on delete cascade,
  owner_id uuid not null references public.profiles (id),
  due_at timestamptz not null,
  note text not null check (length(trim(note)) between 1 and 300),
  status public.follow_up_status not null default 'open',
  completed_at timestamptz,
  completed_by uuid references public.profiles (id),
  created_by uuid references public.profiles (id),
  created_at timestamptz not null default now()
);
create index follow_ups_open_inquiry_idx on public.follow_ups (inquiry_id, due_at) where status = 'open';
create index follow_ups_open_owner_idx on public.follow_ups (owner_id, due_at) where status = 'open';

-- ── Custom fields ────────────────────────────────────────────────────────
create table public.field_definitions (
  id uuid primary key default gen_random_uuid(), -- stable internal ID; never changes
  key text not null unique check (key ~ '^[a-z][a-z0-9_]{0,40}$'),
  label text not null check (length(trim(label)) between 1 and 60),
  type public.field_type not null,
  importance public.field_importance not null default 'standard',
  -- 'never' | 'always' | a stage system key from which the field becomes required
  required_from text not null default 'never'
    check (required_from in ('never', 'always', 'new', 'contacting', 'qualified', 'awaiting_payment')),
  program_ids uuid[] not null default '{}', -- empty = all programs
  visible_to public.app_role[] not null default '{manager,sales,support}',
  editable_by public.app_role[] not null default '{manager,sales}',
  sort integer not null default 0,
  archived boolean not null default false,
  created_at timestamptz not null default now(),
  check ('manager' = any (visible_to)),
  check (editable_by <@ visible_to)
);

create table public.field_options (
  id uuid primary key default gen_random_uuid(),
  field_id uuid not null references public.field_definitions (id) on delete cascade,
  label text not null check (length(trim(label)) between 1 and 60),
  sort integer not null default 0,
  archived boolean not null default false
);
create index field_options_field_idx on public.field_options (field_id);

create table public.field_values (
  inquiry_id uuid not null references public.inquiries (id) on delete cascade,
  field_id uuid not null references public.field_definitions (id),
  value jsonb not null,
  updated_at timestamptz not null default now(),
  updated_by uuid references public.profiles (id),
  primary key (inquiry_id, field_id)
);
create index field_values_field_idx on public.field_values (field_id);

-- ── Personal, notifications, audit ───────────────────────────────────────
create table public.saved_views (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  name text not null check (length(trim(name)) between 1 and 60),
  filters jsonb not null,
  created_at timestamptz not null default now()
);
create index saved_views_user_idx on public.saved_views (user_id);

create table public.user_preferences (
  user_id uuid primary key references public.profiles (id) on delete cascade,
  lead_columns text[],
  updated_at timestamptz not null default now()
);

create table public.notifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  text text not null,
  inquiry_id uuid references public.inquiries (id) on delete cascade,
  created_at timestamptz not null default now(),
  read_at timestamptz
);
create index notifications_user_idx on public.notifications (user_id, created_at desc);

create table public.audit_log (
  id uuid primary key default gen_random_uuid(),
  actor_id uuid references public.profiles (id),
  action text not null,
  target text not null,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index audit_log_created_idx on public.audit_log (created_at desc);
