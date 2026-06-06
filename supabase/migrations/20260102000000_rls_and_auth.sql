-- =====================================================================
-- CEGIS Assessment & Training Analytics
-- Migration 0002 — RLS, access-token hook, helpers, policies (Phase 3)
--
-- Depends on 0001 (tables/enums). Enables Row Level Security on every
-- table (deny by default) and adds the policies that enforce:
--   * tenant isolation: every policy keys on the caller's org_id;
--   * soft delete: read policies require deleted_at is null;
--   * admin: full CRUD within their own org;
--   * participant: only their own attempts/responses, the panels they
--     rate, and their own reports;
--   * 360 confidentiality: a subject can NEVER read individual
--     wpca_responses or see who rates them — only per-competency means,
--     via a security-definer function that verifies the caller is the
--     subject. Even admins cannot read individual 360 responses directly.
--
-- !!! MANUAL STEP AFTER APPLYING !!!
-- The access-token hook function below does nothing until it is enabled
-- in the dashboard:
--   Supabase Dashboard -> Authentication -> Hooks (Customize Access Token)
--   -> select `public.custom_access_token_hook` -> Save.
-- This cannot be done from SQL alone. JWT claims are stamped at login,
-- so org/role changes only take effect after the user re-authenticates.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Helper functions
--   auth_org_id() / auth_role() read claims stamped into the JWT by the
--   access-token hook (NOT by querying profiles inside policies, which
--   would recurse). The my_* helpers are SECURITY DEFINER so they bypass
--   RLS and can be used safely inside other tables' policies.
-- ---------------------------------------------------------------------
create or replace function public.auth_org_id()
returns uuid language sql stable as
$$ select nullif(auth.jwt()->'app_metadata'->>'org_id','')::uuid $$;

create or replace function public.auth_role()
returns text language sql stable as
$$ select auth.jwt()->'app_metadata'->>'role' $$;

create or replace function public.my_participant_ids()
returns setof uuid language sql stable security definer set search_path = public as
$$ select id from participants where user_id = auth.uid() and deleted_at is null $$;

create or replace function public.my_cohort_ids()
returns setof uuid language sql stable security definer set search_path = public as
$$ select distinct cohort_id from participants where user_id = auth.uid() and deleted_at is null $$;

-- ---------------------------------------------------------------------
-- 360 confidentiality: subject-only per-competency aggregates.
-- Returns means across all raters; never exposes individual responses
-- or rater identities. Caller MUST be the subject themselves.
-- ---------------------------------------------------------------------
create or replace function public.wpca_competency_means(p_round_id uuid, p_subject_id uuid)
returns table (competency text, mean_score numeric, response_count integer)
language plpgsql stable security definer set search_path = public as $$
begin
  if not exists (
    select 1 from participants
    where id = p_subject_id and user_id = auth.uid() and deleted_at is null
  ) then
    raise exception 'not authorized: only the 360 subject may view their own aggregates';
  end if;

  return query
  select c.competency,
         round(avg((r.answer->>'likert')::numeric), 2) as mean_score,
         count(*)::int                                  as response_count
  from wpca_panels pn
  join wpca_responses r on r.panel_id = pn.id
  join questions q       on q.id = r.question_id
  cross join lateral unnest(coalesce(q.competency, array[]::text[])) as c(competency)
  where pn.round_id   = p_round_id
    and pn.subject_id = p_subject_id
    and r.answer ? 'likert'
  group by c.competency;
end; $$;

-- ---------------------------------------------------------------------
-- Base table/function privileges. RLS is still the real gate — these
-- grants are the Supabase convention (table-level access for the
-- authenticated role; rows/commands restricted by the policies below).
-- ---------------------------------------------------------------------
grant usage on schema public to anon, authenticated, service_role;
grant select, insert, update, delete on all tables in schema public to authenticated, service_role;
grant execute on all functions in schema public to anon, authenticated, service_role;

-- ---------------------------------------------------------------------
-- Enable RLS (deny by default) on every table.
-- ---------------------------------------------------------------------
alter table organizations    enable row level security;
alter table profiles         enable row level security;
alter table cohorts          enable row level security;
alter table participants     enable row level security;
alter table assessments      enable row level security;
alter table questions        enable row level security;
alter table question_options enable row level security;
alter table attempts         enable row level security;
alter table responses        enable row level security;
alter table wpca_rounds      enable row level security;
alter table wpca_panels      enable row level security;
alter table wpca_responses   enable row level security;
alter table reports          enable row level security;
alter table import_batches   enable row level security;
alter table audit_log        enable row level security;

-- ---------------------------------------------------------------------
-- Access-token hook (runs as supabase_auth_admin at login). Stamps
-- org_id + role into app_metadata so policies can read them from the JWT.
-- ---------------------------------------------------------------------
create or replace function public.custom_access_token_hook(event jsonb)
returns jsonb language plpgsql stable as $$
declare claims jsonb; v_org uuid; v_role text;
begin
  select org_id, role::text into v_org, v_role
  from public.profiles where id = (event->>'user_id')::uuid;
  claims := event->'claims';
  claims := jsonb_set(claims, '{app_metadata,org_id}', coalesce(to_jsonb(v_org),  'null'::jsonb));
  claims := jsonb_set(claims, '{app_metadata,role}',   coalesce(to_jsonb(v_role), 'null'::jsonb));
  return jsonb_set(event, '{claims}', claims);
end; $$;

-- the hook reads profiles as supabase_auth_admin; grant it access + a policy
grant usage on schema public to supabase_auth_admin;
grant execute on function public.custom_access_token_hook(jsonb) to supabase_auth_admin;
revoke execute on function public.custom_access_token_hook(jsonb) from authenticated, anon, public;
grant select on table public.profiles to supabase_auth_admin;

create policy auth_admin_read_profiles on profiles
  for select to supabase_auth_admin using (true);

-- =====================================================================
-- POLICIES
-- =====================================================================

-- ---- organizations (tenant root: identity is `id`, not `org_id`) ----
create policy organizations_member_select on organizations
  for select using (id = auth_org_id() and deleted_at is null);
create policy organizations_admin_update on organizations
  for update using (id = auth_org_id() and auth_role() = 'admin')
  with check (id = auth_org_id() and auth_role() = 'admin');

-- ---- profiles ----
create policy profiles_self_select on profiles
  for select using (id = auth.uid());
create policy profiles_admin_select on profiles
  for select using (org_id = auth_org_id() and auth_role() = 'admin');

-- ---- cohorts ----
create policy cohorts_admin_select on cohorts
  for select using (org_id = auth_org_id() and auth_role() = 'admin' and deleted_at is null);
create policy cohorts_admin_insert on cohorts
  for insert with check (org_id = auth_org_id() and auth_role() = 'admin');
create policy cohorts_admin_update on cohorts
  for update using (org_id = auth_org_id() and auth_role() = 'admin')
  with check (org_id = auth_org_id() and auth_role() = 'admin');
create policy cohorts_admin_delete on cohorts
  for delete using (org_id = auth_org_id() and auth_role() = 'admin');
create policy cohorts_participant_select on cohorts
  for select using (org_id = auth_org_id() and deleted_at is null
                    and id in (select my_cohort_ids()));

-- ---- participants ----
create policy participants_admin_select on participants
  for select using (org_id = auth_org_id() and auth_role() = 'admin' and deleted_at is null);
create policy participants_admin_insert on participants
  for insert with check (org_id = auth_org_id() and auth_role() = 'admin');
create policy participants_admin_update on participants
  for update using (org_id = auth_org_id() and auth_role() = 'admin')
  with check (org_id = auth_org_id() and auth_role() = 'admin');
create policy participants_admin_delete on participants
  for delete using (org_id = auth_org_id() and auth_role() = 'admin');
-- a participant may see their own row(s) and the subjects they rate
create policy participants_self_select on participants
  for select using (
    org_id = auth_org_id() and deleted_at is null and (
      id in (select my_participant_ids())
      or id in (select subject_id from wpca_panels where rater_id in (select my_participant_ids()))
    )
  );

-- ---- assessments ----
create policy assessments_admin_select on assessments
  for select using (org_id = auth_org_id() and auth_role() = 'admin' and deleted_at is null);
create policy assessments_admin_insert on assessments
  for insert with check (org_id = auth_org_id() and auth_role() = 'admin');
create policy assessments_admin_update on assessments
  for update using (org_id = auth_org_id() and auth_role() = 'admin')
  with check (org_id = auth_org_id() and auth_role() = 'admin');
create policy assessments_admin_delete on assessments
  for delete using (org_id = auth_org_id() and auth_role() = 'admin');
-- participants see non-draft assessments in their own cohort(s)
create policy assessments_participant_select on assessments
  for select using (org_id = auth_org_id() and deleted_at is null
                    and status <> 'draft'
                    and cohort_id in (select my_cohort_ids()));

-- ---- questions (prompts visible; answer keys live in question_options) ----
create policy questions_admin_select on questions
  for select using (org_id = auth_org_id() and auth_role() = 'admin' and deleted_at is null);
create policy questions_admin_insert on questions
  for insert with check (org_id = auth_org_id() and auth_role() = 'admin');
create policy questions_admin_update on questions
  for update using (org_id = auth_org_id() and auth_role() = 'admin')
  with check (org_id = auth_org_id() and auth_role() = 'admin');
create policy questions_admin_delete on questions
  for delete using (org_id = auth_org_id() and auth_role() = 'admin');
create policy questions_participant_select on questions
  for select using (org_id = auth_org_id() and deleted_at is null
                    and assessment_id in (
                      select id from assessments
                      where org_id = auth_org_id() and deleted_at is null
                        and status <> 'draft'
                        and cohort_id in (select my_cohort_ids())
                    ));

-- ---- question_options (ADMIN ONLY — is_correct is the answer key) ----
-- Deliberately NO participant policy. The assessment player will read
-- options via a SECURITY DEFINER function that strips is_correct (Phase 8).
create policy question_options_admin_all on question_options
  for all using (org_id = auth_org_id() and auth_role() = 'admin')
  with check (org_id = auth_org_id() and auth_role() = 'admin');

-- ---- attempts (no client-set score: submit + scoring is an RPC) ----
create policy attempts_admin_all on attempts
  for all using (org_id = auth_org_id() and auth_role() = 'admin')
  with check (org_id = auth_org_id() and auth_role() = 'admin');
create policy attempts_participant_select on attempts
  for select using (org_id = auth_org_id() and participant_id in (select my_participant_ids()));
create policy attempts_participant_insert on attempts
  for insert with check (org_id = auth_org_id() and participant_id in (select my_participant_ids()));
-- (no participant UPDATE/DELETE — status/score transitions go through the RPC)

-- ---- responses (autosave own answers; only while attempt in_progress) ----
create policy responses_admin_select on responses
  for select using (org_id = auth_org_id() and auth_role() = 'admin');
create policy responses_participant_select on responses
  for select using (org_id = auth_org_id()
                    and attempt_id in (select id from attempts
                                       where participant_id in (select my_participant_ids())));
create policy responses_participant_insert on responses
  for insert with check (org_id = auth_org_id()
                    and attempt_id in (select id from attempts
                                       where participant_id in (select my_participant_ids())
                                         and status = 'in_progress'));
create policy responses_participant_update on responses
  for update using (org_id = auth_org_id()
                    and attempt_id in (select id from attempts
                                       where participant_id in (select my_participant_ids())
                                         and status = 'in_progress'))
  with check (org_id = auth_org_id()
                    and attempt_id in (select id from attempts
                                       where participant_id in (select my_participant_ids())
                                         and status = 'in_progress'));
create policy responses_participant_delete on responses
  for delete using (org_id = auth_org_id()
                    and attempt_id in (select id from attempts
                                       where participant_id in (select my_participant_ids())
                                         and status = 'in_progress'));

-- ---- wpca_rounds ----
create policy wpca_rounds_admin_select on wpca_rounds
  for select using (org_id = auth_org_id() and auth_role() = 'admin' and deleted_at is null);
create policy wpca_rounds_admin_insert on wpca_rounds
  for insert with check (org_id = auth_org_id() and auth_role() = 'admin');
create policy wpca_rounds_admin_update on wpca_rounds
  for update using (org_id = auth_org_id() and auth_role() = 'admin')
  with check (org_id = auth_org_id() and auth_role() = 'admin');
create policy wpca_rounds_admin_delete on wpca_rounds
  for delete using (org_id = auth_org_id() and auth_role() = 'admin');
create policy wpca_rounds_participant_select on wpca_rounds
  for select using (org_id = auth_org_id() and deleted_at is null
                    and cohort_id in (select my_cohort_ids()));

-- ---- wpca_panels (raters see their assignments; subjects do NOT) ----
create policy wpca_panels_admin_all on wpca_panels
  for all using (org_id = auth_org_id() and auth_role() = 'admin')
  with check (org_id = auth_org_id() and auth_role() = 'admin');
create policy wpca_panels_rater_select on wpca_panels
  for select using (org_id = auth_org_id()
                    and rater_id in (select my_participant_ids()));

-- ---- wpca_responses (rater authors only; NO subject, NO admin direct read) ----
create policy wpca_responses_rater_select on wpca_responses
  for select using (org_id = auth_org_id()
                    and panel_id in (select id from wpca_panels
                                     where rater_id in (select my_participant_ids())));
create policy wpca_responses_rater_insert on wpca_responses
  for insert with check (org_id = auth_org_id()
                    and panel_id in (select id from wpca_panels
                                     where rater_id in (select my_participant_ids())));
create policy wpca_responses_rater_update on wpca_responses
  for update using (org_id = auth_org_id()
                    and panel_id in (select id from wpca_panels
                                     where rater_id in (select my_participant_ids())))
  with check (org_id = auth_org_id()
                    and panel_id in (select id from wpca_panels
                                     where rater_id in (select my_participant_ids())));
create policy wpca_responses_rater_delete on wpca_responses
  for delete using (org_id = auth_org_id()
                    and panel_id in (select id from wpca_panels
                                     where rater_id in (select my_participant_ids())));

-- ---- reports ----
create policy reports_admin_select on reports
  for select using (org_id = auth_org_id() and auth_role() = 'admin' and deleted_at is null);
create policy reports_admin_insert on reports
  for insert with check (org_id = auth_org_id() and auth_role() = 'admin');
create policy reports_admin_update on reports
  for update using (org_id = auth_org_id() and auth_role() = 'admin')
  with check (org_id = auth_org_id() and auth_role() = 'admin');
create policy reports_admin_delete on reports
  for delete using (org_id = auth_org_id() and auth_role() = 'admin');
create policy reports_participant_select on reports
  for select using (org_id = auth_org_id() and deleted_at is null
                    and scope = 'participant'
                    and participant_id in (select my_participant_ids()));

-- ---- import_batches (admin only) ----
create policy import_batches_admin_all on import_batches
  for all using (org_id = auth_org_id() and auth_role() = 'admin')
  with check (org_id = auth_org_id() and auth_role() = 'admin');

-- ---- audit_log (admin read-only; writes happen via SECURITY DEFINER RPCs) ----
create policy audit_log_admin_select on audit_log
  for select using (org_id = auth_org_id() and auth_role() = 'admin');
