/* ============================================================
   PUBLIC CONFIG
   These values are PUBLIC by design and safe to commit/ship.
   The browser only ever uses the Supabase project URL + anon key;
   Row Level Security (RLS) is the real access gate.

   NEVER put the service-role key or OPENAI_API_KEY here — those
   live ONLY as Supabase Edge Function secrets (`supabase secrets set ...`).

   Replace the two placeholder values with your project's values from:
   Supabase Dashboard → Project Settings → API
   ============================================================ */
window.CONFIG = {
  SUPABASE_URL: 'https://lmjivbgakpmvubodopju.supabase.co',
  SUPABASE_ANON_KEY: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imxtaml2Ymdha3BtdnVib2RvcGp1Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODA2NDA5NzYsImV4cCI6MjA5NjIxNjk3Nn0.uENFe_mVRLpj5c593AZ5isHddhIH-xGtrxlVkG3fpZ8',

  // Edge Function names (paths are derived from SUPABASE_URL at call time:
  //   `${SUPABASE_URL}/functions/v1/<name>`). Wired up in later phases.
  EDGE_FUNCTIONS: {
    generateCredentials: 'generate-credentials',
    generateReport: 'generate-report'
  }
};
