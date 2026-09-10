import { db, newId, transaction } from "./db";
import { deepEqualJson } from "./canonical";
import { newAccessCode } from "./tokens";

// Query dirette in SQL, senza ORM. Un solo punto di accesso alle tabelle
// per instradare eventuali cambi futuri (es. porting a Postgres).

export interface GameRow {
  id: string;
  slug: string;
  name: string;
  status: string;
  created_at: string;
}

export interface GameVersionRow {
  id: string;
  game_id: string;
  version: string;
  definition_json: string;
  published_at: string | null;
  created_at: string;
}

export interface SessionRow {
  id: string;
  game_version_id: string;
  name: string;
  status: string;
  current_phase_id: string | null;
  current_round: number;
  phase_status: string;
  created_at: string;
  updated_at: string;
}

export interface SessionWithMetaRow extends SessionRow {
  game_name: string;
  game_slug: string;
  team_count: number;
}

export interface TeamRow {
  id: string;
  session_id: string;
  name: string;
  access_code: string;
  status: string;
  created_at: string;
}

export interface DeviceSessionRow {
  id: string;
  team_id: string;
  token_hash: string;
  last_seen_at: string;
  revoked_at: string | null;
  created_at: string;
}

export interface TeamStateRow {
  team_id: string;
  state_json: string;
  base_state_json: string;
  version: number;
  updated_at: string;
}

export interface SubmissionRow {
  id: string;
  session_id: string;
  team_id: string;
  activity_id: string;
  payload_json: string;
  status: string;
  idempotency_key: string;
  submitted_at: string;
}

export interface EffectEventRow {
  id: string;
  session_id: string;
  team_id: string;
  type: string;
  payload_json: string;
  source_submission_id: string | null;
  created_at: string;
}

// --- game / game_version ---

export function upsertGame(slug: string, name: string): GameRow {
  const existing = db.prepare("SELECT * FROM game WHERE slug = ?").get(slug) as unknown as GameRow;
  if (existing) {
    db.prepare("UPDATE game SET name = ? WHERE id = ?").run(name, existing.id);
    return { ...existing, name };
  }
  const id = newId("game");
  db.prepare("INSERT INTO game (id, slug, name) VALUES (?, ?, ?)").run(id, slug, name);
  return db.prepare("SELECT * FROM game WHERE id = ?").get(id) as unknown as GameRow;
}

export function getGameBySlug(slug: string): GameRow | undefined {
  return db.prepare("SELECT * FROM game WHERE slug = ?").get(slug) as unknown as GameRow;
}

/**
 * Pubblica una game_version. Una versione già pubblicata è immutabile
 * (spec §7, colonna "Nota": "Immutabile dopo la pubblicazione") — una
 * sessione può già essere stata creata puntando a quel JSON esatto, quindi
 * sovrascriverlo silenziosamente ne cambierebbe il significato a
 * posteriori. Ripubblicare la STESSA versione con contenuto identico è
 * un no-op idempotente (utile per rilanciare il seed); con contenuto
 * diverso è un errore esplicito: occorre incrementare la versione.
 */
export function upsertGameVersion(gameId: string, version: string, definitionJson: string): GameVersionRow {
  const existing = db
    .prepare("SELECT * FROM game_version WHERE game_id = ? AND version = ?")
    .get(gameId, version) as unknown as GameVersionRow;
  if (existing) {
    if (deepEqualJson(JSON.parse(existing.definition_json), JSON.parse(definitionJson))) {
      return existing;
    }
    throw new Error(
      `game_version "${version}" è già pubblicata con un contenuto diverso: una versione pubblicata è immutabile. ` +
        `Pubblica una nuova versione (es. incrementa schemaVersion) invece di modificare "${version}".`
    );
  }
  const id = newId("gv");
  db.prepare(
    "INSERT INTO game_version (id, game_id, version, definition_json, published_at) VALUES (?, ?, ?, ?, datetime('now'))"
  ).run(id, gameId, version, definitionJson);
  return db.prepare("SELECT * FROM game_version WHERE id = ?").get(id) as unknown as GameVersionRow;
}

export function getLatestGameVersion(gameId: string): GameVersionRow | undefined {
  return db
    .prepare("SELECT * FROM game_version WHERE game_id = ? ORDER BY created_at DESC LIMIT 1")
    .get(gameId) as unknown as GameVersionRow;
}

export function getGameVersionByVersion(gameId: string, version: string): GameVersionRow | undefined {
  return db
    .prepare("SELECT * FROM game_version WHERE game_id = ? AND version = ?")
    .get(gameId, version) as unknown as GameVersionRow;
}

export function getGameVersionById(id: string): GameVersionRow | undefined {
  return db.prepare("SELECT * FROM game_version WHERE id = ?").get(id) as unknown as GameVersionRow;
}

// --- game_draft (Fase 3: editor "città/tappe" dalla regia) ---

export interface GameDraftRow {
  id: string;
  slug: string;
  name: string;
  definition_json: string;
  created_at: string;
  updated_at: string;
}

export function createGameDraft(slug: string, name: string, definitionJson: string): GameDraftRow {
  const id = newId("draft");
  db.prepare("INSERT INTO game_draft (id, slug, name, definition_json) VALUES (?, ?, ?, ?)").run(
    id,
    slug,
    name,
    definitionJson
  );
  return getGameDraft(id)!;
}

export function getGameDraft(id: string): GameDraftRow | undefined {
  return db.prepare("SELECT * FROM game_draft WHERE id = ?").get(id) as unknown as GameDraftRow | undefined;
}

export function listGameDrafts(): GameDraftRow[] {
  return db.prepare("SELECT * FROM game_draft ORDER BY updated_at DESC").all() as unknown as GameDraftRow[];
}

export function updateGameDraft(id: string, definitionJson: string, name: string): GameDraftRow | undefined {
  db.prepare("UPDATE game_draft SET definition_json = ?, name = ?, updated_at = datetime('now') WHERE id = ?").run(
    definitionJson,
    name,
    id
  );
  return getGameDraft(id);
}

export function deleteGameDraft(id: string): boolean {
  const result = db.prepare("DELETE FROM game_draft WHERE id = ?").run(id);
  return result.changes === 1;
}

// --- session ---

export function createSession(gameVersionId: string, name: string): SessionRow {
  const id = newId("ses");
  db.prepare("INSERT INTO session (id, game_version_id, name) VALUES (?, ?, ?)").run(id, gameVersionId, name);
  return getSession(id)!;
}

export function getSession(id: string): SessionRow | undefined {
  return db.prepare("SELECT * FROM session WHERE id = ?").get(id) as unknown as SessionRow;
}

export function updateSessionStatus(id: string, status: string): SessionRow {
  db.prepare("UPDATE session SET status = ?, updated_at = datetime('now') WHERE id = ?").run(status, id);
  return getSession(id)!;
}

export function updateSessionPhase(id: string, currentPhaseId: string | null, phaseStatus: string): SessionRow {
  db.prepare(
    "UPDATE session SET current_phase_id = ?, phase_status = ?, updated_at = datetime('now') WHERE id = ?"
  ).run(currentPhaseId, phaseStatus, id);
  return getSession(id)!;
}

// --- team ---

export function createTeam(sessionId: string, name: string, accessCode: string): TeamRow {
  const id = newId("team");
  db.prepare("INSERT INTO team (id, session_id, name, access_code) VALUES (?, ?, ?, ?)").run(
    id,
    sessionId,
    name,
    accessCode
  );
  return getTeam(id)!;
}

export function getTeam(id: string): TeamRow | undefined {
  return db.prepare("SELECT * FROM team WHERE id = ?").get(id) as unknown as TeamRow;
}

export function getTeamByAccessCode(code: string): TeamRow | undefined {
  return db.prepare("SELECT * FROM team WHERE access_code = ?").get(code) as unknown as TeamRow;
}

export function listTeams(sessionId: string): TeamRow[] {
  return db.prepare("SELECT * FROM team WHERE session_id = ?").all(sessionId) as unknown as TeamRow[];
}

export function countTeams(sessionId: string): number {
  const row = db.prepare("SELECT COUNT(*) as c FROM team WHERE session_id = ?").get(sessionId) as { c: number };
  return row.c;
}

export function updateTeamStatus(id: string, status: string): void {
  db.prepare("UPDATE team SET status = ? WHERE id = ?").run(status, id);
}

// --- device_session ---

export function revokeActiveDeviceSessions(teamId: string): void {
  db.prepare("UPDATE device_session SET revoked_at = datetime('now') WHERE team_id = ? AND revoked_at IS NULL").run(
    teamId
  );
}

export function createDeviceSession(teamId: string, tokenHash: string): DeviceSessionRow {
  const id = newId("dev");
  db.prepare("INSERT INTO device_session (id, team_id, token_hash) VALUES (?, ?, ?)").run(id, teamId, tokenHash);
  return db.prepare("SELECT * FROM device_session WHERE id = ?").get(id) as unknown as DeviceSessionRow;
}

export function findDeviceSessionByTokenHash(tokenHash: string): DeviceSessionRow | undefined {
  return db.prepare("SELECT * FROM device_session WHERE token_hash = ?").get(tokenHash) as unknown as
    | DeviceSessionRow
    | undefined;
}

export function touchDeviceSession(id: string): void {
  db.prepare("UPDATE device_session SET last_seen_at = datetime('now') WHERE id = ?").run(id);
}

export function listActiveDeviceSessionsForTeams(teamIds: string[]): DeviceSessionRow[] {
  if (teamIds.length === 0) return [];
  const placeholders = teamIds.map(() => "?").join(",");
  return db
    .prepare(`SELECT * FROM device_session WHERE team_id IN (${placeholders}) AND revoked_at IS NULL`)
    .all(...teamIds) as unknown as DeviceSessionRow[];
}

// --- team_state ---

export function ensureTeamState(teamId: string): TeamStateRow {
  const existing = db.prepare("SELECT * FROM team_state WHERE team_id = ?").get(teamId) as unknown as
    | TeamStateRow
    | undefined;
  if (existing) return existing;
  db.prepare("INSERT INTO team_state (team_id, state_json, version) VALUES (?, '{}', 0)").run(teamId);
  return db.prepare("SELECT * FROM team_state WHERE team_id = ?").get(teamId) as unknown as TeamStateRow;
}

export function getTeamState(teamId: string): TeamStateRow | undefined {
  return db.prepare("SELECT * FROM team_state WHERE team_id = ?").get(teamId) as unknown as TeamStateRow;
}

export function listTeamStates(teamIds: string[]): TeamStateRow[] {
  if (teamIds.length === 0) return [];
  const placeholders = teamIds.map(() => "?").join(",");
  return db.prepare(`SELECT * FROM team_state WHERE team_id IN (${placeholders})`).all(...teamIds) as unknown as TeamStateRow[];
}

/**
 * Imposta lo stato base del tavolo (spec §5, §8 "team_state"): il punto di
 * partenza da cui si riparte quando lo stato viene ricostruito dagli
 * effect_event (vedi rebuildTeamState in submissionPipeline.ts), per
 * fasi che assegnano risorse o dati iniziali non prodotti da nessuna
 * submission (es. "availableHours": 20 di una fase futura di Less is More).
 * Soluzione minima: pensata per essere chiamata all'inizializzazione del
 * tavolo/fase, PRIMA di eventuali submission — non fa optimistic locking,
 * non va usata durante il gioco attivo.
 */
export function setBaseState(teamId: string, baseStateJson: string): void {
  const current = getTeamState(teamId);
  const base = JSON.parse(baseStateJson) as Record<string, unknown>;
  const mergedState = current ? { ...JSON.parse(current.state_json), ...base } : base;
  db.prepare(
    "UPDATE team_state SET base_state_json = ?, state_json = ?, updated_at = datetime('now') WHERE team_id = ?"
  ).run(baseStateJson, JSON.stringify(mergedState), teamId);
}

/** Aggiorna solo se la versione corrisponde ancora (optimistic locking, spec §13). */
export function updateTeamStateWithVersionCheck(
  teamId: string,
  expectedVersion: number,
  newStateJson: string
): boolean {
  const result = db
    .prepare(
      "UPDATE team_state SET state_json = ?, version = version + 1, updated_at = datetime('now') WHERE team_id = ? AND version = ?"
    )
    .run(newStateJson, teamId, expectedVersion);
  return result.changes === 1;
}

/**
 * Sovrascrive la route di una squadra (fasi itinerary — override manuale
 * della regia, spec Fase 4) su ENTRAMBE le colonne: `base_state_json`
 * (fonte che survive a "Reset Sessione", stessa convenzione di
 * generateAndAssignRoutes) e `state_json.route` (copia mutabile da cui
 * resolveCurrentStep legge davvero, itineraryPipeline.ts) — altrimenti il
 * nuovo percorso non avrebbe effetto finché il tavolo non viene
 * resettato. A differenza di setBaseState (pensata per PRIMA che il
 * tavolo giochi, nessun locking), questa può essere chiamata a partita in
 * corso: stesso optimistic locking di updateTeamStateWithVersionCheck,
 * sulla stessa colonna `version` — le due funzioni sono quindi mutuamente
 * consistenti anche se una submission e un cambio di percorso arrivano in
 * concorrenza.
 */
export function setTeamRouteWithVersionCheck(teamId: string, expectedVersion: number, route: number[]): boolean {
  const current = getTeamState(teamId);
  if (!current) return false;
  const mergedState = { ...JSON.parse(current.state_json), route };
  const result = db
    .prepare(
      "UPDATE team_state SET base_state_json = ?, state_json = ?, version = version + 1, updated_at = datetime('now') WHERE team_id = ? AND version = ?"
    )
    .run(JSON.stringify({ route }), JSON.stringify(mergedState), teamId, expectedVersion);
  return result.changes === 1;
}

// --- submission ---

export function findSubmissionByIdempotencyKey(key: string): SubmissionRow | undefined {
  return db.prepare("SELECT * FROM submission WHERE idempotency_key = ?").get(key) as unknown as SubmissionRow;
}

export function findActiveSubmission(
  sessionId: string,
  teamId: string,
  activityId: string
): SubmissionRow | undefined {
  return db
    .prepare(
      "SELECT * FROM submission WHERE session_id = ? AND team_id = ? AND activity_id = ? AND status = 'accepted'"
    )
    .get(sessionId, teamId, activityId) as unknown as SubmissionRow;
}

export function createSubmission(params: {
  sessionId: string;
  teamId: string;
  activityId: string;
  payloadJson: string;
  idempotencyKey: string;
}): SubmissionRow {
  const id = newId("sub");
  db.prepare(
    `INSERT INTO submission (id, session_id, team_id, activity_id, payload_json, status, idempotency_key)
     VALUES (?, ?, ?, ?, ?, 'accepted', ?)`
  ).run(id, params.sessionId, params.teamId, params.activityId, params.payloadJson, params.idempotencyKey);
  return db.prepare("SELECT * FROM submission WHERE id = ?").get(id) as unknown as SubmissionRow;
}

export function listAcceptedSubmissions(sessionId: string, activityId: string): SubmissionRow[] {
  return db
    .prepare("SELECT * FROM submission WHERE session_id = ? AND activity_id = ? AND status = 'accepted'")
    .all(sessionId, activityId) as unknown as SubmissionRow[];
}

export function listSubmissionsForTeam(sessionId: string, teamId: string): SubmissionRow[] {
  return db
    .prepare("SELECT * FROM submission WHERE session_id = ? AND team_id = ? ORDER BY submitted_at DESC")
    .all(sessionId, teamId) as unknown as SubmissionRow[];
}

export function listAcceptedSubmissionsForTeam(sessionId: string, teamId: string): SubmissionRow[] {
  return db
    .prepare(
      "SELECT * FROM submission WHERE session_id = ? AND team_id = ? AND status = 'accepted' ORDER BY submitted_at DESC"
    )
    .all(sessionId, teamId) as unknown as SubmissionRow[];
}

/**
 * Effetti collegati a un insieme di submission, in ordine di inserimento
 * (rowid, non created_at: più effetti della stessa submission condividono
 * lo stesso secondo — datetime('now') ha risoluzione al secondo — quindi
 * created_at da solo non garantirebbe l'ordine cronologico reale).
 * Usata per ricostruire team_state dalle sole submission ancora accettate
 * (spec §5 "Eventi prima dei totali: i totali possono essere ricostruiti").
 */
export function listEffectEventsForSubmissions(submissionIds: string[]): EffectEventRow[] {
  if (submissionIds.length === 0) return [];
  const placeholders = submissionIds.map(() => "?").join(",");
  return db
    .prepare(`SELECT * FROM effect_event WHERE source_submission_id IN (${placeholders}) ORDER BY rowid ASC`)
    .all(...submissionIds) as unknown as EffectEventRow[];
}

export function reopenActiveSubmission(sessionId: string, teamId: string, activityId: string): number {
  const result = db
    .prepare(
      "UPDATE submission SET status = 'reopened' WHERE session_id = ? AND team_id = ? AND activity_id = ? AND status = 'accepted'"
    )
    .run(sessionId, teamId, activityId);
  return Number(result.changes);
}

// --- effect_event / score_event / audit_event ---

export function createEffectEvent(params: {
  sessionId: string;
  teamId: string;
  type: string;
  payloadJson: string;
  sourceSubmissionId?: string | null;
}): void {
  const id = newId("eff");
  db.prepare(
    "INSERT INTO effect_event (id, session_id, team_id, type, payload_json, source_submission_id) VALUES (?, ?, ?, ?, ?, ?)"
  ).run(id, params.sessionId, params.teamId, params.type, params.payloadJson, params.sourceSubmissionId ?? null);
}

export function createScoreEvent(params: {
  sessionId: string;
  teamId: string;
  amount: number;
  reason: string;
  sourceId?: string | null;
}): void {
  const id = newId("sco");
  db.prepare(
    "INSERT INTO score_event (id, session_id, team_id, amount, reason, source_id) VALUES (?, ?, ?, ?, ?, ?)"
  ).run(id, params.sessionId, params.teamId, params.amount, params.reason, params.sourceId ?? null);
}

export function createAuditEvent(params: {
  actorType: string;
  actorId: string;
  sessionId?: string | null;
  action: string;
  payloadJson: string;
}): void {
  const id = newId("aud");
  db.prepare(
    "INSERT INTO audit_event (id, actor_type, actor_id, session_id, action, payload_json) VALUES (?, ?, ?, ?, ?, ?)"
  ).run(id, params.actorType, params.actorId, params.sessionId ?? null, params.action, params.payloadJson);
}

// --- strumenti DEV (routes/dev.ts) ---
// Le funzioni qui sotto NON fanno parte del game engine: non passano dalla
// submission pipeline, non toccano l'event sourcing come fonte di verità
// durante il gioco, non usano il lifecycle di lifecycle.ts. Si limitano a
// creare o eliminare righe, per permettere cicli rapidi di test in
// sviluppo (spec richiesta dall'utente). Sono raggiungibili solo se
// isDevEnvironment() è vero (vedi app.ts + routes/dev.ts).

/** Tutte le sessioni con qualche metadato utile per l'archivio dev (nome gioco, numero tavoli). */
export function listAllSessionsWithMeta(): SessionWithMetaRow[] {
  return db
    .prepare(
      `SELECT s.*, g.name as game_name, g.slug as game_slug,
         (SELECT COUNT(*) FROM team t WHERE t.session_id = s.id) as team_count
       FROM session s
       JOIN game_version gv ON gv.id = s.game_version_id
       JOIN game g ON g.id = gv.game_id
       ORDER BY s.created_at DESC`
    )
    .all() as unknown as SessionWithMetaRow[];
}

/**
 * "Reset Sessione": svuota submission/score_event/effect_event/audit_event
 * della sessione, ripristina team_state al base_state di ciascun tavolo
 * (non a "{}": rispetta l'eventuale stato iniziale impostato con
 * setBaseState), riporta la sessione in DRAFT. NON tocca game,
 * game_version, team: è un reset della partita, non del progetto — i
 * tavoli e i loro codici di accesso restano gli stessi.
 */
export function resetSessionData(sessionId: string): void {
  transaction(() => {
    // itinerary_photo e voucher referenziano submission (FK, PRAGMA
    // foreign_keys=ON): vanno cancellati PRIMA, altrimenti la DELETE su
    // submission sotto violerebbe il vincolo. Righe additive del gioco
    // "Il mistero della città" (vedi db.ts) — nessun impatto su Less is
    // More, che non le usa mai.
    db.prepare("DELETE FROM itinerary_photo WHERE session_id = ?").run(sessionId);
    db.prepare("DELETE FROM voucher WHERE session_id = ?").run(sessionId);
    db.prepare("DELETE FROM submission WHERE session_id = ?").run(sessionId);
    db.prepare("DELETE FROM score_event WHERE session_id = ?").run(sessionId);
    db.prepare("DELETE FROM effect_event WHERE session_id = ?").run(sessionId);
    db.prepare("DELETE FROM audit_event WHERE session_id = ?").run(sessionId);

    const teamIds = (
      db.prepare("SELECT id FROM team WHERE session_id = ?").all(sessionId) as { id: string }[]
    ).map((r) => r.id);
    for (const teamId of teamIds) {
      const state = db.prepare("SELECT base_state_json FROM team_state WHERE team_id = ?").get(teamId) as
        | { base_state_json: string }
        | undefined;
      const base = state?.base_state_json ?? "{}";
      db.prepare(
        "UPDATE team_state SET state_json = ?, version = 0, updated_at = datetime('now') WHERE team_id = ?"
      ).run(base, teamId);
    }

    db.prepare(
      "UPDATE session SET status = 'DRAFT', current_phase_id = NULL, phase_status = 'CLOSED', updated_at = datetime('now') WHERE id = ?"
    ).run(sessionId);
  });
}

/**
 * "Duplica sessione": nuova sessione (DRAFT, per costruzione: è il default
 * della colonna) sulla stessa game_version, con gli stessi tavoli (stessi
 * nomi, nuovi id e nuovi access_code — devono essere univoci nel DB) e la
 * stessa configurazione (base_state_json copiato), ma senza submission,
 * punteggi o audit. `nameOverride` sostituisce il suffisso "(copy)" di
 * default se fornito.
 */
export function duplicateSession(sessionId: string, nameOverride?: string): SessionRow {
  return transaction(() => {
    const original = getSession(sessionId);
    if (!original) throw new Error(`session ${sessionId} not found`);

    const newName = nameOverride?.trim() || `${original.name} (copy)`;
    const newSessionId = newId("ses");
    db.prepare("INSERT INTO session (id, game_version_id, name) VALUES (?, ?, ?)").run(
      newSessionId,
      original.game_version_id,
      newName
    );

    const teams = db.prepare("SELECT * FROM team WHERE session_id = ?").all(sessionId) as unknown as TeamRow[];
    for (const t of teams) {
      const newTeamId = newId("team");
      const code = newAccessCode();
      db.prepare("INSERT INTO team (id, session_id, name, access_code, status) VALUES (?, ?, ?, ?, 'PENDING')").run(
        newTeamId,
        newSessionId,
        t.name,
        code
      );
      const originalState = db.prepare("SELECT base_state_json FROM team_state WHERE team_id = ?").get(t.id) as
        | { base_state_json: string }
        | undefined;
      const baseState = originalState?.base_state_json ?? "{}";
      db.prepare(
        "INSERT INTO team_state (team_id, state_json, base_state_json, version) VALUES (?, ?, ?, 0)"
      ).run(newTeamId, baseState, baseState);
    }

    // Facilitatori: fanno parte della configurazione dello staff, non
    // della partita — restano assegnati (stesso token, stesse squadre non
    // esistono più con lo stesso id quindi vengono rimappate per NOME,
    // "meglio sforzo": se un tavolo cambia nome tra una sessione e l'altra
    // il facilitatore va riassegnato a mano dalla regia).
    const facilitators = db
      .prepare("SELECT * FROM facilitator WHERE session_id = ?")
      .all(sessionId) as unknown as FacilitatorRow[];
    if (facilitators.length > 0) {
      const newTeamsByName = new Map(
        (db.prepare("SELECT * FROM team WHERE session_id = ?").all(newSessionId) as unknown as TeamRow[]).map((t) => [
          t.name,
          t.id,
        ])
      );
      const oldTeamsById = new Map(teams.map((t) => [t.id, t.name]));
      for (const fac of facilitators) {
        const oldTeamIds = JSON.parse(fac.team_ids_json) as string[];
        const newTeamIds = oldTeamIds
          .map((id) => oldTeamsById.get(id))
          .filter((name): name is string => Boolean(name))
          .map((name) => newTeamsByName.get(name))
          .filter((id): id is string => Boolean(id));
        const newFacId = newId("fac");
        db.prepare(
          "INSERT INTO facilitator (id, session_id, name, token, team_ids_json) VALUES (?, ?, ?, ?, ?)"
        ).run(newFacId, newSessionId, fac.name, fac.token, JSON.stringify(newTeamIds));
      }
    }

    return getSession(newSessionId)!;
  });
}

/**
 * "Elimina (solo DEV)": cancellazione completa e irreversibile — sessione,
 * tavoli, token (device_session), tutti gli eventi collegati. Ordine di
 * cancellazione vincolato dalle foreign key dichiarate in db.ts (figli
 * prima dei genitori: PRAGMA foreign_keys = ON è attivo).
 */
export function deleteSessionCascade(sessionId: string): void {
  transaction(() => {
    const teamIds = (
      db.prepare("SELECT id FROM team WHERE session_id = ?").all(sessionId) as { id: string }[]
    ).map((r) => r.id);

    db.prepare("DELETE FROM itinerary_photo WHERE session_id = ?").run(sessionId);
    db.prepare("DELETE FROM voucher WHERE session_id = ?").run(sessionId);
    db.prepare("DELETE FROM submission WHERE session_id = ?").run(sessionId);
    db.prepare("DELETE FROM score_event WHERE session_id = ?").run(sessionId);
    db.prepare("DELETE FROM effect_event WHERE session_id = ?").run(sessionId);
    db.prepare("DELETE FROM audit_event WHERE session_id = ?").run(sessionId);
    db.prepare("DELETE FROM facilitator WHERE session_id = ?").run(sessionId);

    if (teamIds.length > 0) {
      const placeholders = teamIds.map(() => "?").join(",");
      db.prepare(`DELETE FROM device_session WHERE team_id IN (${placeholders})`).run(...teamIds);
      db.prepare(`DELETE FROM team_state WHERE team_id IN (${placeholders})`).run(...teamIds);
    }

    db.prepare("DELETE FROM team WHERE session_id = ?").run(sessionId);
    db.prepare("DELETE FROM session WHERE id = ?").run(sessionId);
  });
}

/**
 * "Riapri" (solo DEV): bypassa deliberatamente il lifecycle ufficiale
 * (lifecycle.ts NON consente COMPLETED -> DRAFT: è una scelta di design
 * per l'uso in aula) per permettere di rigiocare la stessa sessione senza
 * duplicarla, comodo in sviluppo. Aggiorna solo se lo stato attuale è
 * ancora COMPLETED (evita una race con un altro reopen/transition
 * concorrente); ritorna false se non è cambiato nulla.
 */
export function reopenCompletedSessionDev(sessionId: string): boolean {
  const result = db
    .prepare(
      "UPDATE session SET status = 'DRAFT', current_phase_id = NULL, phase_status = 'CLOSED', updated_at = datetime('now') WHERE id = ? AND status = 'COMPLETED'"
    )
    .run(sessionId);
  return result.changes === 1;
}

// --- facilitator / itinerary_photo / voucher (Il mistero della città) ---

export interface FacilitatorRow {
  id: string;
  session_id: string;
  name: string;
  token: string;
  team_ids_json: string;
  created_at: string;
}

export function createFacilitator(sessionId: string, name: string, token: string, teamIds: string[]): FacilitatorRow {
  const id = newId("fac");
  db.prepare(
    "INSERT INTO facilitator (id, session_id, name, token, team_ids_json) VALUES (?, ?, ?, ?, ?)"
  ).run(id, sessionId, name, token, JSON.stringify(teamIds));
  return db.prepare("SELECT * FROM facilitator WHERE id = ?").get(id) as unknown as FacilitatorRow;
}

export function listFacilitators(sessionId: string): FacilitatorRow[] {
  return db.prepare("SELECT * FROM facilitator WHERE session_id = ?").all(sessionId) as unknown as FacilitatorRow[];
}

export function findFacilitatorByToken(sessionId: string, token: string): FacilitatorRow | undefined {
  return db
    .prepare("SELECT * FROM facilitator WHERE session_id = ? AND token = ?")
    .get(sessionId, token) as unknown as FacilitatorRow | undefined;
}

/**
 * Lookup del token facilitatore SENZA conoscere già la sessione (usato
 * dal middleware di autenticazione: il facilitatore manda solo il token
 * nell'header, come il tavolo — vedi teamAuth.ts — non un sessionId
 * nell'URL). Il vincolo UNIQUE è per (session_id, token) a livello di
 * schema, ma i token sono generati casuali abbastanza lunghi (10 caratteri,
 * alfabeto da 33 simboli) che una collisione tra sessioni diverse è
 * praticamente impossibile: qui trattiamo il token come identificativo
 * univoco de facto e prendiamo la prima corrispondenza.
 */
export function findFacilitatorByTokenAny(token: string): FacilitatorRow | undefined {
  return db.prepare("SELECT * FROM facilitator WHERE token = ?").get(token) as unknown as FacilitatorRow | undefined;
}

export interface ItineraryPhotoRow {
  id: string;
  session_id: string;
  team_id: string;
  step_id: string;
  submission_id: string;
  file_path: string;
  attempt: number;
  status: string;
  note: string | null;
  created_at: string;
  decided_at: string | null;
}

export function countPhotoAttempts(sessionId: string, teamId: string, stepId: string): number {
  const row = db
    .prepare("SELECT COUNT(*) as c FROM itinerary_photo WHERE session_id = ? AND team_id = ? AND step_id = ?")
    .get(sessionId, teamId, stepId) as { c: number };
  return row.c;
}

export function createItineraryPhoto(params: {
  sessionId: string;
  teamId: string;
  stepId: string;
  submissionId: string;
  filePath: string;
  attempt: number;
}): ItineraryPhotoRow {
  const id = newId("photo");
  db.prepare(
    `INSERT INTO itinerary_photo (id, session_id, team_id, step_id, submission_id, file_path, attempt)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(id, params.sessionId, params.teamId, params.stepId, params.submissionId, params.filePath, params.attempt);
  return db.prepare("SELECT * FROM itinerary_photo WHERE id = ?").get(id) as unknown as ItineraryPhotoRow;
}

export function getItineraryPhoto(id: string): ItineraryPhotoRow | undefined {
  return db.prepare("SELECT * FROM itinerary_photo WHERE id = ?").get(id) as unknown as ItineraryPhotoRow | undefined;
}

/** Restituisce true solo se la riga era ancora 'pending' (evita doppie decisioni concorrenti sulla stessa foto). */
export function decideItineraryPhoto(id: string, status: "approved" | "rejected", note: string | null): boolean {
  const result = db
    .prepare(
      "UPDATE itinerary_photo SET status = ?, note = ?, decided_at = datetime('now') WHERE id = ? AND status = 'pending'"
    )
    .run(status, note, id);
  return result.changes === 1;
}

export function listPendingPhotos(sessionId: string, teamIds?: string[]): ItineraryPhotoRow[] {
  if (teamIds && teamIds.length === 0) return [];
  if (teamIds) {
    const placeholders = teamIds.map(() => "?").join(",");
    return db
      .prepare(
        `SELECT * FROM itinerary_photo WHERE session_id = ? AND status = 'pending' AND team_id IN (${placeholders}) ORDER BY created_at ASC`
      )
      .all(sessionId, ...teamIds) as unknown as ItineraryPhotoRow[];
  }
  return db
    .prepare("SELECT * FROM itinerary_photo WHERE session_id = ? AND status = 'pending' ORDER BY created_at ASC")
    .all(sessionId) as unknown as ItineraryPhotoRow[];
}

/**
 * Variante di listPendingPhotos senza il filtro fisso su "pending" (Fase
 * 6: galleria foto in regia — tutte le foto della sessione, non solo
 * quelle ancora da decidere). `status` opzionale filtra su un singolo
 * stato ("pending"/"approved"/"rejected"); omesso, restituisce tutte.
 */
export function listPhotosForSession(sessionId: string, status?: string): ItineraryPhotoRow[] {
  if (status) {
    return db
      .prepare("SELECT * FROM itinerary_photo WHERE session_id = ? AND status = ? ORDER BY created_at DESC")
      .all(sessionId, status) as unknown as ItineraryPhotoRow[];
  }
  return db
    .prepare("SELECT * FROM itinerary_photo WHERE session_id = ? ORDER BY created_at DESC")
    .all(sessionId) as unknown as ItineraryPhotoRow[];
}

export interface VoucherRow {
  token: string;
  session_id: string;
  team_id: string;
  step_id: string;
  status: string;
  generated_at: string;
  used_at: string | null;
}

export function findVoucherForStep(sessionId: string, teamId: string, stepId: string): VoucherRow | undefined {
  return db
    .prepare("SELECT * FROM voucher WHERE session_id = ? AND team_id = ? AND step_id = ?")
    .get(sessionId, teamId, stepId) as unknown as VoucherRow | undefined;
}

export function createVoucher(sessionId: string, teamId: string, stepId: string, token: string): VoucherRow {
  db.prepare(
    "INSERT INTO voucher (token, session_id, team_id, step_id) VALUES (?, ?, ?, ?)"
  ).run(token, sessionId, teamId, stepId);
  return db.prepare("SELECT * FROM voucher WHERE token = ?").get(token) as unknown as VoucherRow;
}
