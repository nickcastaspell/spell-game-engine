import { computeSubmissionOutcome, canAcceptSubmissions } from "@spell/game-core";
import { ModuleContext } from "@spell/shared-types";
import { moduleRegistry } from "../modules-registry";
import { ApiError } from "./response";
import { findPhase, parseDefinition, requireActivity } from "./gameDefinition";
import { parseState, stringifyState } from "./teamState";
import { applyEffectToState } from "./effects";
import { deepEqualJson } from "./canonical";
import { transaction, isUniqueConstraintError } from "./db";
import {
  createAuditEvent,
  createEffectEvent,
  createScoreEvent,
  createSubmission,
  ensureTeamState,
  findActiveSubmission,
  findSubmissionByIdempotencyKey,
  getGameVersionById,
  getSession,
  getTeam,
  listAcceptedSubmissionsForTeam,
  listEffectEventsForSubmissions,
  reopenActiveSubmission,
  updateTeamStateWithVersionCheck,
  type SubmissionRow,
} from "./repo";

export interface SubmitResult {
  submissionId: string;
  status: "accepted";
  messages: string[];
  replay: boolean;
}

/**
 * Decide cosa fare quando esiste già una submission per questa
 * idempotencyKey — sia nel percorso "normale" (lookup all'inizio) sia nel
 * percorso di race (v5.1: prima il ramo di race non riapplicava questi
 * controlli e restituiva un replay "cieco"). Stessa funzione in entrambi
 * i punti, cosi' non possono divergere.
 */
/** Esportata: riusata anche da itineraryPipeline.ts, stessa semantica di conflitto idempotenza. */
export function resolveIdempotentReplay(
  existing: SubmissionRow,
  teamId: string,
  activityId: string,
  payload: Record<string, unknown>
): SubmitResult {
  if (existing.team_id !== teamId || existing.activity_id !== activityId) {
    throw new ApiError(409, "idempotency_conflict", "idempotencyKey già usata per un altro invio");
  }
  if (!deepEqualJson(JSON.parse(existing.payload_json), payload)) {
    throw new ApiError(
      409,
      "idempotency_conflict",
      "idempotencyKey già usata con un payload diverso: genera una nuova chiave per un invio diverso"
    );
  }
  if (existing.status === "reopened") {
    // La submission originale è stata riaperta dalla regia: la vecchia
    // chiave non deve più produrre un "replay accettato" silenzioso,
    // altrimenti il tavolo crede che il suo primo invio sia ancora valido.
    // Serve una idempotencyKey nuova per il nuovo invio.
    throw new ApiError(
      409,
      "submission_reopened",
      "Questa submission è stata riaperta dalla regia: genera una nuova idempotencyKey per il nuovo invio"
    );
  }
  return { submissionId: existing.id, status: "accepted", messages: [], replay: true };
}

/**
 * submission -> regole -> effetti -> stato, in un'unica transazione
 * (spec §13). Idempotente via idempotencyKey, con optimistic locking
 * su team_state.version.
 */
export async function submitTeamActivity(params: {
  sessionId: string;
  teamId: string;
  activityId: string;
  payload: Record<string, unknown>;
  idempotencyKey: string;
}): Promise<SubmitResult> {
  const { sessionId, teamId, activityId, payload, idempotencyKey } = params;

  // Replay idempotente: se la chiave è già stata usata, decide se è un
  // vero replay (stesso team/attività/payload, submission ancora accettata)
  // o un conflitto — vedi resolveIdempotentReplay.
  const existing = findSubmissionByIdempotencyKey(idempotencyKey);
  if (existing) {
    return resolveIdempotentReplay(existing, teamId, activityId, payload);
  }

  const session = getSession(sessionId);
  if (!session) throw new ApiError(404, "session_not_found", "Sessione non trovata");
  if (!canAcceptSubmissions(session.status as never)) {
    throw new ApiError(409, "session_not_running", "La sessione non è in RUNNING");
  }
  if (session.phase_status !== "OPEN") {
    throw new ApiError(409, "phase_closed", "La fase non è aperta");
  }

  const gameVersion = getGameVersionById(session.game_version_id);
  if (!gameVersion) throw new ApiError(500, "game_version_missing", "game_version mancante");
  const definition = parseDefinition(gameVersion.definition_json);

  if (session.current_phase_id === null) {
    throw new ApiError(409, "no_active_phase", "Nessuna fase attiva");
  }
  const phase = findPhase(definition, session.current_phase_id);
  // Le fasi "itinerary" (Il mistero della città) hanno una pipeline di
  // submission dedicata (lib/itineraryPipeline.ts): se il client chiama
  // questo endpoint mentre la fase corrente è itinerary, è un uso scorretto
  // dell'API, non un caso da far proseguire silenziosamente.
  if (phase.mode === "itinerary") {
    throw new ApiError(
      400,
      "wrong_pipeline_for_itinerary_phase",
      "Questa fase è di tipo itinerary: usa /api/team/itinerary/submit, non /api/team/submissions."
    );
  }
  const activity = requireActivity(phase);
  if (activity.id !== activityId) {
    throw new ApiError(400, "activity_mismatch", "activityId non corrisponde alla fase corrente");
  }

  const team = getTeam(teamId);
  if (!team || team.session_id !== sessionId) {
    throw new ApiError(404, "team_not_found", "Tavolo non trovato in questa sessione");
  }

  // Un solo invio attivo per attività (criterio §16): un submission
  // 'accepted' preesistente blocca nuovi invii finché la regia non riapre.
  const activeSubmission = findActiveSubmission(sessionId, teamId, activityId);
  if (activeSubmission) {
    throw new ApiError(409, "already_submitted", "Invio già presente per questa attività");
  }

  const teamStateRow = ensureTeamState(teamId);

  const mod = moduleRegistry.get(activity.type);
  const ctx: ModuleContext = {
    sessionId,
    teamId,
    phaseId: phase.id,
    activityId,
    activityConfig: activity.config,
    content: definition.content,
    teamState: parseState(teamStateRow.state_json),
  };

  const outcome = computeSubmissionOutcome(mod, ctx, payload);
  if (!outcome.accepted) {
    throw new ApiError(422, "validation_failed", outcome.errors.join("; "));
  }

  const messages: string[] = [];

  try {
    const submissionId = transaction(() => {
      const submission = createSubmission({
        sessionId,
        teamId,
        activityId,
        payloadJson: JSON.stringify(payload),
        idempotencyKey,
      });

      let state = parseState(teamStateRow.state_json);

      for (const effect of outcome.effects) {
        createEffectEvent({
          sessionId,
          teamId,
          type: effect.type,
          payloadJson: JSON.stringify(effect.payload),
          sourceSubmissionId: submission.id,
        });

        state = applyEffectToState(state, effect);

        if (effect.type === "score.add") {
          const amount = Number(effect.payload.amount ?? 0);
          const reason = String(effect.payload.reason ?? "");
          createScoreEvent({ sessionId, teamId, amount, reason, sourceId: submission.id });
        }

        if (effect.type === "audit.log") {
          createAuditEvent({
            actorType: "team",
            actorId: teamId,
            sessionId,
            action: "module.audit.log",
            payloadJson: JSON.stringify(effect.payload),
          });
        }

        if (effect.type === "message.emit") {
          messages.push(String(effect.payload.text ?? ""));
        }
      }

      // Optimistic locking: l'update ha successo solo se la versione
      // corrisponde ancora a quella letta a inizio pipeline (spec §13).
      const success = updateTeamStateWithVersionCheck(teamId, teamStateRow.version, stringifyState(state));
      if (!success) {
        throw new ApiError(409, "state_conflict", "team_state modificato concorrentemente, riprovare");
      }

      createAuditEvent({
        actorType: "team",
        actorId: teamId,
        sessionId,
        action: "submission.accepted",
        payloadJson: JSON.stringify({ activityId, submissionId: submission.id }),
      });

      return submission.id;
    });

    return { submissionId, status: "accepted", messages, replay: false };
  } catch (e) {
    if (isUniqueConstraintError(e, "idempotency_key")) {
      // Race su idempotencyKey: un'altra richiesta con la stessa chiave ha
      // vinto la corsa sul vincolo UNIQUE. PRIMA questo ramo restituiva un
      // replay "cieco" senza riverificare team/attività/payload — bug
      // corretto in v5.1: stessa verifica del percorso normale.
      const raced = findSubmissionByIdempotencyKey(idempotencyKey);
      if (raced) {
        return resolveIdempotentReplay(raced, teamId, activityId, payload);
      }
    }
    throw e;
  }
}

/**
 * Ricostruisce team_state ripercorrendo, in ordine, gli effect_event
 * delle sole submission ANCORA accettate del tavolo (spec §5 "Eventi
 * prima dei totali: i totali possono essere ricostruiti"). È la base
 * della riapertura: una submission riaperta smette di contribuire allo
 * stato semplicemente perché il suo status non è più 'accepted', senza
 * bisogno di "sottrarre a mano" i suoi effetti.
 */
function rebuildTeamState(sessionId: string, teamId: string): Record<string, unknown> {
  // Si riparte dallo stato BASE del tavolo (v5.1), non da {}: una fase
  // futura può assegnare risorse o dati iniziali che non derivano da
  // nessuna submission (es. "availableHours"), e il rebuild non deve
  // farli sparire solo perché si riapre un'altra attività.
  const teamStateRow = ensureTeamState(teamId);
  const base = parseState(teamStateRow.base_state_json);

  const accepted = listAcceptedSubmissionsForTeam(sessionId, teamId);
  const effects = listEffectEventsForSubmissions(accepted.map((s) => s.id));

  let state: Record<string, unknown> = { ...base };
  for (const row of effects) {
    state = applyEffectToState(state, {
      type: row.type as never,
      payload: JSON.parse(row.payload_json),
    });
  }
  return state;
}

/**
 * Consente alla regia di riaprire l'invio di un singolo tavolo (spec §14.2,
 * §16). Bug corretto: la versione precedente marcava la submission come
 * 'reopened' ma lasciava punteggio e stato invariati, quindi una nuova
 * submission SOMMAVA il proprio punteggio a quello vecchio invece di
 * sostituirlo. Ora lo stato viene ricostruito dalle sole submission
 * ancora accettate (rebuildTeamState) e la differenza di punteggio viene
 * registrata come score_event compensativo, cosi' il log resta la fonte
 * di verità anche per un totale sommato esternamente (criterio §16 "il
 * punteggio è spiegabile tramite score_event").
 */
export async function reopenTeamSubmission(
  sessionId: string,
  teamId: string,
  activityId: string
): Promise<number> {
  return transaction(() => {
    const active = findActiveSubmission(sessionId, teamId, activityId);
    if (!active) return 0;

    const stateRowBefore = ensureTeamState(teamId);
    const stateBefore = parseState(stateRowBefore.state_json);
    const scoreBefore = typeof stateBefore.score === "number" ? stateBefore.score : 0;

    const count = reopenActiveSubmission(sessionId, teamId, activityId);

    const newState = rebuildTeamState(sessionId, teamId);
    const scoreAfter = typeof newState.score === "number" ? newState.score : 0;
    const delta = scoreAfter - scoreBefore;

    // Optimistic locking anche qui (v5.1): niente sostituzione "cieca" di
    // team_state durante il rebuild. Su SQLite con BEGIN IMMEDIATE il
    // rischio pratico è basso, ma la stessa garanzia serve in vista di un
    // adapter Postgres futuro, dove la scrittura non sarebbe serializzata
    // allo stesso modo.
    const success = updateTeamStateWithVersionCheck(teamId, stateRowBefore.version, stringifyState(newState));
    if (!success) {
      throw new ApiError(409, "state_version_conflict", "team_state modificato concorrentemente, riprovare");
    }

    if (delta !== 0) {
      createScoreEvent({
        sessionId,
        teamId,
        amount: delta,
        reason: `reopen:${activityId}:compensate`,
        sourceId: active.id,
      });
    }

    createAuditEvent({
      actorType: "control",
      actorId: "regia",
      sessionId,
      action: "submission.reopened",
      payloadJson: JSON.stringify({ teamId, activityId, submissionId: active.id, scoreDelta: delta }),
    });

    return count;
  });
}
