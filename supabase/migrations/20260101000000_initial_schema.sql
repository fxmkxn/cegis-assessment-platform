-- =====================================================================
-- CEGIS Assessment & Training Analytics
-- Migration 0001 — Initial schema (Phase 2)
--
-- Scope: enums, tables, foreign keys, indexes, and moddatetime/updated_at
-- triggers ONLY. Row Level Security policies, the custom access-token hook,
-- helper functions (auth_org_id / auth_role) and the scoring/atomic RPCs
-- land in later migrations (Phase 3+). This migration intentionally does
-- NOT enable RLS yet.
--
-- Conventions:
--   * Every child table carries org_id (denormalized for fast RLS later).
--   * User-deletable tables carry deleted_at (soft delete).
--   * created_at + updated_at via moddatetime trigger where mutable.
--   * created_by / updated_by reference auth.users where audit matters.
--   * FKs default to ON DELETE RESTRICT, except truly-owned children
--     (responses, question_options, wpca_responses) which CASCADE, and
--     auth.users references which SET NULL.
-- =====================================================================

create extension if not exists moddatetime schema extensions;
-- gen_random_uuid() is built into PostgreSQL 13+ (Supabase runs 15+).

-- ---------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------
create type assessment_kind as enum ('technical', 'wpca');
create type question_type   as enum ('mcq', 'multi', 'tf', 'fib', 'likert');
create type stage           as enum ('baseline', 'eoca', 'endline', 'wpca');
create type user_role       as enum ('admin', 'participant');

-- ---------------------------------------------------------------------
-- organizations  (tenant root)
-- ---------------------------------------------------------------------
create table organizations (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  deleted_at  timestamptz
);

-- ---------------------------------------------------------------------
-- profiles  (1:1 with auth.users; carries tenant + role for JWT claims)
-- ---------------------------------------------------------------------
create table profiles (
  id          uuid primary key references auth.users(id) on delete cascade,
  org_id      uuid not null references organizations(id) on delete restrict,
  role        user_role not null,
  full_name   text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
-- exactly one admin per org
create unique index one_admin_per_org on profiles (org_id) where role = 'admin';
create index profiles_org_id_idx on profiles (org_id);

-- ---------------------------------------------------------------------
-- cohorts
-- ---------------------------------------------------------------------
create table cohorts (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references organizations(id) on delete restrict,
  name        text not null,
  starts_on   date,
  ends_on     date,
  created_by  uuid references auth.users(id) on delete set null,
  updated_by  uuid references auth.users(id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  deleted_at  timestamptz
);
create index cohorts_org_id_idx     on cohorts (org_id);
create index cohorts_deleted_at_idx on cohorts (deleted_at) where deleted_at is null;

-- ---------------------------------------------------------------------
-- participants
-- ---------------------------------------------------------------------
create table participants (
  id                     uuid primary key default gen_random_uuid(),
  org_id                 uuid not null references organizations(id) on delete restrict,
  cohort_id              uuid not null references cohorts(id) on delete restrict,
  user_id                uuid references auth.users(id) on delete set null,   -- null until credentials generated
  name                   text not null,
  email                  text not null,
  designation            text,
  workstream             text,
  location               text,
  manager_participant_id uuid references participants(id) on delete restrict, -- self-ref hierarchy
  extra                  jsonb not null default '{}'::jsonb,                  -- lossless overflow from roster file
  created_by             uuid references auth.users(id) on delete set null,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  deleted_at             timestamptz
);
-- one active participant per (cohort, email); soft-deleted emails may be re-added
create unique index participants_email_active
  on participants (cohort_id, lower(email)) where deleted_at is null;
create index participants_org_id_idx     on participants (org_id);
create index participants_cohort_id_idx  on participants (cohort_id);
create index participants_user_id_idx    on participants (user_id);
create index participants_manager_idx    on participants (manager_participant_id);
create index participants_deleted_at_idx on participants (deleted_at) where deleted_at is null;

-- ---------------------------------------------------------------------
-- assessments
-- ---------------------------------------------------------------------
create table assessments (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references organizations(id) on delete restrict,
  cohort_id   uuid not null references cohorts(id) on delete restrict,
  name        text not null,
  kind        assessment_kind not null,                 -- 'technical' | 'wpca'
  stage       stage not null,
  status      text not null default 'draft',            -- draft | scheduled | live | closed
  opens_at    timestamptz,
  closes_at   timestamptz,
  created_by  uuid references auth.users(id) on delete set null,
  updated_by  uuid references auth.users(id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  deleted_at  timestamptz
);
create index assessments_org_id_idx     on assessments (org_id);
create index assessments_cohort_id_idx  on assessments (cohort_id);
create index assessments_deleted_at_idx on assessments (deleted_at) where deleted_at is null;

-- ---------------------------------------------------------------------
-- questions
-- ---------------------------------------------------------------------
create table questions (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references organizations(id) on delete restrict,
  assessment_id uuid not null references assessments(id) on delete restrict,
  ordinal       int not null,                            -- = qno
  type          question_type not null,                  -- = qtype
  prompt        text not null,                            -- = ques
  competency    text[],                                   -- = competency (also 360 radar axis)
  marks         numeric,                                  -- technical only; null for likert
  image_path    text,                                     -- optional Storage path
  created_by    uuid references auth.users(id) on delete set null,
  updated_by    uuid references auth.users(id) on delete set null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  deleted_at    timestamptz,
  unique (assessment_id, ordinal)
);
create index questions_org_id_idx        on questions (org_id);
create index questions_assessment_id_idx on questions (assessment_id);
create index questions_deleted_at_idx    on questions (deleted_at) where deleted_at is null;

-- ---------------------------------------------------------------------
-- question_options  (owned by questions -> CASCADE)
-- ---------------------------------------------------------------------
create table question_options (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references organizations(id) on delete restrict,
  question_id uuid not null references questions(id) on delete cascade,
  ordinal     int not null check (ordinal between 1 and 5),   -- option1..option5
  label       text not null,
  is_correct  boolean not null default false,                 -- false for likert
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (question_id, ordinal)
);
create index question_options_org_id_idx      on question_options (org_id);
create index question_options_question_id_idx on question_options (question_id);

-- ---------------------------------------------------------------------
-- attempts
-- ---------------------------------------------------------------------
create table attempts (
  id             uuid primary key default gen_random_uuid(),
  org_id         uuid not null references organizations(id) on delete restrict,
  participant_id uuid not null references participants(id) on delete restrict,
  assessment_id  uuid not null references assessments(id) on delete restrict,
  status         text not null default 'in_progress',     -- in_progress | submitted
  score          numeric,
  max_score      numeric,
  started_at     timestamptz not null default now(),
  submitted_at   timestamptz,
  updated_at     timestamptz not null default now(),
  unique (participant_id, assessment_id)
);
create index attempts_org_id_idx         on attempts (org_id);
create index attempts_participant_id_idx on attempts (participant_id);
create index attempts_assessment_id_idx  on attempts (assessment_id);

-- ---------------------------------------------------------------------
-- responses  (owned by attempts -> CASCADE)
-- ---------------------------------------------------------------------
create table responses (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references organizations(id) on delete restrict,
  attempt_id  uuid not null references attempts(id) on delete cascade,
  question_id uuid not null references questions(id) on delete restrict,
  answer      jsonb,                                       -- {"selected":[2,4]} | {"text":"inner"}
  flagged     boolean not null default false,
  updated_at  timestamptz not null default now(),
  unique (attempt_id, question_id)
);
create index responses_org_id_idx      on responses (org_id);
create index responses_attempt_id_idx  on responses (attempt_id);
create index responses_question_id_idx on responses (question_id);

-- ---------------------------------------------------------------------
-- wpca_rounds
-- ---------------------------------------------------------------------
create table wpca_rounds (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references organizations(id) on delete restrict,
  cohort_id     uuid not null references cohorts(id) on delete restrict,
  assessment_id uuid not null references assessments(id) on delete restrict,  -- the wpca-kind instrument
  name          text not null,                             -- 'Week 2', 'Week 4'
  status        text not null default 'draft',
  created_by    uuid references auth.users(id) on delete set null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  deleted_at    timestamptz
);
create index wpca_rounds_org_id_idx        on wpca_rounds (org_id);
create index wpca_rounds_cohort_id_idx     on wpca_rounds (cohort_id);
create index wpca_rounds_assessment_id_idx on wpca_rounds (assessment_id);
create index wpca_rounds_deleted_at_idx    on wpca_rounds (deleted_at) where deleted_at is null;

-- ---------------------------------------------------------------------
-- wpca_panels
-- ---------------------------------------------------------------------
create table wpca_panels (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references organizations(id) on delete restrict,
  round_id    uuid not null references wpca_rounds(id) on delete restrict,
  subject_id  uuid not null references participants(id) on delete restrict,
  rater_id    uuid not null references participants(id) on delete restrict,
  rater_role  text not null,                               -- self | manager | reportee | peer
  status      text not null default 'pending',             -- pending | complete
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (round_id, subject_id, rater_id)
);
create index wpca_panels_org_id_idx     on wpca_panels (org_id);
create index wpca_panels_round_id_idx   on wpca_panels (round_id);
create index wpca_panels_subject_id_idx on wpca_panels (subject_id);
create index wpca_panels_rater_id_idx   on wpca_panels (rater_id);

-- ---------------------------------------------------------------------
-- wpca_responses  (owned by panels -> CASCADE; never readable per-row by subject)
-- ---------------------------------------------------------------------
create table wpca_responses (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references organizations(id) on delete restrict,
  panel_id    uuid not null references wpca_panels(id) on delete cascade,
  question_id uuid not null references questions(id) on delete restrict,
  answer      jsonb,                                       -- {"likert":4}
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index wpca_responses_org_id_idx      on wpca_responses (org_id);
create index wpca_responses_panel_id_idx    on wpca_responses (panel_id);
create index wpca_responses_question_id_idx on wpca_responses (question_id);

-- ---------------------------------------------------------------------
-- reports
-- ---------------------------------------------------------------------
create table reports (
  id             uuid primary key default gen_random_uuid(),
  org_id         uuid not null references organizations(id) on delete restrict,
  scope          text not null,                            -- 'participant' | 'cohort'
  participant_id uuid references participants(id) on delete restrict,
  cohort_id      uuid references cohorts(id) on delete restrict,
  type           text not null,                            -- 'stage' | 'comprehensive'
  status         text not null default 'ready',
  content        jsonb,                                    -- structured LLM output
  storage_path   text,                                     -- generated PDF (optional)
  created_by     uuid references auth.users(id) on delete set null,
  generated_at   timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  deleted_at     timestamptz
);
create index reports_org_id_idx         on reports (org_id);
create index reports_participant_id_idx on reports (participant_id);
create index reports_cohort_id_idx      on reports (cohort_id);
create index reports_deleted_at_idx     on reports (deleted_at) where deleted_at is null;

-- ---------------------------------------------------------------------
-- import_batches
-- ---------------------------------------------------------------------
create table import_batches (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references organizations(id) on delete restrict,
  cohort_id   uuid not null references cohorts(id) on delete restrict,
  kind        text not null,                               -- 'roster' | 'assessment'
  file_path   text not null,
  column_map  jsonb,
  row_count   int,
  errors      jsonb not null default '[]'::jsonb,
  status      text not null default 'parsed',
  created_by  uuid references auth.users(id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index import_batches_org_id_idx    on import_batches (org_id);
create index import_batches_cohort_id_idx on import_batches (cohort_id);

-- ---------------------------------------------------------------------
-- audit_log  (append-only — no updated_at, no soft delete)
-- ---------------------------------------------------------------------
create table audit_log (
  id        bigserial primary key,
  org_id    uuid not null,
  actor_id  uuid,
  action    text not null,
  entity    text,
  entity_id uuid,
  diff      jsonb,
  at        timestamptz not null default now()
);
create index audit_log_org_id_idx on audit_log (org_id);
create index audit_log_entity_idx on audit_log (entity, entity_id);

-- ---------------------------------------------------------------------
-- moddatetime triggers — keep updated_at fresh on every UPDATE
-- ---------------------------------------------------------------------
create trigger set_updated_at before update on organizations
  for each row execute procedure extensions.moddatetime (updated_at);
create trigger set_updated_at before update on profiles
  for each row execute procedure extensions.moddatetime (updated_at);
create trigger set_updated_at before update on cohorts
  for each row execute procedure extensions.moddatetime (updated_at);
create trigger set_updated_at before update on participants
  for each row execute procedure extensions.moddatetime (updated_at);
create trigger set_updated_at before update on assessments
  for each row execute procedure extensions.moddatetime (updated_at);
create trigger set_updated_at before update on questions
  for each row execute procedure extensions.moddatetime (updated_at);
create trigger set_updated_at before update on question_options
  for each row execute procedure extensions.moddatetime (updated_at);
create trigger set_updated_at before update on attempts
  for each row execute procedure extensions.moddatetime (updated_at);
create trigger set_updated_at before update on responses
  for each row execute procedure extensions.moddatetime (updated_at);
create trigger set_updated_at before update on wpca_rounds
  for each row execute procedure extensions.moddatetime (updated_at);
create trigger set_updated_at before update on wpca_panels
  for each row execute procedure extensions.moddatetime (updated_at);
create trigger set_updated_at before update on wpca_responses
  for each row execute procedure extensions.moddatetime (updated_at);
create trigger set_updated_at before update on reports
  for each row execute procedure extensions.moddatetime (updated_at);
create trigger set_updated_at before update on import_batches
  for each row execute procedure extensions.moddatetime (updated_at);
