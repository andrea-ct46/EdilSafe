import test from 'node:test';
import assert from 'node:assert/strict';
import { createHandler } from '../supabase/functions/audit/handler.mjs';
import { parseResult, validateInput, MAX_PDF_BYTES } from '../supabase/functions/audit/validation.mjs';
import { pdfBase64, processFiles, toBase64 } from '../assets/core.mjs';

const result = { stato_generale: 'DA_VERIFICARE', controlli: [{ documento: 'Documento di prova', stato: 'GIALLO', dettaglio: 'Pagina 1: scadenza non indicata.' }], email_sollecito: 'Richiediamo la scadenza.' };
const payload = { fileName: 'prova.pdf', contextType: 'Generico', fileBase64: btoa('%PDF-1.7\nfixture') };
function setup({ providerStatus = 200, providerText = JSON.stringify(result), authError = false, quotaError, storageError = false, plus = false } = {}) {
  const calls = [];
  const admin = { rpc: (name, args) => {
    calls.push({ name, args });
    const value = { data: name === 'reserve_audit' ? quotaError ? { error: quotaError } : { id: 'job-1', is_plus: plus, nome_impresa: 'Studio test' } : true, error: null };
    // PostgREST builders implement PromiseLike.then, not Promise.catch.
    return { then: (resolve, reject) => Promise.resolve(value).then(resolve, reject) };
  } };
  const client = { auth: { getUser: async () => ({ data: { user: authError ? null : { id: 'user-1' } }, error: authError }) }, storage: { from: () => ({ upload: async () => ({ error: storageError }) }) } };
  const handler = createHandler({ createClient: (url, key) => key === 'service' ? admin : client, env: name => ({ SUPABASE_URL: 'https://example.test', SUPABASE_ANON_KEY: 'anon', SUPABASE_SERVICE_ROLE_KEY: 'service', GEMINI_API_KEY: 'test' })[name],
    fetcher: async () => { calls.push({ name: 'provider' }); return new Response(JSON.stringify({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: providerText }] } }] }), { status: providerStatus }); }, logger: { error() {} } });
  return { handler, calls };
}
const request = (body = payload, token = 'Bearer test') => new Request('https://example.test/audit', { method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: token } : {}) }, body: JSON.stringify(body) });

test('large Base64 encoding has no argument-stack overflow and round trips', () => {
  const input = new Uint8Array(MAX_PDF_BYTES).fill(65);
  assert.equal(atob(toBase64(input.buffer)).length, input.length);
});
test('PDF validation rejects disguised files and oversized bodies', async () => {
  await assert.rejects(pdfBase64(new File(['not a PDF'], 'prova.pdf')), /non è un PDF/);
  assert.throws(() => validateInput({ ...payload, fileBase64: btoa('not pdf') }), /non è un PDF/);
  assert.throws(() => validateInput({ ...payload, fileBase64: 'A'.repeat(Math.ceil(MAX_PDF_BYTES / 3) * 4 + 4) }), /troppo grande/);
});
test('batch continues after one failure and preserves original file names', async () => {
  const out = await processFiles([{ name: 'a.pdf' }, { name: 'b.pdf' }], async f => { if (f.name === 'a.pdf') throw new Error('failure'); return { ...result, nome: 'untrusted.pdf' }; });
  assert.equal(out[0].error, 'failure'); assert.equal(out[1].name, 'b.pdf'); assert.ok(out[1].data);
});
test('missing and invalid auth cannot reserve quota or call AI', async () => {
  for (const token of [null, 'Bearer test']) {
    const { handler, calls } = setup({ authError: true });
    assert.equal((await handler(request(payload, token))).status, 401); assert.equal(calls.length, 0);
  }
});
test('invalid input does not reserve quota', async () => {
  const { handler, calls } = setup();
  assert.equal((await handler(request({ ...payload, fileName: null }))).status, 400); assert.equal(calls.length, 0);
});
test('exhausted quota does not call provider', async () => {
  const { handler, calls } = setup({ quotaError: 'QUOTA_EXCEEDED' });
  assert.equal((await handler(request())).status, 403); assert.deepEqual(calls.map(c => c.name), ['reserve_audit']);
});
test('provider errors release the quota reservation', async () => {
  const { handler, calls } = setup({ providerStatus: 500 });
  assert.equal((await handler(request())).status, 503); assert.equal(calls.at(-1).args.p_error_code, 'AI_PROVIDER_500');
  assert.equal(calls.filter(c => c.name === 'provider').length, 3);
});
test('empty or malformed AI result is an error and refunds quota', async () => {
  for (const providerText of ['{}', 'not JSON', JSON.stringify({ ...result, controlli: [] })]) {
    const { handler, calls } = setup({ providerText });
    assert.equal((await handler(request())).status, 502); assert.equal(calls.at(-1).args.p_error_code, 'INVALID_AI_RESULT');
  }
});
test('summary cannot claim all-clear above a red finding', () => {
  const value = parseResult(JSON.stringify({ ...result, stato_generale: 'NESSUNA_CRITICITA_RILEVATA', controlli: [{ ...result.controlli[0], stato: 'ROSSO' }] }));
  assert.equal(value.stato_generale, 'CRITICITA_RILEVATE');
});
test('successful audit persists history and warns on archive failure', async () => {
  const { handler, calls } = setup({ plus: true, storageError: true });
  const response = await handler(request()); const body = await response.json();
  assert.equal(response.status, 200); assert.equal(body.warnings.length, 1);
  assert.equal(calls.at(-1).args.p_error_code, null); assert.deepEqual(calls.at(-1).args.p_result, body);
});
