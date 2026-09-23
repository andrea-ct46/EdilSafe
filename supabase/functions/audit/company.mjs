// Extraction is advisory: ambiguity must never silently assign a document.
export function readCompany(value) {
  if (!value || value.identificazione !== 'CERTA' || typeof value.nome !== 'string' ||
      !value.nome.trim() || value.nome.length > 200 || typeof value.evidenza !== 'string' ||
      !value.evidenza.trim() || value.evidenza.length > 1000) return null;
  let tax = typeof value.identificativo_fiscale === 'string' ? value.identificativo_fiscale.replace(/[\s.-]/g, '').toUpperCase() : '';
  if (/^IT[0-9]{11}$/.test(tax)) tax = tax.slice(2);
  return { nome: value.nome.trim(), identificativo_fiscale: /^[A-Z0-9]{8,20}$/.test(tax) ? tax : '', evidenza: value.evidenza.trim() };
}
export async function companyFolder(company, storage, owner) {
  if (!company) return 'Da_classificare';
  const tax = company.identificativo_fiscale;
  // Reuse an existing company's folder even if the PDF spells its name differently.
  if (tax) {
    for (let offset = 0; ; offset += 100) {
      const { data, error } = await storage.list(owner, { limit: 100, offset, sortBy: { column: 'name', order: 'asc' } });
      if (error) throw error;
      const found = data.find(f => !f.id && f.name.endsWith(`__${tax}`));
      if (found) return found.name;
      if (data.length < 100) break;
    }
  }
  const normalized = company.nome.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(company.nome.toUpperCase())))).slice(0, 8).map(x => x.toString(16).padStart(2, '0')).join('');
  const name = normalized.slice(0, 100) || `IMPRESA_${digest}`;
  return tax ? `${name}__${tax}` : normalized.length > 100 ? `${name}_${digest}` : name;
}
