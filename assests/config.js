// CEGIS Assessment Platform - configuration
// Fill in the two values below with your own Supabase project settings.
// Dashboard > Project Settings > API.
//
// The anon key is SAFE to ship in the browser: Row-Level Security (set up in
// db/schema.sql) is what actually protects the data, not the key. Never put
// the service_role key in any of these files - it is not needed here because
// scoring and respondent creation run inside the database as SECURITY DEFINER
// functions.
window.CEGIS_CONFIG = {
  SUPABASE_URL: "https://lmjivbgakpmvubodopju.supabase.co",
  SUPABASE_ANON_KEY: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imxtaml2Ymdha3BtdnVib2RvcGp1Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODA2NDA5NzYsImV4cCI6MjA5NjIxNjk3Nn0.uENFe_mVRLpj5c593AZ5isHddhIH-xGtrxlVkG3fpZ8"
};
