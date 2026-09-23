# EdilSafe

Pre-controllo assistito dei documenti di cantiere: PDF, rilievi motivati, bozza di sollecito, archivio Plus e storico personale. I risultati richiedono verifica professionale; non certificano conformità o autenticità.

## Stato di questa modifica

La migrazione e la nuova Edge Function devono essere applicate insieme prima di pubblicare il frontend. Seguire l'ordine di attivazione sotto riportato.

## Struttura

- `index.html`: interfaccia statica, utilizzabile su GitHub Pages.
- `assets/app.js`: autenticazione, upload, report, archivio e storico.
- `assets/core.mjs`: validazione PDF e gestione dei batch.
- `supabase/functions/audit/`: funzione autenticata, validazione input/output e integrazione Gemini.
- `supabase/migrations/20260923120000_secure_audits.sql`: isolamento dei documenti per proprietario, contatore atomico e storico.
- `tests/`: controlli automatizzati.

## Verifica locale

Con Node 24:

```sh
npm ci
npm test
npm run check
python -m http.server 8000
```

Aprire `http://localhost:8000`. L'interfaccia usa il progetto Supabase configurato nel file `assets/app.js`; evitare prove con documenti reali finché migrazione e funzione non sono applicate. Le dipendenze del frontend sono caricate da CDN.

Sono passati 23 test: validazione e batch, gestione errori del backend, interfaccia con DOM simulato, migrazione e policy su PostgreSQL locale (PGlite). I servizi Supabase e Gemini sono simulati nei test del backend; i test database usano uno schema minimo corrispondente ai componenti ispezionati. Non sostituiscono il collaudo del servizio distribuito.

## Attivazione coordinata

1. Applicare la migrazione SQL dopo autorizzazione. Conserva i profili, i contatori e i file esistenti.
2. Distribuire `audit/index.ts`, `audit/handler.mjs`, `audit/validation.mjs` e `audit/deno.json` come Edge Function `audit`. L'entrypoint verifica sempre il token con `auth.getUser()`, anche mantenendo `verify_jwt=false` come nella funzione originale.
3. Verificare le policy e il flusso con un account di prova e un PDF sintetico. Non inviare documenti personali nei test.
4. Pubblicare il frontend della PR solo dopo il passaggio precedente.

La funzione usa `SUPABASE_URL`, `SUPABASE_ANON_KEY` e `SUPABASE_SERVICE_ROLE_KEY` dell'ambiente Edge. Richiede `GEMINI_API_KEY`; il modello principale è configurabile con `GEMINI_MODEL` (default `gemini-3.6-flash`) e il modello di riserva con `GEMINI_FALLBACK_MODEL` (default `gemini-3.5-flash`). In caso di indisponibilità vengono effettuati al massimo tre tentativi, con attesa crescente e un limite totale di 60 secondi. Nessuna chiave segreta deve essere nel repository o nel frontend.

## Comportamento

- Massimo 8 MB per PDF, verificato sia nel browser sia nel server; ogni file ha un esito individuale.
- Token utente verificato prima di leggere il PDF o chiamare l'AI.
- Una prenotazione atomica evita di superare le 5 scansioni Free con richieste contemporanee. Una sola analisi può essere in corso per utente; Plus conserva il comportamento senza limite mensile.
- Le scansioni non riuscite vengono restituite; le prenotazioni interrotte scadono dopo tre minuti e vengono recuperate alla successiva richiesta. Il periodo mensile è UTC; il primo avvio nel nuovo mese azzera il contatore. I numeri preesistenti sono attribuiti al mese della migrazione senza inventare lo storico precedente.
- Solo la funzione server può modificare il contatore e i risultati. Gli utenti possono leggere esclusivamente il proprio profilo e i propri report.
- I documenti vengono autorizzati tramite `owner_id`, non attraverso il nome dell'impresa. Le cartelle esistenti sono mantenute per compatibilità col frontend attuale. Il nuovo frontend legge anche cartelle UUID in vista di una futura migrazione. Nessun file viene spostato.
- I PDF sono inviati a Gemini per l'analisi. Per Plus vengono anche archiviati nel bucket privato; un errore di archiviazione è segnalato separatamente. I report sono memorizzati nello storico personale; l'interfaccia mostra gli ultimi 20.
- Il report può essere stampato o salvato in PDF usando la funzione di stampa del browser.

## Limiti ancora da validare prima della vendita

Dopo ogni rilascio verificare il percorso completo con un PDF sintetico e due account di prova, inclusi storico e archivio. Serve una valutazione dei risultati su documenti di prova controllati da un professionista. Pagamenti, recupero password, gestione della conservazione/cancellazione dei report e notifiche di scadenza non sono inclusi in questa modifica. Le date nel report sono evidenze del PDF, non scadenze normative dedotte automaticamente.

Riferimenti implementativi: https://supabase.com/docs/guides/storage/security/access-control e https://ai.google.dev/api/generate-content
