export const MAX_PDF_BYTES = 8 * 1024 * 1024;

export function toBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 32768) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 32768));
  }
  return btoa(binary);
}

export async function pdfBase64(file) {
  if (!/\.pdf$/i.test(file.name) || file.size === 0 || file.size > MAX_PDF_BYTES) {
    throw new Error('Scegli un PDF non vuoto, fino a 8 MB.');
  }
  const buffer = await file.arrayBuffer();
  const header = new TextDecoder().decode(buffer.slice(0, 5));
  if (header !== '%PDF-') throw new Error('Il contenuto del file non è un PDF valido.');
  return toBase64(buffer);
}

export function validateResult(data) {
  if (!data || typeof data.stato_generale !== 'string' || !Array.isArray(data.controlli) || !data.controlli.length ||
      data.controlli.some(c => !c || typeof c.documento !== 'string' || typeof c.dettaglio !== 'string' || !['VERDE', 'GIALLO', 'ROSSO'].includes(c.stato))) {
    throw new Error('Risposta di analisi incompleta: riprova.');
  }
  return data;
}

export async function processFiles(files, analyze, onProgress = () => {}) {
  const results = [];
  for (const [index, file] of files.entries()) {
    onProgress(index + 1, files.length, file.name);
    try {
      results.push({ name: file.name, data: validateResult(await analyze(file)) });
    } catch (error) {
      results.push({ name: file.name, error: error.message || 'Analisi non riuscita.' });
    }
  }
  return results;
}
