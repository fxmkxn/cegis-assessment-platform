/* ============================================================
   CEGIS — js/credentials.js  (Phase 6, front end)

   Drives the "Generate credentials" action on the Cohorts screen:
   a mode chooser (magic-link invite vs. generated passwords), the
   Edge Function call, and a results panel that shows generated
   passwords ONCE with a download + a clear "won't be shown again"
   warning.

   Globals it relies on (all defined in earlier phases):
     sb                     — shared Supabase client (supabase-client.js)
     mountOctopus(el, msg)  — loading indicator (octopus.js)
     showModal / closeModal — modal (components.js)
     toast(msg, type)       — toast (components.js)

   Load order: add <script src="js/credentials.js"></script> AFTER
   components.js / db.js and BEFORE app.js in index.html.
   ============================================================ */

/* Resolve the currently selected cohort. Phase 5 wires the cohort
   selector (#cohortSel); we read the id from its option value. If your
   Phase-5 build stores the active cohort id somewhere else, point this
   helper at it — that's the only place this module is coupled to your
   state shape. */
function currentCohort() {
  const sel = document.getElementById('cohortSel');
  if (sel && sel.value) {
    const opt = sel.options[sel.selectedIndex];
    return { id: sel.value, name: opt ? opt.text : '' };
  }
  if (window.state && window.state.cohortId) {
    return { id: window.state.cohortId, name: window.state.cohortName || '' };
  }
  return { id: null, name: '' };
}

/* Entry point for the toolbar button. */
function generateCredentialsForCurrentCohort() {
  const c = currentCohort();
  openGenerateCredentials(c.id, c.name);
}

/* Step 1 — choose how participants receive access. */
function openGenerateCredentials(cohortId, cohortName) {
  if (!cohortId) { toast('Select a cohort first', 'err'); return; }
  const optStyle =
    'display:flex;gap:11px;align-items:flex-start;border:1.5px solid var(--g200);' +
    'border-radius:10px;padding:12px 14px;margin-bottom:10px;cursor:pointer';
  showModal({
    title: 'Generate participant credentials',
    body:
      `<p class="muted small" style="margin-bottom:14px">Creates a login for every ` +
      `participant in <b>${cohortName || 'this cohort'}</b> who doesn't have one yet ` +
      `(those imported but not yet activated). Already-active participants are skipped.</p>` +
      `<label style="${optStyle}"><input type="radio" name="credMode" value="invite" checked style="margin-top:3px">` +
      `<div><b>Email a magic-link invite</b><div class="muted small">More secure default. Each ` +
      `person gets an email and sets their own password. Requires email/SMTP configured in your ` +
      `Supabase project.</div></div></label>` +
      `<label style="${optStyle}"><input type="radio" name="credMode" value="password" style="margin-top:3px">` +
      `<div><b>Generate passwords</b><div class="muted small">A random password per person, shown to ` +
      `you <b>once</b> for manual distribution. Works without any email setup.</div></div></label>`,
    confirm: 'Generate',
    onConfirm: () => {
      const picked = document.querySelector('input[name="credMode"]:checked');
      const mode = picked ? picked.value : 'invite';
      closeModal();
      runGenerateCredentials(cohortId, cohortName, mode);
    },
  });
}

/* Step 2 — call the Edge Function (octopus while it runs). */
function runGenerateCredentials(cohortId, cohortName, mode) {
  const main = document.querySelector('.main');
  if (!main) return;
  const prev = main.innerHTML;
  mountOctopus(main, mode === 'invite' ? 'Sending invitations…' : 'Generating credentials…');

  invokeGenerateCredentials(cohortId, mode)
    .then((res) => { main.innerHTML = prev; renderCredentialResults(res, cohortName); })
    .catch((err) => { main.innerHTML = prev; toast('Credential generation failed: ' + err.message, 'err'); });
}

/* supabase-js forwards the signed-in user's access token automatically,
   so the Edge Function can identify and authorize the caller. */
async function invokeGenerateCredentials(cohortId, mode) {
  const { data, error } = await sb.functions.invoke('generate-credentials', {
    body: { cohort_id: cohortId, mode: mode, redirect_to: window.location.origin },
  });
  if (error) {
    // surface the function's JSON { error } body when present
    let msg = error.message || 'request failed';
    try {
      if (error.context && typeof error.context.json === 'function') {
        const ctx = await error.context.json();
        if (ctx && ctx.error) msg = ctx.error;
      }
    } catch (_) { /* keep generic message */ }
    throw new Error(msg);
  }
  if (data && data.error) throw new Error(data.error);
  return data;
}

/* Step 3 — results. In password mode, list the one-time passwords with
   a download and a permanent-loss warning. */
function renderCredentialResults(res, cohortName) {
  const made = (res.created || 0) + (res.invited || 0);
  const verb = res.mode === 'invite' ? 'invited' : 'created';
  toast(`${made} ${verb}` + (res.skipped ? `, ${res.skipped} skipped` : '') +
    (res.failed ? `, ${res.failed} failed` : ''), res.failed ? 'err' : 'ok');

  const withPw = (res.results || []).filter((r) => r.status === 'created' && r.password);

  let rows = (res.results || []).map((r) => {
    const badge = r.status === 'created' || r.status === 'invited'
      ? `<span class="badge ok">${r.status}</span>`
      : r.status === 'skipped'
        ? `<span class="badge warn">skipped${r.reason ? ' · ' + r.reason : ''}</span>`
        : `<span class="badge err">failed${r.reason ? ' · ' + r.reason : ''}</span>`;
    const pw = r.password
      ? `<code style="font-size:12.5px;background:var(--g100);padding:2px 7px;border-radius:6px">${r.password}</code>`
      : '<span class="muted small">—</span>';
    return `<tr><td><b>${r.name || '—'}</b></td><td class="muted small">${r.email || '—'}</td>` +
      `<td>${badge}</td><td>${pw}</td></tr>`;
  }).join('');

  const warn = withPw.length
    ? `<div class="card pad" style="background:var(--warn-l);border-color:var(--warn);margin-bottom:14px">
         <b>⚠ These passwords are shown only once.</b>
         <span class="muted small"> They are not stored anywhere and cannot be retrieved again. Download or
         copy them now, distribute them securely, and ask participants to change their password after first login.</span>
       </div>`
    : '';
  const dl = withPw.length
    ? `<button class="btn ghost sm" onclick="downloadCredentialsCsv()">⤓ Download CSV</button>`
    : '';

  window.__credCsv = withPw.map((r) => ({ name: r.name, email: r.email, password: r.password }));
  window.__credCohort = cohortName || 'cohort';

  const main = document.querySelector('.main');
  main.innerHTML =
    `<div class="crumb">Cohorts / Credentials</div>
     <div class="page-head"><h1>Credentials — ${cohortName || ''}</h1>
       <div class="flex g12 ac">${dl}<button class="btn ghost" onclick="go('roster')">← Back to cohort</button></div></div>
     ${warn}
     <div class="grid" style="grid-template-columns:repeat(4,1fr);margin-bottom:18px">
       <div class="card pad"><div style="font-size:24px;font-weight:700" class="tnum">${res.created || 0}</div><div class="muted small">Passwords created</div></div>
       <div class="card pad"><div style="font-size:24px;font-weight:700" class="tnum">${res.invited || 0}</div><div class="muted small">Invites sent</div></div>
       <div class="card pad"><div style="font-size:24px;font-weight:700" class="tnum">${res.skipped || 0}</div><div class="muted small">Skipped</div></div>
       <div class="card pad"><div style="font-size:24px;font-weight:700;color:${res.failed ? 'var(--err)' : 'inherit'}" class="tnum">${res.failed || 0}</div><div class="muted small">Failed</div></div>
     </div>
     <div class="card"><div style="overflow:auto"><table>
       <thead><tr><th>Name</th><th>Email</th><th>Status</th><th>${res.mode === 'invite' ? 'Note' : 'Password (once)'}</th></tr></thead>
       <tbody>${rows || '<tr><td colspan="4" class="muted small" style="padding:18px">No participants needed credentials.</td></tr>'}</tbody>
     </table></div></div>`;
}

/* Client-side CSV of the one-time passwords for distribution. */
function downloadCredentialsCsv() {
  const data = window.__credCsv || [];
  if (!data.length) { toast('Nothing to download', 'err'); return; }
  const esc = (s) => '"' + String(s == null ? '' : s).replace(/"/g, '""') + '"';
  const csv = ['name,email,password']
    .concat(data.map((r) => [esc(r.name), esc(r.email), esc(r.password)].join(',')))
    .join('\r\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'credentials_' + String(window.__credCohort).replace(/[^a-z0-9]+/gi, '_') + '.csv';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(a.href);
}
