# Spell Game Engine — MVP v0.1

Motore comune per i business game Spell. Prima implementazione: la fase
"Conoscere" di Less is More (classificazione di 6 collaboratori), su
un'architettura pensata per accogliere in seguito altri giochi (prossimo
target: **Il mistero della città**) senza riscrivere login, sessioni,
tavoli o dashboard.

**Il progetto "Less is More" esistente non è stato toccato.** Questo è
un motore nuovo e separato: la versione attuale di Less is More resta
in produzione così com'è finché non si decide, con calma, se e come
portarla su questo core.

## Cosa c'è

- `packages/shared-types` — tipi condivisi, contratto dei moduli di gioco.
- `packages/game-core` — motore: ciclo di vita sessione, registro moduli,
  pipeline submission → regole → effetti. Non conosce nessun gioco specifico.
- `packages/game-core/src/modules/classification.ts` — il primo modulo
  di attività (classificazione con categorie).
- `apps/server` — API REST (regia + tavolo), persistenza, autenticazione.
- `apps/web/public` — interfacce minime regia/tavolo (HTML+JS, polling,
  niente framework: coerente con "semplicità intenzionale").
- `game-definitions/less-is-more.v0.1.json` — definizione di gioco di
  riferimento usata per validare il core (contenuto fittizio).
- `tests/integration` — test automatici (idempotenza, autorizzazione,
  ripresa) + `simulate.ts` (simulazione con 20 tavoli virtuali).

## Nota sulla persistenza: node:sqlite invece di Prisma

La spec originale indicava Prisma + SQLite per il prototipo. In fase di
sviluppo, l'ambiente sandbox usato per costruire questo MVP blocca il
download del binario dell'engine Prisma (rete non raggiungibile verso
`binaries.prisma.sh`). Per non bloccare lo sviluppo, la persistenza usa
il driver **`node:sqlite`** nativo di Node 22+ (`apps/server/src/lib/db.ts`
+ `repo.ts`, query dirette, nessun ORM) — zero dipendenze esterne da
scaricare, stesso schema logico.

`docs/reference/schema.prisma` resta come riferimento: descrive lo stesso
modello dati e può essere usato per un deploy reale su Postgres,
sostituendo `repo.ts` con query Prisma equivalenti (l'interfaccia
esportata da `repo.ts` è pensata apposta per essere sostituibile 1:1).
Dalla v5.1 il pacchetto `prisma` e gli script `prisma:generate`/
`prisma:push` sono stati rimossi dal progetto: non essendo usati dal
runtime, tenerli tra le dipendenze era solo peso morto.

**Se lavori da una cartella sincronizzata (es. iCloud/Dropbox) o un mount
di rete**, SQLite può dare `disk I/O error` per via del locking dei file.
In quel caso punta `DATABASE_URL` fuori dalla cartella sincronizzata,
es. `DATABASE_URL="file:/tmp/spell-dev.db"`.

## Deploy su Railway: serve un Volume

Il filesystem di un servizio Railway è **effimero**: ad ogni nuovo deploy
riparte da zero, e sia il file SQLite (`DATABASE_URL`, tutte le sessioni,
i giochi pubblicati, le bozze dell'editor) sia le foto caricate
(`UPLOADS_DIR`) vivono per default su disco locale dentro quel
filesystem — **senza un Volume persistente, ogni deploy cancella tutto**
(bozze, giochi pubblicati, foto delle squadre), non solo i dati del
deploy precedente ma anche quelli creati nel frattempo dalla regia.

Setup (una tantum, dashboard Railway del servizio):

1. **Settings → Volumes → New Volume**, mount path a piacere (es. `/data`).
2. **Settings → Variables**, aggiungi:
   - `DATABASE_URL=file:/data/dev.db`
   - `UPLOADS_DIR=/data/uploads`

Entrambe le variabili sono già lette dal codice (`apps/server/src/lib/db.ts`,
`apps/server/src/lib/uploads.ts`) — nessuna modifica al codice necessaria,
solo la configurazione su Railway. Dopo aver impostato le variabili,
riavvia il deploy: da quel momento i dati sopravvivono ai deploy
successivi, finché il Volume non viene esplicitamente eliminato.

## Avvio rapido

```bash
./start.sh
```

Fa tutto in un colpo solo: `npm install` se manca `node_modules`, crea
`.env` da `.env.example` se non esiste, build, `npm run seed`, poi
`npm run dev` (riavvio automatico, strumenti DEV attivi — vedi sotto).
Ctrl+C per fermare.

Passo per passo, se preferisci controllarli singolarmente:

```bash
npm install
cp .env.example .env
npm run build
npm run seed        # carica game-definitions/*.json nel DB
npm run dev          # sviluppo: riavvia da solo ad ogni modifica, su :3000
# oppure, dopo npm run build:
npm start            # produzione: esegue il build compilato in dist/
```

Apri `http://localhost:3000` — scegli "Tavolo" o "Regia".
Il token regia di default è `nick` (vedi `.env`).

## Test

```bash
npm test             # unit/integration: idempotenza, autorizzazione, ripresa
npm run simulate      # 20 tavoli virtuali end-to-end via HTTP reale
```

## Flusso MVP (spec §6)

1. Regia: `POST /api/control/sessions` (gameSlug: `less-is-more`)
2. Regia: `POST /api/control/sessions/:id/teams` (count: 2–20)
3. Regia: stato `DRAFT → LOBBY → RUNNING`
4. Regia: apre la fase `conoscere`
5. Tavolo: `POST /api/team/login` con l'`accessCode`, poi `GET /api/team/state`
6. Tavolo: `POST /api/team/submissions` con gli assignments
7. Regia: `GET /api/control/sessions/:id/dashboard` per lo stato aggregato

## Criteri di accettazione verificati (spec §16)

- ✅ Sessione creata senza toccare DB manualmente
- ✅ 20 tavoli generati e collegabili (vedi `simulate.ts`)
- ✅ Un codice tavolo non dà accesso alla regia (test `auth.test.ts`)
- ✅ Un dispositivo per tavolo: nuovo login revoca il token precedente
- ✅ Fase chiusa non accetta submission
- ✅ Submission duplicata (stessa idempotencyKey) non produce due effetti
- ✅ Submission incompleta: errore leggibile, stato non modificato
- ✅ Pausa/riavvio/ripresa: dati persistiti su file, nessuna perdita
- ✅ Riapertura di un singolo tavolo senza toccare gli altri
- ✅ Punteggio spiegabile via `score_event`
- ✅ Gioco descritto da `game_version` (JSON), non da if hardcoded in UI
- ✅ Modulo `classification` sostituibile/affiancabile senza toccare auth/sessioni

## Correzioni rilevanti dopo la prima consegna

- **Riapertura tavolo non accumula più il punteggio.** `team_state` viene
  ricostruito dalle sole submission ancora `accepted` (spec §5, "i totali
  possono essere ricostruiti"); la differenza di punteggio viene registrata
  come `score_event` compensativo, cosi' il log resta la fonte di verità
  anche per un totale calcolato esternamente.
- **Idempotenza verifica anche il payload.** La stessa `idempotencyKey` con
  un payload diverso non è più trattata come replay: viene rifiutata con
  conflitto esplicito.
- **Le game_version pubblicate sono immutabili.** Ripubblicare la stessa
  versione con contenuto identico è un no-op; con contenuto diverso viene
  rifiutato — bisogna incrementare la versione.
- **Validazione Zod della game definition** (struttura, `teamsMin/teamsMax`,
  fasi e attività senza id duplicati) al seed e, in difesa, alla creazione
  sessione.
- **`teamsMax`/`teamsMin` della game definition sono rispettati davvero**
  nella generazione tavoli e nella transizione verso LOBBY/RUNNING (prima
  il limite era un `50` fisso lato server, indipendente dal gioco).

`npm test` (27 test) e `npm run simulate` coprono questi casi.

## Consolidamento v5.1

Revisione mirata a chiudere punti deboli specifici, senza allargare lo
scope (nessuna nuova fase/gioco, nessun Postgres, nessun rewrite del
frontend). Ogni voce è coperta da almeno un test dedicato.

1. **Idempotenza: corretto anche il ramo "collisione" (race).** Il path
   che gestiva l'errore di UNIQUE constraint sulla `idempotencyKey`
   faceva un replay "alla cieca" senza riverificare che team/attività/
   payload corrispondessero a quelli originali. Ora entrambi i punti
   (controllo iniziale e ramo di recupero dopo la collisione) passano
   dalla stessa funzione `resolveIdempotentReplay`. Test:
   `idempotencyRace.test.ts` (submission concorrenti via
   `Promise.allSettled`, stessa key/payload diverso → 1 successo + 1
   conflitto 409; stessa key/stesso payload → entrambe ok, stesso id).
2. **Riutilizzo di una idempotencyKey legata a una submission riaperta
   viene rifiutato esplicitamente** (409 `submission_reopened`), invece
   di essere trattato come replay valido. Test: stesso file, caso
   "reopen poi riuso della vecchia key".
3. **Ricostruzione dello stato tavolo parte da uno stato base, non da
   `{}`.** Nuova colonna `team_state.base_state_json` (migrazione
   automatica su DB esistenti) e funzione `repo.setBaseState`, pensata
   per dati di setup che non devono sparire quando lo stato viene
   ricalcolato dagli effetti. Test: `pipeline.test.ts`, blocco "stato
   base del tavolo".
4. **Coerenza del locking ottimistico durante la riapertura.** La
   scrittura di `team_state` dopo un `reopen` passa dalla stessa
   funzione con controllo di versione (`WHERE version = ?`) usata
   ovunque altrove; codice errore rinominato in `state_version_conflict`
   per essere esplicito. Test: `optimisticLocking.test.ts`.
5. **Validazione semantica della game definition**, sopra la struttura
   già validata da Zod: modulo registrato, `validateConfig` del modulo,
   riferimenti `itemsSource`/`content` esistenti, controlli specifici di
   classification (categorie duplicate, `expectedCategory` valida, id
   articolo duplicati), nomi regola in `rules` noti. Girata solo al
   publish/seed, non nell'hot path delle submission. Test:
   `gameDefinition.test.ts`, blocco "validazione semantica".
6. **Prisma rimosso da dipendenze e script.** `prisma/schema.prisma`
   spostato in `docs/reference/schema.prisma` come sola documentazione
   del modello dati; `package.json` non lo cita più.
7. **Debito tecnico documentato, non risolto.** classification.ts
   continua a mischiare raccolta risposte e scoring: non è stato
   separato in questa consolidazione. Aggiunta solo un'interfaccia
   `RuleStrategy` (`packages/game-core/src/ruleStrategy.ts`), non ancora
   collegata al motore, più un commento che spiega il debito e dove
   intervenire in futuro.
8. **Preparazione minima frontend, non generalizzazione.** `team.html`
   ora sceglie il renderer dell'attività tramite un piccolo registro
   (`activityRenderers`) invece di un `if` fisso sul tipo
   `"classification"`; `control.html` non ha più l'id di fase
   `"conoscere"` scritto a mano — i pulsanti fase sono generati dalla
   lista `phases` che la dashboard ora restituisce. Il comportamento
   visibile non cambia.

**Non fatto in questa consolidazione** (volutamente, per non allargare lo
scope): seconda fase di Less is More, allocazione ore, scenari di crisi,
nuovi moduli, migrazione Il mistero della città/Franchise, Postgres,
autenticazione enterprise, editor visuale, i18n, reportistica, websocket,
refactor completo del frontend.

**Limite dichiarato sul test di race dell'idempotenza:** l'architettura è
Node/Express a singolo processo e sincrona sui punti critici; non è
possibile forzare una vera interfoliazione delle due richieste dentro il
ramo di gestione della collisione. Il test in `idempotencyRace.test.ts`
verifica quindi la garanzia osservabile (una sola submission accettata,
l'altra rifiutata con conflitto coerente) invocando le due richieste in
concorrenza reale via HTTP e `Promise.allSettled`, non l'esecuzione
letterale del ramo interno — è la stessa cosa dichiarata nel commento nel
codice, per onestà verso chi legge il test.

`npm test` ora copre 40 test (27 precedenti + 13 nuovi per i punti sopra),
tutti verdi; `npm run build` pulito; `npm run simulate` verde. Verificato
anche da zero: `rm -rf node_modules && npm ci && npm run build && npm
test && npm run simulate` (Node v22.22.3, npm 10.9.8).

## Strumenti DEV (dashboard regia)

Strumenti pensati solo per iterare rapidamente durante lo sviluppo/demo:
NON fanno parte del game engine (non toccano submission pipeline, event
sourcing o lifecycle ufficiale — `packages/game-core/src/lifecycle.ts`),
si limitano a creare/eliminare dati (`apps/server/src/lib/repo.ts`,
sezione "strumenti DEV").

**Attivazione**: il router `/api/dev/*` (`apps/server/src/routes/dev.ts`)
viene montato in `app.ts` solo se `NODE_ENV` non è `"production"` (vedi
`apps/server/src/lib/devMode.ts` — se `NODE_ENV` non è impostato affatto,
conta come sviluppo, il caso più comune in locale). In produzione
(`NODE_ENV=production`) quelle route non esistono: una richiesta a
`/api/dev/*` finisce nel 404 generico, non in un 401/403 che rivelerebbe
che la funzionalità esiste ma è bloccata. Coperto da
`tests/integration/devToolsProdGating.test.ts`.

**Token regia di sviluppo**: se `CONTROL_TOKEN` non è impostato in `.env`,
il default è ora `"nick"` (prima `"regia-dev-token"`) — solo comodità
locale, in produzione va sempre impostato esplicitamente.

**Dashboard regia** (`apps/web/public/control.html`): un banner
"⚠ Development Mode" e i pulsanti dev compaiono/spariscono in base a una
probe reale su `/api/dev/sessions` (200/401 = dev, 404 = produzione), non
un flag scritto a mano — coerente col fatto che in produzione la UI non ha
nulla da nascondere perché il backend non risponde proprio.

Cosa c'è, tutto testato in `tests/integration/devTools.test.ts`:

- **🔄 Reset Sessione** (`POST /api/dev/sessions/:id/reset`) — elimina
  submission, score_event, effect_event, audit_event della sessione;
  ripristina `team_state` al `base_state` di ciascun tavolo (non a `{}`);
  riporta la sessione a `DRAFT`. Non tocca `game`, `game_version`, `team`:
  è un reset della partita, non del progetto — stessi tavoli, stessi
  codici di accesso.
- **Sessioni** (`GET /api/dev/sessions`) — elenco di tutte le sessioni con
  gioco, stato, data, numero tavoli; azioni Apri / Duplica / Archivia /
  Riapri (solo da `COMPLETED`) / Elimina (solo DEV).
- **Duplica sessione** (`POST /api/dev/sessions/:id/duplicate`) — nuova
  sessione `DRAFT` sulla stessa `game_version`, stessi tavoli (nomi
  uguali, nuovi id e nuovi codici di accesso — devono essere univoci) e
  stessa configurazione (`base_state_json` copiato), senza submission,
  punteggi o audit.
- **Elimina sessione — solo DEV** (`DELETE /api/dev/sessions/:id`) —
  cancellazione completa e irreversibile: sessione, tavoli, token
  (`device_session`), tutti gli eventi collegati.
- **Riapri sessione** (`POST /api/dev/sessions/:id/reopen`) — solo da
  `COMPLETED` a `DRAFT`. Bypassa deliberatamente il lifecycle ufficiale
  (che non consente questa transizione — vedi `lifecycle.ts`): è
  volutamente uno strumento dev, non una regola di gioco.
- **Archivia** — non è un endpoint dev a sé: riusa la transizione
  `COMPLETED → ARCHIVED` già prevista dal lifecycle del motore, tramite
  l'endpoint standard `/api/control/sessions/:id/status`. Per questo
  funziona solo da `COMPLETED`, in dev come in produzione.
- **🎮 Nuova partita** — solo lato dashboard: duplica la sessione aperta e
  ci si sposta subito sulla copia (già `DRAFT` per costruzione). Nessun
  endpoint dedicato: riusa `duplicate`.

## Il mistero della città (caccia al tesoro, percorso per squadra)

Secondo gioco reale sul motore, migrato dall'originale Google Apps
Script (foglio Google + `doGet/doPost`) mantenendo lo stesso event
sourcing, la stessa idempotenza e lo stesso optimistic locking di Less is
More — non un motore a parte, la stessa piattaforma con un modo di gioco
in più.

### Il concetto nuovo: fasi "itinerary"

Less is More ha un'unica attività sincronizzata per fase (la regia apre,
tutti i tavoli inviano, la regia chiude). Il mistero della città è
strutturalmente diverso: ogni squadra percorre da sola una **propria
sequenza di tappe** (un percorso), a proprio ritmo, senza attendere le
altre. Per questo il motore ha una nuova `mode: "itinerary"` di fase
(accanto a `single_submission`), con la propria orchestrazione
(`apps/server/src/lib/itineraryPipeline.ts`) parallela a
`submissionPipeline.ts` — non lo sostituisce, non lo modifica.

Ogni tappa (`content.tappe[]` nella game definition) è una mini-"activity"
gestita da un modulo registrato come tutti gli altri (stesso contratto
`GameModule`):

- **`start`** — avanza da sola, nessun input dal tavolo.
- **`textMatch`** — risposta testuale libera; `config.kind` distingue
  `"testo"` (risposta scritta), `"guida"` (risposta raccolta da una guida
  in loco) e `"qr"` (token da QR code) solo per etichettare la UI: il
  confronto è lo stesso per tutti, normalizzato (minuscolo, accenti
  rimossi). Un tentativo sbagliato NON è un errore di validazione: resta
  registrato come submission ma non fa avanzare né assegna punti — il
  tavolo può riprovare subito, senza intervento della regia.
- **`photoApproval`** — upload di una foto; l'esito (punteggio +
  avanzamento) è deferito alla decisione di un operatore (regia o
  facilitatore), non immediato come per `textMatch`. Limite tentativi
  configurabile (`itinerary.maxPhotoAttempts`).
- **`voucher`** — avanza da sola e genera un token premio idempotente per
  (sessione, squadra, tappa) — se richiesto due volte restituisce lo
  stesso token, non ne crea un secondo.
- **`finale`** — non avanza (non c'è una tappa dopo): segna l'itinerario
  completato.

Lo **stato per squadra**: il percorso generato (`route`, sequenza di
`number` di tappa) vive in `team_state.base_state_json` — sopravvive al
🔄 Reset Sessione (è dato di configurazione, non stato di gioco). La
posizione corrente (`position`) e il punteggio vivono nello stato
mutabile, avanzato per effect_event esattamente come Less is More: lo
stesso `applyEffectToState`, la stessa ricostruzione dagli eventi.

### Generazione dei percorsi

`POST /api/control/sessions/:id/itinerary/generate-routes` (richiede
`phaseId`, va chiamato prima di aprire la fase) genera e assegna il
percorso di ogni squadra, portando fedelmente l'algoritmo originale
(`packages/game-core/src/itineraryRouting.ts`, testato in
`tests/integration/itineraryRouting.test.ts` e con i 35 dati reali di
Bologna in `tests/integration/misteroDellaCitta.test.ts`):

- le tappe con `block` uguale ruotano **a coppie di squadre** (coppia 0
  vede i blocchi nell'ordine B0,B1,B2…; coppia 1 li vede sfalsati); dentro
  ogni blocco l'ordine ruota per singola squadra;
- le tappe senza blocco ruotano individualmente;
- la tappa `voucher` cade a metà percorso circa;
- due vincoli sulle tappe `config.kind === "guida"` (irrilevanti per lo
  scheduling delle altre): non nelle prime/ultime 2 posizioni del tratto
  centrale, e mai a meno di `itinerary.routing.minGuideDistance`
  posizioni l'una dall'altra — corretti durante questa migrazione due bug
  reali (non presenti nei test sintetici precedenti, emersi solo con le 4
  guide vere su un pool di 22-24 tappe): uno scambio pensato per un
  vincolo poteva violare l'altro, e un candidato di scambio poteva essere
  "abbastanza lontano dalla tappa che si stava spostando" ma comunque
  troppo vicino a una TERZA guida già piazzata. Ora `vincolaGuide` e
  `spaziGuide` si alternano fino a un punto fisso e ogni candidato di
  scambio è verificato contro TUTTE le guide correnti, non solo la coppia
  che si sta sistemando.
- **`groups`** (tappa riservata a un sottoinsieme di squadre) fa
  riferimento al **numero ordinale della squadra nella sessione**
  (1-based, cioè l'ordine di creazione dei tavoli), non all'id interno
  del motore: nel foglio originale l'id squadra era già un piccolo intero
  1..N, mentre qui `team.id` è una stringa generata a ogni sessione — una
  game definition statica non può contenerla in anticipo.

### Facilitatori

Ruolo di primo livello del motore (non solo il token regia riusato):
tabella `facilitator` (id, sessione, nome, token, `team_ids_json`),
middleware dedicato (`apps/server/src/middleware/facilitatorAuth.ts`) che
scopa l'accesso alle sole squadre assegnate — un elenco vuoto significa
"tutte le squadre della sessione" (come i facilitatori generici
Lorenza/Cesare nei dati reali, senza squadre proprie).

Creazione da parte della regia:
`POST /api/control/sessions/:id/facilitators` con `{name, teamIds}`
(anche dal pannello "Facilitatori" di `control.html`). Nei dati reali del
17/06/2026 i token facilitatore erano semplicemente il nome
(`Mauro`/`Elena`/`Gabriele`/`Lorenza`/`Cesare`) — il motore non impone un
formato, la regia può assegnare il token che preferisce al momento della
creazione... con una differenza: qui il token è generato automaticamente
(`FAC-XXXXXXXXXX`) per evitare collisioni accidentali; se serve
riprodurre esattamente token "a nome", va creata una via per impostarlo
esplicitamente (non presente in questo MVP, wave 2).

Endpoint del facilitatore (`apps/server/src/routes/facilitator.ts`, token
proprio nell'header, mai il token regia):

- `GET /api/facilitator/photos/pending` — foto in attesa, filtrate sulle
  proprie squadre.
- `GET /api/facilitator/photos/:id/image` — file della foto.
- `POST /api/facilitator/photos/:id/decide` — approva/rigetta; solo se
  ancora `pending` (una foto non può essere decisa due volte); rigetto
  non applica nulla (il tavolo può ritentare, entro il limite tentativi);
  approvazione applica punteggio + avanzamento in quel momento (non al
  momento dell'upload), come submission "figlia" collegata a quella
  originale.

La regia ha lo stesso potere (senza bisogno di un token facilitatore) via
`/api/control/sessions/:id/itinerary/photos/pending` e
`.../photos/:photoId/decide` — comodo per sessioni di test o quando non
sono stati creati facilitatori dedicati; nel pannello "Foto in attesa" di
`control.html`.

### Suggerimenti

`POST /api/team/itinerary/hint` restituisce il testo di aiuto della tappa
corrente (`content.tappe[].hint`) e applica una penalità
(`itinerary.hintPenalty`, punti mai negativi) **solo la prima volta** per
quella tappa — richieste successive restituiscono lo stesso testo senza
penalizzare di nuovo.

### File

- `game-definitions/il-mistero-della-citta.v0.1.json` — le 35 tappe reali
  di Bologna (contenuti, risposte, indizi, blocchi, gruppi, punti),
  costruito dallo spreadsheet caricato dall'utente (sessione del
  17/06/2026, 8 squadre reali). `npm run seed` lo pubblica insieme a
  Less is More.
- `packages/game-core/src/itineraryRouting.ts` — algoritmo di
  generazione percorsi (puro, testabile senza DB).
- `packages/game-core/src/modules/{textMatch,photoApproval,itineraryBasics}.ts`
  — i moduli delle tappe.
- `apps/server/src/lib/itineraryPipeline.ts` — orchestrazione (stato,
  submission, hint, decisione foto), parallela a `submissionPipeline.ts`.
- `apps/server/src/middleware/facilitatorAuth.ts` — auth facilitatore.
- `apps/server/src/routes/{team,control,facilitator}.ts` — rotte REST
  (estese le prime due, nuova la terza).
- `apps/web/public/{team,control}.html` — UI minima: il tavolo vede la
  tappa corrente e invia risposte/foto/hint; la regia genera i percorsi,
  crea facilitatori e modera le foto.
- `tests/integration/itineraryRouting.test.ts`,
  `tests/integration/itineraryFlow.test.ts` (fixture sintetico, intero
  flusso REST),
  `tests/integration/misteroDellaCitta.test.ts` (dati reali: validazione
  game definition, routing con le 8 squadre vere, una squadra che gioca
  con contenuti e risposte reali) — 22 test dedicati, tutti verdi.

### Wave 2 (deliberatamente fuori da questo MVP)

Presenti nell'originale, non ancora migrate — l'MVP copre l'essenziale
per giocare (tappe, punteggio, foto, hint, facilitatori); questi sono
arricchimenti:

- **Chat squadra ↔ facilitatore** e **bacheca** (messaggi pubblici tra
  squadre) — nell'originale `getMessaggiTappa`/`postMessaggioGruppo`/
  `inviaMessaggio`; nel motore l'effetto `message.emit` esiste già (i
  moduli lo emettono per i propri messaggi automatici) ma non c'è ancora
  una vera messaggistica bidirezionale libera.
- **Bar/buoni**: assegnazione automatica del bar per squadra
  (round-robin bilanciato, shuffle) e validazione del voucher al bar
  (`validateVoucher` nell'originale) — oggi il voucher viene generato ma
  non "consumato" da un flusso barista dedicato.
- **Storage foto su Google Drive** — oggi `LocalDiskPhotoStorage`
  (`apps/server/src/lib/photoStorage.ts`) scrive su disco locale, dietro
  un'interfaccia (`PhotoStorage`) pensata apposta perché passare a Drive
  sia un nuovo modulo che la implementa, non una riscrittura di chi la
  chiama — coerente con la preferenza storica dell'utente per Drive.
- **UI più curata**: mappa e galleria foto sono state costruite (vedi
  sezione sotto); restano niente chat/bacheca, niente flusso barista per i
  voucher, niente storage foto su Drive (elenco invariato per queste tre).

## Editor caccia, georeferenziazione, percorsi e mappe

Sei aggiunte al motore itinerary, pensate per rendere "Il mistero della
città" — e qualunque nuova caccia dello stesso tipo — costruibile e
osservabile dalla regia senza toccare file JSON a mano né il codice.

1. **Modulo tappa `geoAnswer`** (`packages/game-core/src/modules/geoAnswer.ts`):
   risposta verificata via posizione geografica invece che testo — la
   squadra invia le coordinate rilevate dal GPS del telefono
   (`navigator.geolocation`, `team.html`) o inserite a mano se il permesso
   è negato, corretta entro `config.toleranceMeters` (default 40m) dal
   punto atteso. Stessa logica di tentativo/riprova di `textMatch`.
2. **Distanza prevista di un percorso**: `haversineMeters` e
   `computeRouteDistanceMeters` (`packages/game-core/src/itineraryRouting.ts`,
   pure, testate) sommano le distanze tra tappe consecutive; una tappa
   senza `lat`/`lng` in `config` interrompe la catena in quel punto invece
   di far fallire il calcolo.
3. **Percorsi squadra dalla regia** (`GET`/`PUT
   /api/control/sessions/:id/itinerary/teams/:teamId/route`,
   `itineraryPipeline.ts`): la regia vede la distanza prevista di ogni
   squadra e può riordinare a mano le tappe **non ancora raggiunte** —
   riscrivere l'ordine di quelle già completate è rifiutato
   esplicitamente (409 `route_prefix_mismatch`), con lo stesso optimistic
   locking (`repo.setTeamRouteWithVersionCheck`) usato per le submission,
   sulla stessa colonna `version`. UI in `control.html`, sezione "Percorsi
   squadra" del pannello itinerario.
4. **Editor "città/tappe"** (`apps/server/src/routes/authoring.ts`,
   `apps/web/public/editor.html`): prima serviva modificare a mano un file
   in `game-definitions/` e rilanciare `npm run seed` per pubblicare un
   gioco. Ora la regia può creare una **bozza** (`game_draft`, tabella
   dedicata — modificabile liberamente, validata solo strutturalmente ad
   ogni salvataggio), popolarla con un form (tappe, tipo, punti, indizio,
   blocco/gruppi, coordinate impostabili anche cliccando su una mini-mappa
   Leaflet) e **pubblicarla** (`POST .../game-drafts/:id/publish`) — a
   quel punto passa dalla stessa validazione semantica e dalle stesse
   `upsertGame`/`upsertGameVersion` di `seed.ts`, diventa una
   `game_version` immutabile come le altre. `basedOn` clona un gioco già
   pubblicato come punto di partenza (es. una nuova città sullo scheletro
   de "Il mistero della città").
5. **Mappa del tavolo** (`team.html`, dentro `renderItinerary`): percorso
   proprio della squadra — tappe fatte in verde, corrente evidenziata,
   tappe **future assenti dalla mappa per default**
   (`itinerary.showUpcomingStops` nella game definition, default `false`):
   per molte tappe individuare il luogo fa parte dell'indizio, mostrarlo
   in anticipo lo banalizzerebbe. La distinzione vive lato server
   (`getItineraryStatus` → nuovo campo `route`, funzione
   `resolveRouteView` in `itineraryPipeline.ts`), il client disegna solo
   quello che riceve.
6. **Mappa overview + galleria foto in regia** (`control.html`): un
   marker per squadra con la sola tappa corrente
   (`GET .../itinerary/overview`, `getItineraryOverview` —
   non l'intero percorso, non deve spoilerare le squadre le une con le
   altre), e una galleria di sola lettura con **tutte** le foto della
   sessione filtrabili per stato (`GET .../itinerary/photos?status=`,
   `repo.listPhotosForSession`) — il pannello "Foto in attesa" esistente
   resta invariato, operativo per approvare/rigettare.

Mappa in entrambe le UI: **Leaflet + OpenStreetMap** via CDN, nessuna API
key, coerente con la filosofia "zero dipendenze esterne da scaricare" già
seguita nel progetto (vedi nota su Prisma/`node:sqlite` più sopra).

`npm test` copre tutto questo con test end-to-end dedicati
(`geoAnswer` dentro/fuori tolleranza, calcolo distanza con coordinate
mancanti, override percorso con vincolo sul prefisso già completato,
bozza→pubblicazione con validazione strutturale/semantica e clonazione
`basedOn`, anti-spoiler della mappa con e senza `showUpcomingStops`,
overview e galleria).

## Prossimo passo

Con due giochi reali sul motore (Less is More: fasi sincronizzate;
Il mistero della città: percorso per squadra, ora anche autorabile dalla
regia) e le sei aggiunte sopra, il core ha dimostrato di generalizzare
oltre il primo MVP e di reggere una vera capacità di authoring, non solo
di runtime. Restano esplicitamente fuori scope: chat/bacheca, flusso
barista per i voucher, storage foto su Drive, editor per i facilitatori
(non hanno ancora una UI dedicata), un terzo `mode` di fase.
