import { pdfBase64, processFiles } from './core.mjs';

const client = window.supabase.createClient('https://tknjthnrqunkehcqdnrj.supabase.co', 'sb_publishable_L5SprRAfCuKNZ-GIwT_1tw_iuknN81x');
const $ = id => document.getElementById(id);
let selectedFiles = [], registering = false, profile = null, user = null, busy = false, failedFiles = [], failedContext = null;
client.auth.onAuthStateChange(event => { if (event === 'SIGNED_OUT') clearPrivateView(); });

function text(tag, value, className = '') {
  const element = document.createElement(tag);
  element.textContent = value;
  element.className = className;
  return element;
}
function authMessage(message, error = true) {
  $('authMessage').textContent = message;
  $('authMessage').className = `text-xs text-center mt-2 ${error ? 'text-rose-600' : 'text-emerald-600'}`;
}
function clearPrivateView() {
  user = null; profile = null; selectedFiles = []; failedFiles = []; failedContext = null;
  $('fileInput').value = ''; $('fileName').textContent = '';
  $('checkList').replaceChildren(); $('emailBox').value = ''; $('historyList').replaceChildren(); $('printEmail')?.remove();
  $('fileManagerList').replaceChildren(); $('burgerDropdown').classList.add('hidden');
  $('results').classList.add('hidden'); $('dashboardView').classList.add('hidden');
  $('loginView').classList.remove('hidden');
}
async function dashboard(nextUser) {
  const { data, error } = await client.from('profili').select('piu_attivo,nome_impresa,scansioni_effettuate,scansioni_periodo').eq('id', nextUser.id).single();
  if (error || !data) throw new Error('Impossibile caricare il profilo. Riprova tra poco.');
  user = nextUser; profile = data;
  $('loginView').classList.add('hidden'); $('dashboardView').classList.remove('hidden');
  const used = profile.scansioni_periodo?.slice(0, 7) === new Date().toISOString().slice(0, 7) ? (profile.scansioni_effettuate || 0) : 0;
  $('pianoBadge').textContent = profile.piu_attivo ? 'Piano: EdilSafe+' : `Piano Free: ${Math.max(0, 5 - used)}/5 scansioni`;
  $('btnBurger').classList.toggle('opacity-60', !profile.piu_attivo);
  $('btnBurger').textContent = profile.piu_attivo ? '📁 Archivio cloud' : '📁 Archivio Plus 🔒';
  await history();
}

$('btnToggleMode').addEventListener('click', () => {
  registering = !registering;
  $('extraFields').classList.toggle('hidden', !registering);
  $('btnLogin').textContent = registering ? 'Registrati ora' : 'Accedi';
  $('btnToggleMode').textContent = registering ? 'Hai già un account? Accedi' : 'Non hai un account? Registrati';
  $('authMessage').classList.add('hidden');
});
$('btnLogin').addEventListener('click', async () => {
  const email = $('emailInput').value.trim(), password = $('passwordInput').value;
  if (!$('emailInput').checkValidity() || !email || password.length < 6) return authMessage('Inserisci email e password valide.');
  if (registering && !$('impresaInput').value.trim()) return authMessage('Inserisci il nome impresa.');
  $('btnLogin').disabled = true; $('btnToggleMode').disabled = true;
  try {
    const { data, error } = registering
      ? await client.auth.signUp({ email, password, options: { data: { nome_impresa: $('impresaInput').value.trim(), p_iva: $('pivaInput').value.trim() } } })
      : await client.auth.signInWithPassword({ email, password });
    if (error) throw new Error(registering ? 'Registrazione non riuscita. Verifica i dati e riprova.' : 'Accesso non riuscito. Verifica le credenziali e riprova.');
    if (data.session) await dashboard(data.user);
    else authMessage('Controlla la tua email per confermare la registrazione.', false);
    $('passwordInput').value = '';
  } catch (error) { authMessage(error.message); }
  finally { $('btnLogin').disabled = false; $('btnToggleMode').disabled = false; }
});
$('passwordInput').addEventListener('keydown', e => { if (e.key === 'Enter' && !$('btnLogin').disabled) $('btnLogin').click(); });
$('btnLogout').addEventListener('click', async () => {
  if (busy) return;
  const { error } = await client.auth.signOut();
  if (error) return alert('Uscita non riuscita. Riprova.');
  clearPrivateView();
});

function selectFiles(files) {
  if (busy) return;
  selectedFiles = Array.from(files);
  $('fileName').textContent = selectedFiles.length ? `${selectedFiles.length} file: ${selectedFiles.map(f => f.name).join(', ')}` : 'Nessun file selezionato.';
  $('fileName').classList.remove('hidden');
}
$('dropZone').addEventListener('click', e => { if (!busy && e.target !== $('fileInput')) $('fileInput').click(); });
$('dropZone').addEventListener('keydown', e => { if (['Enter', ' '].includes(e.key)) { e.preventDefault(); if (!busy) $('fileInput').click(); } });
$('dropZone').addEventListener('dragover', e => e.preventDefault());
$('dropZone').addEventListener('drop', e => { e.preventDefault(); selectFiles(e.dataTransfer.files); });
$('fileInput').addEventListener('change', e => selectFiles(e.target.files));

async function analyze(file, contextType) {
  const fileBase64 = await pdfBase64(file);
  const { data: { session }, error } = await client.auth.getSession();
  if (error || !session) throw new Error('Sessione scaduta. Accedi di nuovo.');
  const response = await fetch('https://tknjthnrqunkehcqdnrj.supabase.co/functions/v1/audit', {
    method: 'POST', signal: AbortSignal.timeout(100000),
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` },
    body: JSON.stringify({ contextType, fileName: file.name, fileBase64 })
  });
  const data = await response.json().catch(() => null);
  if (!response.ok || data?.error) throw new Error(data?.error || `Servizio non disponibile (${response.status}).`);
  return data;
}
function renderResults(results) {
  const ok = results.filter(r => !r.error);
  $('results').classList.remove('hidden');
  $('resultsTitle').textContent = ok.length ? 'Report di pre-controllo documentale' : 'Analisi non completata';
  $('btnPrint').classList.toggle('hidden', !ok.length);
  $('btnRetry').classList.toggle('hidden', !failedFiles.length);
  $('statusBanner').textContent = `${ok.length} analizzati • ${results.length - ok.length} non riusciti • ${new Date().toLocaleString('it-IT')}`;
  $('checkList').replaceChildren();
  for (const result of results) {
    const card = text('div', '', 'p-3 bg-slate-50 rounded-lg border border-slate-200 space-y-2');
    card.append(text('h4', result.name, 'font-bold text-sm'));
    if (result.error) card.append(text('p', result.error, 'text-rose-700 text-sm'));
    else {
      card.append(text('p', result.data.stato_generale, 'text-sm font-semibold'));
      for (const check of result.data.controlli) {
        const color = check.stato === 'VERDE' ? 'text-emerald-800' : check.stato === 'ROSSO' ? 'text-rose-800' : 'text-amber-800';
        card.append(text('p', `${check.stato} — ${check.documento}: ${check.dettaglio}`, `text-sm ${color}`));
      }
      for (const warning of result.data.warnings || []) card.append(text('p', warning, 'text-amber-800 text-xs'));
    }
    $('checkList').append(card);
  }
  $('emailBox').value = ok.map(r => typeof r.data.email_sollecito === 'string' && r.data.email_sollecito ? `${r.name}\n${r.data.email_sollecito}` : '').filter(Boolean).join('\n\n');
  $('emailSection').classList.toggle('hidden', !$('emailBox').value);
}
$('btnAnalyze').addEventListener('click', async () => {
  if (busy) return;
  if (!selectedFiles.length) return alert('Seleziona almeno un PDF.');
  busy = true;
  const files = [...selectedFiles], contextType = $('contextType').value, owner = user?.id;
  for (const id of ['btnAnalyze', 'btnRetry', 'btnLogout', 'fileInput', 'contextType']) $(id).disabled = true;
  $('loading').classList.remove('hidden'); $('results').classList.add('hidden');
  try {
    const results = await processFiles(files, file => analyze(file, contextType), (i, total, name) => {
      $('loading').querySelector('p').textContent = `Analisi ${i}/${total}: ${name}`;
    });
    if (!owner || user?.id !== owner) return;
    failedFiles = files.filter((file, index) => results[index]?.error);
    failedContext = contextType;
    renderResults(results);
    try { if (user) await dashboard(user); } catch { $('pianoBadge').textContent = 'Piano da aggiornare'; }
  } finally {
    busy = false; $('loading').classList.add('hidden');
    for (const id of ['btnAnalyze', 'btnRetry', 'btnLogout', 'fileInput', 'contextType']) $(id).disabled = false;
  }
});

$('btnRetry').addEventListener('click', () => {
  if (busy || !failedFiles.length) return;
  selectFiles(failedFiles);
  if (failedContext) $('contextType').value = failedContext;
  $('btnAnalyze').click();
});

async function archive() {
  if (!user || !profile?.piu_attivo) return;
  const owner = user.id;
  const container = $('fileManagerList'); container.textContent = 'Caricamento…';
  try {
    // The UUID path is used by new audits. Existing files stay accessible via owner RLS.
    const legacy = (profile.nome_impresa || 'Impresa_Generica').replace(/[^a-zA-Z0-9]/g, '_');
    const entries = [];
    for (const prefix of [...new Set([owner, legacy])]) {
      for (let offset = 0; ; offset += 100) {
        const { data, error } = await client.storage.from('documenti-cantieri').list(prefix, { limit: 100, offset, sortBy: { column: 'created_at', order: 'desc' } });
        if (error) throw error;
        entries.push(...data.filter(f => f.id).map(f => ({ ...f, path: `${prefix}/${f.name}` })));
        if (data.length < 100) break;
      }
    }
    if (user?.id !== owner) return;
    container.replaceChildren();
    for (const file of entries) {
      const row = text('div', '', 'py-2 space-y-1');
      row.append(text('p', file.name, 'break-all'));
      const open = text('button', 'Apri', 'text-blue-700 mr-3');
      open.addEventListener('click', async () => {
        const { data, error } = await client.storage.from('documenti-cantieri').createSignedUrl(file.path, 60);
        if (error) return alert('Impossibile aprire il documento.');
        const link = document.createElement('a'); link.href = data.signedUrl; link.target = '_blank'; link.rel = 'noopener noreferrer'; link.click();
      });
      const remove = text('button', 'Elimina', 'text-rose-700');
      remove.addEventListener('click', async () => {
        if (!confirm(`Eliminare definitivamente ${file.name}?`)) return;
        remove.disabled = true;
        const { error } = await client.storage.from('documenti-cantieri').remove([file.path]);
        if (error) { remove.disabled = false; return alert('Eliminazione non riuscita.'); }
        await archive();
      });
      row.append(open, remove); container.append(row);
    }
    if (!entries.length) container.textContent = 'Nessun documento archiviato.';
  } catch { if (user?.id === owner) container.textContent = 'Archivio non disponibile. Premi Aggiorna per riprovare.'; }
}
$('btnBurger').addEventListener('click', async e => {
  e.stopPropagation();
  if (!profile?.piu_attivo) return alert('L’archivio cloud è disponibile con EdilSafe+.');
  $('burgerDropdown').classList.toggle('hidden');
  if (!$('burgerDropdown').classList.contains('hidden')) await archive();
});
$('burgerDropdown').addEventListener('click', e => e.stopPropagation());
document.addEventListener('click', () => $('burgerDropdown').classList.add('hidden'));
$('btnRefreshManager').addEventListener('click', archive);
$('btnPrint').addEventListener('click', () => {
  $('printEmail')?.remove();
  const email = text('div', $('emailBox').value, 'hidden'); email.id = 'printEmail';
  $('emailBox').after(email); window.print();
});

try {
  const { data, error } = await client.auth.getSession();
  if (error) throw error;
  if (data.session) await dashboard(data.session.user);
} catch { authMessage('Servizio temporaneamente non disponibile. Riprova ad accedere.'); }

async function history() {
  if (!user) return;
  const owner = user.id;
  $('historyList').textContent = 'Caricamento…';
  const { data, error } = await client.from('audit_runs').select('id,file_name,created_at,result,status').eq('user_id', owner).order('created_at', { ascending: false }).limit(20);
  if (user?.id !== owner) return;
  if (error) { $('historyList').textContent = 'Storico non disponibile. Riprova tra poco.'; return; }
  $('historyList').replaceChildren();
  for (const row of data || []) {
    const item = text('div', '', 'flex flex-wrap justify-between gap-2 border-b py-2');
    item.append(text('span', `${row.file_name} · ${new Date(row.created_at).toLocaleString('it-IT')}`));
    if (row.status === 'completed' && row.result) {
      const open = text('button', 'Apri report', 'text-blue-700');
      open.addEventListener('click', () => { failedFiles = []; renderResults([{ name: row.file_name, data: row.result }]); $('results').scrollIntoView({ behavior: 'smooth' }); });
      item.append(open);
    } else item.append(text('span', row.status === 'running' ? 'In corso' : 'Non riuscita'));
    $('historyList').append(item);
  }
  if (!data?.length) $('historyList').textContent = 'Qui appariranno le prossime verifiche (ultime 20).';
}
$('btnHistory').addEventListener('click', () => history().catch(() => { $('historyList').textContent = 'Storico non disponibile.'; }));
