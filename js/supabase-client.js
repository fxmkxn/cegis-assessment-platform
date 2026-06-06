/* ============================================================
   SUPABASE BROWSER CLIENT
   One shared client for the whole app. Uses ONLY the anon key.
   Everything it can read/write is gated by RLS in the database.

   Later phases use `sb` for auth, table reads/writes, RPCs,
   Realtime, Storage, and invoking the two Edge Functions.
   ============================================================ */
(function initSupabase() {
  var cfg = window.CONFIG || {};
  var placeholder = !cfg.SUPABASE_URL ||
    cfg.SUPABASE_URL.indexOf('YOUR_PROJECT_REF') !== -1 ||
    cfg.SUPABASE_ANON_KEY.indexOf('YOUR_SUPABASE_ANON_KEY') !== -1;

  if (placeholder) {
    console.warn(
      '[CEGIS] config.js still has placeholder Supabase values. ' +
      'The app runs against sample data until you set SUPABASE_URL and ' +
      'SUPABASE_ANON_KEY (Supabase Dashboard → Project Settings → API).'
    );
  }

  // The supabase-js v2 UMD bundle exposes a global `supabase` with createClient.
  // We name our client `sb` so it does not shadow that global.
  if (window.supabase && typeof window.supabase.createClient === 'function') {
    window.sb = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY);
  } else {
    console.error('[CEGIS] supabase-js failed to load from CDN.');
    window.sb = null;
  }
})();

// Helper for invoking an Edge Function by short name (used in later phases).
function edgeFunctionUrl(name) {
  return (window.CONFIG.SUPABASE_URL || '').replace(/\/+$/, '') + '/functions/v1/' + name;
}
