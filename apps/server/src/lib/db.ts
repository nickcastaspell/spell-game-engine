import path from "node:path";
import fs from "node:fs";
import { nanoid } from "nanoid";

// Radice del repo, calcolata dalla posizione di QUESTO file (non da
// process.cwd()): "npm run seed" gira dalla root, "npm start"/"npm run dev"
// girano dentro apps/server (comportamento normale degli npm workspace).
// Un default relativo tipo "./dev.db" finiva quindi in due file diversi
// a seconda di come veniva lanciato — bug reale, corretto ancorando il
// default alla root indipendentemente dalla cwd del processo.
// apps/server/src/lib -> root: 4 livelli. apps/server/dist/lib -> root:
// altrettanti 4 livelli (stessa profondità), quindi funziona identico
// sia in sviluppo (tsx su src/) sia dopo il build (node su dist/).
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");

// Carica .env dalla root del repo, se presente (Node 20.6+; non richiede
// dipendenze). Le variabili già impostate nell'ambiente restano prioritarie.
try {
  process.loadEnvFile(path.join(REPO_ROOT, ".env"));
} catch {
  // nessun .env: si procede con i default hardcoded.
}

// require() invece di `import ... from "node:sqlite"`: il modulo è ancora
// sperimentale e assente da node:module#builtinModules, quindi alcuni
// bundler (incluso Vite/Vitest usato dai test) non lo riconoscono come
// built-in e provano a risolverlo come pacchetto npm, fallendo. Con
// require() passa direttamente al resolver nativo di Node.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");

// Implementazione runtime su node:sqlite (nativo in Node 22, nessun
// binario esterno da scaricare). Lo schema logico è lo stesso descritto
// in docs/reference/schema.prisma (spec §7, non usato dal runtime): questo file ne è l'implementazione
// eseguibile per il prototipo. Passare a Postgres in produzione significa
// sostituire questo modulo mantenendo le stesse funzioni esportate.

const rawUrl = process.env.DATABASE_URL ?? "file:./dev.db";
const dbFile = rawUrl.replace(/^file:/, "");
const resolved = path.isAbsolute(dbFile) ? dbFile : path.resolve(REPO_ROOT, dbFile);
fs.mkdirSync(path.dirname(resolved), { recursive: true });

export const db = new DatabaseSync(resolved);
// journal_mode DELETE invece di WAL: WAL richiede mmap/shared-memory che
// alcuni filesystem montati (es. cartelle sincronizzate) non supportano.
db.exec("PRAGMA journal_mode = DELETE;");
db.exec("PRAGMA foreign_keys = ON;");

try {
  db.exec("ALTER TABLE team_state ADD COLUMN base_state_json TEXT NOT NULL DEFAULT '{}'");
} catch {
  // colonna già presente (DB creato dopo l'introduzione dello schema sopra).
}

db.exec(`
CREATE TABLE IF NOT EXISTS game (
  id TEXT PRIMARY KEY,
  slug TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS game_version (
  id TEXT PRIMARY KEY,
  game_id TEXT NOT NULL REFERENCES game(id),
  version TEXT NOT NULL,
  definition_json TEXT NOT NULL,
  published_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(game_id, version)
);

CREATE TABLE IF NOT EXISTS session (
  id TEXT PRIMARY KEY,
  game_version_id TEXT NOT NULL REFERENCES game_version(id),
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'DRAFT',
  current_phase_id TEXT,
  current_round INTEGER NOT NULL DEFAULT 1,
  phase_status TEXT NOT NULL DEFAULT 'CLOSED',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS team (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES session(id),
  name TEXT NOT NULL,
  access_code TEXT UNIQUE NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS device_session (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL REFERENCES team(id),
  token_hash TEXT UNIQUE NOT NULL,
  last_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
  revoked_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS team_state (
  team_id TEXT PRIMARY KEY REFERENCES team(id),
  state_json TEXT NOT NULL,
  base_state_json TEXT NOT NULL DEFAULT '{}',
  version INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS submission (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES session(id),
  team_id TEXT NOT NULL REFERENCES team(id),
  activity_id TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  idempotency_key TEXT UNIQUE NOT NULL,
  submitted_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS effect_event (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES session(id),
  team_id TEXT NOT NULL REFERENCES team(id),
  type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  source_submission_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS score_event (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES session(id),
  team_id TEXT NOT NULL REFERENCES team(id),
  amount INTEGER NOT NULL,
  reason TEXT NOT NULL,
  source_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS audit_event (
  id TEXT PRIMARY KEY,
  actor_type TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  session_id TEXT,
  action TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Tabelle specifiche di "Il mistero della città" (fasi itinerary): non
-- toccano lo schema di Less is More sopra, sono additive.

-- Operatore scoped su un sottoinsieme di squadre (spec: Facilitatori del
-- foglio originale). Token confrontato direttamente, come CONTROL_TOKEN
-- (stesso "livello di fiducia": credenziale da distribuire allo staff,
-- non un device token da revocare a ogni login come team.access_code).
CREATE TABLE IF NOT EXISTS facilitator (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES session(id),
  name TEXT NOT NULL,
  token TEXT NOT NULL,
  team_ids_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(session_id, token)
);

-- Foto in attesa/approvate/rigettate per una tappa "photoApproval". Tabella
-- dedicata invece di colonne extra su "submission": tiene lo schema
-- generico di submission/effect_event/score_event pulito e riusabile da
-- qualunque gioco, mentre i dettagli specifici della moderazione foto
-- (percorso file, tentativo, nota) restano qui.
CREATE TABLE IF NOT EXISTS itinerary_photo (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES session(id),
  team_id TEXT NOT NULL REFERENCES team(id),
  step_id TEXT NOT NULL,
  submission_id TEXT NOT NULL REFERENCES submission(id),
  file_path TEXT NOT NULL,
  attempt INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  decided_at TEXT
);

-- Buono generato al passaggio da una tappa "voucher" (spec: foglio Buoni
-- originale). La riscossione al bar da parte di un ruolo "barista" è
-- rimandata a un secondo giro (vedi README, sezione "Il mistero della
-- città" — wave 2): questa tabella esiste già ora perché la generazione
-- del voucher fa parte del percorso della squadra (deve avanzare la
-- tappa), la sua validazione no.
CREATE TABLE IF NOT EXISTS voucher (
  token TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES session(id),
  team_id TEXT NOT NULL REFERENCES team(id),
  step_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'nuovo',
  generated_at TEXT NOT NULL DEFAULT (datetime('now')),
  used_at TEXT,
  UNIQUE(session_id, team_id, step_id)
);

-- Bozza di game definition in costruzione (Fase 3 dell'editor "città/
-- tappe"): a differenza di game_version (immutabile una volta pubblicata,
-- vedi repo.ts upsertGameVersion), una riga qui può essere salvata più
-- volte mentre la regia sta ancora componendo la caccia — "publish" la
-- trasforma in una game_version vera tramite le stesse funzioni
-- upsertGame/upsertGameVersion usate da seed.ts, la bozza resta comunque
-- modificabile dopo (per preparare una versione successiva).
CREATE TABLE IF NOT EXISTS game_draft (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL,
  name TEXT NOT NULL,
  definition_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`);

export function newId(prefix: string): string {
  return `${prefix}_${nanoid(12)}`;
}

export function isUniqueConstraintError(e: unknown, column?: string): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  return msg.includes("UNIQUE constraint failed") && (!column || msg.includes(column));
}

/** Transazione semplice: BEGIN IMMEDIATE evita interfogliature scritture concorrenti (spec §13). */
export function transaction<T>(fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}
