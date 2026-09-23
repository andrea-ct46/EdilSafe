import { AuditError } from './validation.mjs';

// Availability retries stay inside one quota reservation and one total deadline.
export async function generateWithFallback({ model, fallbackModel, options, fetcher, delay = ms => new Promise(resolve => setTimeout(resolve, ms)) }) {
  const models = fallbackModel && fallbackModel !== model ? [model, fallbackModel, fallbackModel] : [model, model, model];
  const total = AbortSignal.timeout(60000);
  let lastStatus = 503;
  for (let attempt = 0; attempt < models.length; attempt++) {
    if (total.aborted) break;
    if (attempt) await delay(1000 * 2 ** (attempt - 1) + Math.floor(Math.random() * 250));
    let response;
    try {
      response = await fetcher(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(models[attempt])}:generateContent`, {
        ...options, signal: AbortSignal.any([total, AbortSignal.timeout(30000)])
      });
    } catch (error) {
      if (!['AbortError','TimeoutError','TypeError'].includes(error?.name)) throw error;
      lastStatus = 504;
      continue;
    }
    if (response.ok) return { response, model: models[attempt] };
    lastStatus = response.status;
    await response.body?.cancel();
    if (![408,429,500,502,503,504].includes(lastStatus)) break;
  }
  throw new AuditError(lastStatus === 429 ? 429 : 503, `AI_PROVIDER_${lastStatus}`,
    'Il servizio di analisi non è disponibile anche dopo i tentativi automatici. La scansione non viene conteggiata: puoi riprovare senza ricaricare il PDF.');
}
