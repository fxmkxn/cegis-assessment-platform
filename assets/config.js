// CEGIS Assessment Platform - configuration
// Fill in the two values below with your own Supabase project settings.
// Dashboard > Project Settings > API.
//
// The anon key is SAFE to ship in the browser: Row-Level Security (set up in
// db/schema.sql) is what actually protects the data, not the key. Never put
// the service_role key in any of these files - it is not needed here because
// scoring, participant creation, and rater finalisation all run inside the
// database as SECURITY DEFINER functions.
window.CEGIS_CONFIG = {
  SUPABASE_URL: "https://YOUR-PROJECT.supabase.co",
  SUPABASE_ANON_KEY: "your-anon-public-key"
};
