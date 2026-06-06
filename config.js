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
  SUPABASE_URL: 'https://YOUR_PROJECT_REF.supabase.co',
  SUPABASE_ANON_KEY: 'YOUR_SUPABASE_ANON_KEY',

  // Edge Function names (paths are derived from SUPABASE_URL at call time:
  //   `${SUPABASE_URL}/functions/v1/<name>`). Wired up in later phases.
  EDGE_FUNCTIONS: {
    generateCredentials: 'generate-credentials',
    generateReport: 'generate-report'
  }
};
