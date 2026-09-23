import { readCompany } from './company.mjs';
export const MAX_PDF_BYTES = 8 * 1024 * 1024;
export const MAX_BODY_BYTES = Math.ceil(MAX_PDF_BYTES / 3) * 4 + 8192;
export class AuditError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}
export async function readBody(req) {
  if (!req.headers.get('content-type')?.includes('application/json')) throw new AuditError(415, 'CONTENT_TYPE', 'Invia una richiesta JSON.');
  if (Number(req.headers.get('content-length')) > MAX_BODY_BYTES) throw new AuditError(413, 'TOO_LARGE', 'PDF troppo grande: massimo 8 MB.');
  if (!req.body) throw new AuditError(400, 'EMPTY_BODY', 'Richiesta vuota.');
  const reader = req.body.getReader(), decoder = new TextDecoder();
  let size = 0, body = '';
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY_BYTES) { await reader.cancel(); throw new AuditError(413, 'TOO_LARGE', 'PDF troppo grande: massimo 8 MB.'); }
      body += decoder.decode(value, { stream: true });
    }
    body += decoder.decode();
    return JSON.parse(body);
  } catch (e) {
    if (e instanceof AuditError) throw e;
    throw new AuditError(400, 'INVALID_JSON', 'Richiesta JSON non valida.');
  } finally { reader.releaseLock(); }
}
export function validateInput(input) {
  if (!input || typeof input !== 'object' || typeof input.fileBase64 !== 'string' ||
      typeof input.fileName !== 'string' || !input.fileName.trim() || input.fileName.length > 255 ||
      (input.contextType != null && (typeof input.contextType !== 'string' || input.contextType.length > 200))) {
    throw new AuditError(400, 'INVALID_INPUT', 'Nome file, contesto o PDF non validi.');
  }
  const base64 = input.fileBase64;
  if (base64.length > Math.ceil(MAX_PDF_BYTES / 3) * 4) throw new AuditError(413, 'TOO_LARGE', 'PDF troppo grande: massimo 8 MB.');
  if (!base64 || base64.length % 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) throw new AuditError(400, 'INVALID_PDF', 'PDF non valido.');
  let binary;
  try { binary = atob(base64); } catch { throw new AuditError(400, 'INVALID_PDF', 'PDF non valido.'); }
  if (!binary.startsWith('%PDF-')) throw new AuditError(400, 'INVALID_PDF', 'Il file ricevuto non è un PDF.');
  if (binary.length > MAX_PDF_BYTES) throw new AuditError(413, 'TOO_LARGE', 'PDF troppo grande: massimo 8 MB.');
  return { fileName: input.fileName.replace(/[\/\\\x00-\x1f]/g, '_'), contextType: input.contextType || 'Generico', fileBase64: base64,
    bytes: Uint8Array.from(binary, char => char.charCodeAt(0)) };
}
export const resultSchema = {
  type: 'OBJECT', required: ['stato_generale', 'controlli', 'email_sollecito', 'impresa'],
  properties: {
    stato_generale: { type: 'STRING', enum: ['NESSUNA_CRITICITA_RILEVATA', 'DA_VERIFICARE', 'CRITICITA_RILEVATE'] },
    controlli: { type: 'ARRAY', items: { type: 'OBJECT', required: ['documento', 'stato', 'dettaglio'], properties: {
      documento: { type: 'STRING' }, stato: { type: 'STRING', enum: ['VERDE', 'GIALLO', 'ROSSO'] }, dettaglio: { type: 'STRING' }
    } } },
    email_sollecito: { type: 'STRING' },
    impresa: { type: 'OBJECT', required: ['identificazione', 'nome', 'identificativo_fiscale', 'evidenza'], properties: {
      identificazione: { type: 'STRING', enum: ['CERTA', 'INCERTA'] },
      nome: { type: 'STRING' }, identificativo_fiscale: { type: 'STRING' }, evidenza: { type: 'STRING' }
    } }
  }
};
export function parseResult(raw) {
  let value;
  try { value = JSON.parse(raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')); } catch { /* rejected below */ }
  const string = (v, max) => typeof v === 'string' && v.length <= max;
  if (!value || !resultSchema.properties.stato_generale.enum.includes(value.stato_generale) ||
      !Array.isArray(value.controlli) || !value.controlli.length || value.controlli.length > 100 ||
      !string(value.email_sollecito, 12000) || value.controlli.some(c => !c || !string(c.documento, 500) || !c.documento.trim() ||
        !string(c.dettaglio, 4000) || !c.dettaglio.trim() || !['VERDE','GIALLO','ROSSO'].includes(c.stato))) {
    throw new AuditError(502, 'INVALID_AI_RESULT', 'L’analisi non ha prodotto un risultato utilizzabile. La scansione non viene conteggiata.');
  }
  const controlli = value.controlli.map(({ documento, stato, dettaglio }) => ({ documento, stato, dettaglio }));
  // Never show an all-clear summary above a yellow/red finding.
  const stato_generale = controlli.some(c => c.stato === 'ROSSO') ? 'CRITICITA_RILEVATE'
    : controlli.some(c => c.stato === 'GIALLO') ? 'DA_VERIFICARE' : value.stato_generale;
  return { stato_generale, controlli, email_sollecito: value.email_sollecito, impresa: readCompany(value.impresa) };
}
