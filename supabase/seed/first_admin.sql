-- =====================================================================
-- SEED THE FIRST TENANT (org + its single admin)
--
-- Signup is admin-driven, so the very first admin is created out-of-band.
-- This is the no-local-tooling path (runs in the Supabase SQL editor):
--
-- STEP 1 (dashboard): Authentication → Users → "Add user"
--   - Email:    the admin's email
--   - Password: a password you'll hand to them
--   - Tick "Auto Confirm User" so they can log in immediately
--
-- STEP 2 (here): edit the two values below and run this whole block.
--   It creates the organization and links that auth user as its one admin.
--   (The SQL editor runs as a superuser, so it bypasses RLS for this seed.)
--
-- STEP 3: make sure the access-token hook is enabled
--   (Authentication → Hooks → Customize Access Token). Then the admin
--   signs in — their JWT will carry org_id + role, and the app loads.
--   If they signed in before this seed, have them sign out and back in.
-- =====================================================================

do $$
declare
  v_admin_email text := 'admin@yourorg.org';            -- <-- EDIT: must match the user you added
  v_org_name    text := 'CEGIS — Personnel Management';  -- <-- EDIT: your organization name
  v_admin_name  text := 'Program Admin';                 -- <-- EDIT: display name
  v_user_id     uuid;
  v_org_id      uuid;
begin
  select id into v_user_id from auth.users where email = lower(v_admin_email);
  if v_user_id is null then
    raise exception 'No auth user with email %. Create them first in Authentication → Users.', v_admin_email;
  end if;

  if exists (select 1 from public.profiles where id = v_user_id) then
    raise notice 'Profile already exists for % — nothing to do.', v_admin_email;
    return;
  end if;

  insert into public.organizations (name) values (v_org_name) returning id into v_org_id;
  insert into public.profiles (id, org_id, role, full_name)
  values (v_user_id, v_org_id, 'admin', v_admin_name);

  raise notice 'Seeded org % with admin %', v_org_id, v_admin_email;
end $$;
