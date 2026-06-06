-- =====================================================================
-- RLS SMOKE CHECK
-- Safe to run in the Supabase SQL editor on any project (read-only;
-- inserts nothing). Confirms RLS is enabled everywhere and the Phase 3
-- objects exist. For full cross-org isolation proof, run
-- rls_isolation_test.sql against a local/throwaway database instead.
-- =====================================================================

-- 1) Every public table has RLS enabled (expect 15 rows, all true)
select relname as table_name, relrowsecurity as rls_enabled
from pg_class c join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relkind = 'r'
order by relname;

-- 2) Any table WITHOUT RLS would show up here (expect 0 rows)
select relname as tables_missing_rls
from pg_class c join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relkind = 'r' and relrowsecurity = false;

-- 3) Policy count per table (expect every table to have >= 1)
select tablename, count(*) as policy_count
from pg_policies where schemaname = 'public'
group by tablename order by tablename;

-- 4) Required Phase 3 functions exist
select proname
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and proname in ('auth_org_id','auth_role','my_participant_ids',
                  'my_cohort_ids','wpca_competency_means','custom_access_token_hook')
order by proname;

-- 5) Confidentiality guards: question_options and wpca_responses must have
--    NO policy granting the 'participant'/subject a broad read. These show
--    only the policies that exist on those tables for your review.
select tablename, policyname, cmd
from pg_policies
where schemaname = 'public' and tablename in ('question_options','wpca_responses')
order by tablename, policyname;
