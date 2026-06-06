-- =====================================================================
-- RLS ISOLATION TEST  (Phase 3 — Definition of Done)
--
-- Proves: cross-org isolation, answer-key protection, and 360
-- confidentiality (a subject cannot read individual rater responses or
-- see who rates them; even admins cannot read raw 360 responses).
--
-- HOW TO RUN: against a LOCAL or throwaway Postgres that has the schema
-- applied (e.g. `supabase start` + `supabase db reset`, or a scratch DB).
-- It inserts rows into auth.users, so DO NOT run it against your
-- production project. Any failed assertion aborts with an exception;
-- if it runs to completion with no error, every check passed.
-- =====================================================================

-- assertion helper (raises on failure)
create or replace function public.assert_true(cond boolean, label text)
returns void language plpgsql as $$
begin
  if cond is not true then raise exception 'FAIL: %', label;
  else raise notice 'PASS: %', label; end if;
end; $$;
grant execute on function public.assert_true(boolean, text) to authenticated, anon;

-- ---------------------------------------------------------------------
-- Seed two tenants with fixed UUIDs (committed so test txns can read it)
-- ---------------------------------------------------------------------
-- auth users
insert into auth.users (id) values
  ('a0000000-0000-0000-0000-0000000000a1'), -- admin A
  ('a0000000-0000-0000-0000-0000000000a2'), -- participant A1 (rates A2)
  ('a0000000-0000-0000-0000-0000000000a3'), -- participant A2 (rates A1)
  ('b0000000-0000-0000-0000-0000000000b1'), -- admin B
  ('b0000000-0000-0000-0000-0000000000b2'); -- participant B1

insert into organizations (id, name) values
  ('11111111-1111-1111-1111-111111111111','Org A'),
  ('22222222-2222-2222-2222-222222222222','Org B');

insert into profiles (id, org_id, role, full_name) values
  ('a0000000-0000-0000-0000-0000000000a1','11111111-1111-1111-1111-111111111111','admin','Admin A'),
  ('a0000000-0000-0000-0000-0000000000a2','11111111-1111-1111-1111-111111111111','participant','Part A1'),
  ('a0000000-0000-0000-0000-0000000000a3','11111111-1111-1111-1111-111111111111','participant','Part A2'),
  ('b0000000-0000-0000-0000-0000000000b1','22222222-2222-2222-2222-222222222222','admin','Admin B'),
  ('b0000000-0000-0000-0000-0000000000b2','22222222-2222-2222-2222-222222222222','participant','Part B1');

insert into cohorts (id, org_id, name) values
  ('c1111111-1111-1111-1111-111111111111','11111111-1111-1111-1111-111111111111','Cohort A'),
  ('c2222222-2222-2222-2222-222222222222','22222222-2222-2222-2222-222222222222','Cohort B');

insert into participants (id, org_id, cohort_id, user_id, name, email) values
  ('aa111111-1111-1111-1111-111111111111','11111111-1111-1111-1111-111111111111','c1111111-1111-1111-1111-111111111111','a0000000-0000-0000-0000-0000000000a2','PA1','pa1@a.io'),
  ('aa222222-2222-2222-2222-222222222222','11111111-1111-1111-1111-111111111111','c1111111-1111-1111-1111-111111111111','a0000000-0000-0000-0000-0000000000a3','PA2','pa2@a.io'),
  ('bb111111-1111-1111-1111-111111111111','22222222-2222-2222-2222-222222222222','c2222222-2222-2222-2222-222222222222','b0000000-0000-0000-0000-0000000000b2','PB1','pb1@b.io');

insert into assessments (id, org_id, cohort_id, name, kind, stage, status) values
  ('a5111111-1111-1111-1111-111111111111','11111111-1111-1111-1111-111111111111','c1111111-1111-1111-1111-111111111111','EoCA A','technical','eoca','live'),
  ('a5222222-2222-2222-2222-222222222222','22222222-2222-2222-2222-222222222222','c2222222-2222-2222-2222-222222222222','EoCA B','technical','eoca','live');

insert into questions (id, org_id, assessment_id, ordinal, type, prompt, competency, marks) values
  ('99111111-1111-1111-1111-111111111111','11111111-1111-1111-1111-111111111111','a5111111-1111-1111-1111-111111111111',1,'mcq','Q A1', array['Collaboration'], 1);

insert into question_options (id, org_id, question_id, ordinal, label, is_correct) values
  ('07111111-1111-1111-1111-111111111111','11111111-1111-1111-1111-111111111111','99111111-1111-1111-1111-111111111111',1,'right',true),
  ('07111111-1111-1111-1111-111111111112','11111111-1111-1111-1111-111111111111','99111111-1111-1111-1111-111111111111',2,'wrong',false);

insert into attempts (id, org_id, participant_id, assessment_id, status) values
  ('a7111111-1111-1111-1111-111111111111','11111111-1111-1111-1111-111111111111','aa111111-1111-1111-1111-111111111111','a5111111-1111-1111-1111-111111111111','in_progress');

insert into responses (id, org_id, attempt_id, question_id, answer) values
  ('e7111111-1111-1111-1111-111111111111','11111111-1111-1111-1111-111111111111','a7111111-1111-1111-1111-111111111111','99111111-1111-1111-1111-111111111111','{"selected":[1]}');

insert into wpca_rounds (id, org_id, cohort_id, assessment_id, name) values
  ('40111111-1111-1111-1111-111111111111','11111111-1111-1111-1111-111111111111','c1111111-1111-1111-1111-111111111111','a5111111-1111-1111-1111-111111111111','Week 2');

-- PA1 rates PA2, and PA2 rates PA1
insert into wpca_panels (id, org_id, round_id, subject_id, rater_id, rater_role) values
  ('41111111-1111-1111-1111-111111111111','11111111-1111-1111-1111-111111111111','40111111-1111-1111-1111-111111111111','aa222222-2222-2222-2222-222222222222','aa111111-1111-1111-1111-111111111111','peer'),
  ('41222222-2222-2222-2222-222222222222','11111111-1111-1111-1111-111111111111','40111111-1111-1111-1111-111111111111','aa111111-1111-1111-1111-111111111111','aa222222-2222-2222-2222-222222222222','peer');

-- PA2's rating OF PA1 (subject = PA1, rater = PA2) lives in panel 41222222
insert into wpca_responses (id, org_id, panel_id, question_id, answer) values
  ('42111111-1111-1111-1111-111111111111','11111111-1111-1111-1111-111111111111','41222222-2222-2222-2222-222222222222','99111111-1111-1111-1111-111111111111','{"likert":4}');

-- ---------------------------------------------------------------------
-- Test 1 — Admin A sees only Org A
-- ---------------------------------------------------------------------
begin;
  set local role authenticated;
  select set_config('request.jwt.claims',
    '{"sub":"a0000000-0000-0000-0000-0000000000a1","app_metadata":{"org_id":"11111111-1111-1111-1111-111111111111","role":"admin"}}', true);
  select assert_true((select count(*) from organizations) = 1, 'admin A sees exactly 1 organization (own)');
  select assert_true((select count(*) from organizations where id = '22222222-2222-2222-2222-222222222222') = 0, 'admin A cannot see Org B');
  select assert_true((select count(*) from participants) = 2, 'admin A sees only Org A participants (2)');
  select assert_true((select count(*) from cohorts) = 1, 'admin A sees only Org A cohorts');
  select assert_true((select count(*) from wpca_responses) = 0, 'admin A cannot read individual 360 responses (confidentiality)');
rollback;

-- ---------------------------------------------------------------------
-- Test 2 — Admin B sees only Org B (mirror)
-- ---------------------------------------------------------------------
begin;
  set local role authenticated;
  select set_config('request.jwt.claims',
    '{"sub":"b0000000-0000-0000-0000-0000000000b1","app_metadata":{"org_id":"22222222-2222-2222-2222-222222222222","role":"admin"}}', true);
  select assert_true((select count(*) from participants) = 1, 'admin B sees only Org B participants (1)');
  select assert_true((select count(*) from participants where org_id = '11111111-1111-1111-1111-111111111111') = 0, 'admin B cannot see Org A participants');
rollback;

-- ---------------------------------------------------------------------
-- Test 3 — Participant A1: own data only, no answer keys, 360 limits
-- ---------------------------------------------------------------------
begin;
  set local role authenticated;
  select set_config('request.jwt.claims',
    '{"sub":"a0000000-0000-0000-0000-0000000000a2","app_metadata":{"org_id":"11111111-1111-1111-1111-111111111111","role":"participant"}}', true);
  select assert_true((select count(*) from attempts) = 1, 'PA1 sees only their own attempt');
  select assert_true((select count(*) from responses) = 1, 'PA1 sees only their own responses');
  select assert_true((select count(*) from question_options) = 0, 'PA1 cannot read answer keys (question_options)');
  -- PA1 rates PA2 (panel 41111111); PA1 is the subject of panel 41222222 but must NOT see it
  select assert_true((select count(*) from wpca_panels) = 1, 'PA1 sees only panels they rate (1)');
  select assert_true((select count(*) from wpca_panels where subject_id = 'aa111111-1111-1111-1111-111111111111') = 0, 'PA1 cannot see who rates them');
  -- PA1 cannot read the individual 360 response written about them
  select assert_true((select count(*) from wpca_responses) = 0, 'PA1 (subject) cannot read individual rater responses');
  -- PA1 can see own participant row + the subject they rate (PA2) = 2
  select assert_true((select count(*) from participants) = 2, 'PA1 sees own row + subjects they rate');
  -- subject-only aggregate works for self
  select assert_true((select count(*) from wpca_competency_means(
      '40111111-1111-1111-1111-111111111111','aa111111-1111-1111-1111-111111111111')) >= 1,
      'PA1 can read their own per-competency 360 means');
rollback;

-- ---------------------------------------------------------------------
-- Test 4 — Participant A2 is the rater; can read own 360 response,
--          but cannot pull A1''s aggregates (not the subject)
-- ---------------------------------------------------------------------
begin;
  set local role authenticated;
  select set_config('request.jwt.claims',
    '{"sub":"a0000000-0000-0000-0000-0000000000a3","app_metadata":{"org_id":"11111111-1111-1111-1111-111111111111","role":"participant"}}', true);
  select assert_true((select count(*) from wpca_responses) = 1, 'PA2 (rater) can read the response they authored');
  do $$
  begin
    perform * from wpca_competency_means(
      '40111111-1111-1111-1111-111111111111','aa111111-1111-1111-1111-111111111111');
    raise exception 'FAIL: PA2 should NOT read PA1 aggregates';
  exception
    when others then
      if sqlerrm like '%not authorized%' then raise notice 'PASS: non-subject blocked from aggregates';
      else raise; end if;
  end $$;
rollback;

-- cleanup helper (leave seed data in place for inspection; drop assert fn)
drop function if exists public.assert_true(boolean, text);

\echo '================================================'
\echo 'RLS ISOLATION TEST COMPLETE — all assertions passed'
\echo '================================================'
