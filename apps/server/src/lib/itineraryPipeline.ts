import { computeSubmissionOutcome, canAcceptSubmissions, generateItineraryRoutes } from "@spell/game-core";
import { Effect, GameDefinition, ItineraryStepContent, ModuleContext, PhaseDefinition } from "@spell/shared-types";
import { moduleRegistry } from "../modules-registry";
import { ApiError } from "./response";
import { findPhase, parseDefinition, requireItinerary } from "./gameDefinition";
import { parseState, stringifyState } from "./teamState";
import { applyEffectToState } from "./effects";
import { transaction, isUniqueConstraintError } from "./db";
import { photoStorage } from "./uploads";
import { newVoucherToken } from "./tokens";
import { resolveIdempotentReplay, type SubmitResult } from "./submissionPipeline";
import {
  countPhotoAttempts,
  createAuditEvent,
  createEffectEvent,
  createItineraryPhoto,
  createScoreEvent,
  createSubmission,
  createVoucher,
  decideItineraryPhoto as decidePhotoRow,
  ensureTeamState,
  findSubmissionByIdempotencyKey,
  findVoucherForStep,
  getGameVersionById,
  getItineraryPhoto,
  getSession,
  getTeam,
  listTeams,
  setBaseState,
  updateTeamStateWithVersionCheck,
} from "./repo";

// Orchestrazione delle fasi "itinerary" (Il mistero della città):
// ogni squadra ha una propria sequenza di tappe (route, in
// team_state.base_state_json — vedi generateAndAssignRoutes) e una
// posizione corrente (team_state.state_json.position, 1-based, come
// l'originale "tappa_corrente"). A differenza di submissionPipeline.ts
// (Less is More, un'unica activity sincronizzata dalla regia), qui
// l'activityId di ogni submission è la tappa in cui la squadra si trova
// IN QUEL MOMENTO, risolta lato server — il client manda solo lo stepId
// che si aspetta di vedere, usato come controllo di coerenza, non come
// selezione libera.
//
// Riusa lo stesso contratto GameModule/computeSubmissionOutcome di
// submissionPipeline.ts (stessi moduli potrebbero in teoria essere usati
// anche da fasi single_submission), la stessa idempotenza
// (resolveIdempotentReplay, importata da submissionPipeline.ts per non
// duplicarla), lo stesso optimistic locking su team_state.version. NON
// riusa il vincolo "una sola submission attiva per activity": qui un
// tentativo sbagliato non blocca i successivi (spec: le tappe testo/guida/
// qr/foto sono pensate per essere riprovate, non "single shot").

export interface SubmitItineraryResult extends SubmitResult {
  voucherToken?: string;
}

function resolveCurrentStep(
  definition: GameDefinition,
  phase: PhaseDefinition,
  teamState: Record<string, unknown>
): ItineraryStepContent | null {
  const itinerary = requireItinerary(phase);
  const steps = (definition.content[itinerary.stepsSource] as ItineraryStepContent[] | undefined) ?? [];
  const route = Array.isArray(teamState.route) ? (teamState.route as number[]) : [];
  const position = typeof teamState.position === "number" ? teamState.position : 1;
  const stepNumber = route[position - 1];
  if (stepNumber === undefined) return null;
  return steps.find((s) => s.number === stepNumber) ?? null;
}

function buildModuleContext(
  sessionId: string,
  teamId: string,
  phase: PhaseDefinition,
  step: ItineraryStepContent,
  definition: GameDefinition,
  teamState: Record<string, unknown>
): ModuleContext {
  return {
    sessionId,
    teamId,
    phaseId: phase.id,
    activityId: step.id,
    // L'orchestrazione unisce points/hint (campi di ItineraryStepContent,
    // non di config) dentro activityConfig: è la convenzione con cui i
    // moduli itinerary (textMatch, voucher...) possono leggere il punteggio
    // della tappa senza che ogni game definition debba ripeterlo dentro
    // "config" oltre che nel campo "points" validato genericamente (vedi
    // gameDefinitionValidation.ts, validateItinerarySemantics).
    activityConfig: { ...step.config, points: step.points, hint: step.hint },
    content: definition.content,
    teamState,
  };
}

/** Stato itinerario di una squadra, per l'endpoint GET (routes/itinerary.ts). */
export function getItineraryStatus(sessionId: string, teamId: string, phaseId: string) {
  const session = getSession(sessionId);
  if (!session) throw new ApiError(404, "session_not_found", "Sessione non trovata");
  const gameVersion = getGameVersionById(session.game_version_id);
  if (!gameVersion) throw new ApiError(500, "game_version_missing", "game_version mancante");
  const definition = parseDefinition(gameVersion.definition_json);
  const phase = findPhase(definition, phaseId);
  if (phase.mode !== "itinerary") {
    throw new ApiError(400, "not_itinerary_phase", `La fase "${phaseId}" non è di tipo itinerary`);
  }

  const teamStateRow = ensureTeamState(teamId);
  const state = parseState(teamStateRow.state_json);
  const route = Array.isArray(state.route) ? (state.route as number[]) : [];
  const position = typeof state.position === "number" ? state.position : 1;
  const step = resolveCurrentStep(definition, phase, state);

  // Il traguardo ("finale") non emette itinerary.advance — non c'è una
  // tappa successiva, quindi position non supera mai route.length da sola
  // (vedi finaleModule in itineraryBasics.ts). Il segnale di completamento
  // è itineraryCompletedAt in state, scritto dalla submission della tappa
  // finale: senza questo controllo lo stato "completato" non si vedrebbe
  // mai qui, anche dopo aver inviato la tappa finale.
  const completedAt = typeof state.itineraryCompletedAt === "string" ? state.itineraryCompletedAt : null;

  if (!step || completedAt) {
    return {
      completed: true,
      completedAt,
      position,
      totalSteps: route.length,
      score: typeof state.score === "number" ? state.score : 0,
      step: null,
    };
  }

  const mod = moduleRegistry.get(step.type);
  const ctx = buildModuleContext(sessionId, teamId, phase, step, definition, state);
  const view = mod.playerView(ctx);
  const hintsUsed = (state.hintsUsed as Record<string, boolean> | undefined) ?? {};

  return {
    completed: false,
    position,
    totalSteps: route.length,
    score: typeof state.score === "number" ? state.score : 0,
    step: {
      id: step.id,
      title: step.title,
      body: step.body,
      view,
      hasHint: Boolean(step.hint) && !hintsUsed[step.id],
    },
  };
}

/**
 * submission -> regole -> effetti -> stato, in un'unica transazione, come
 * submitTeamActivity (submissionPipeline.ts) ma per una tappa itinerary
 * risolta dinamicamente dalla posizione corrente della squadra, non da un
 * activityId fisso di fase.
 */
export async function submitItineraryStep(params: {
  sessionId: string;
  teamId: string;
  phaseId: string;
  stepId: string;
  payload: Record<string, unknown>;
  idempotencyKey: string;
}): Promise<SubmitItineraryResult> {
  const { sessionId, teamId, phaseId, stepId, payload, idempotencyKey } = params;

  const existing = findSubmissionByIdempotencyKey(idempotencyKey);
  if (existing) {
    return resolveIdempotentReplay(existing, teamId, stepId, payload);
  }

  const session = getSession(sessionId);
  if (!session) throw new ApiError(404, "session_not_found", "Sessione non trovata");
  if (!canAcceptSubmissions(session.status as never)) {
    throw new ApiError(409, "session_not_running", "La sessione non è in RUNNING");
  }
  if (session.phase_status !== "OPEN" || session.current_phase_id !== phaseId) {
    throw new ApiError(409, "phase_closed", "La fase itinerary non è aperta");
  }

  const gameVersion = getGameVersionById(session.game_version_id);
  if (!gameVersion) throw new ApiError(500, "game_version_missing", "game_version mancante");
  const definition = parseDefinition(gameVersion.definition_json);
  const phase = findPhase(definition, phaseId);
  if (phase.mode !== "itinerary") {
    throw new ApiError(400, "not_itinerary_phase", `La fase "${phaseId}" non è di tipo itinerary`);
  }
  const itinerary = requireItinerary(phase);

  const team = getTeam(teamId);
  if (!team || team.session_id !== sessionId) {
    throw new ApiError(404, "team_not_found", "Tavolo non trovato in questa sessione");
  }

  const teamStateRow = ensureTeamState(teamId);
  const initialState = parseState(teamStateRow.state_json);

  if (typeof initialState.itineraryCompletedAt === "string") {
    throw new ApiError(409, "itinerary_completed", "Il percorso di questa squadra è già completato");
  }
  const step = resolveCurrentStep(definition, phase, initialState);
  if (!step) {
    throw new ApiError(409, "itinerary_completed", "Il percorso di questa squadra è già completato");
  }
  if (step.id !== stepId) {
    throw new ApiError(400, "step_mismatch", "stepId non corrisponde alla tappa corrente della squadra");
  }

  if (step.type === "photoApproval") {
    const maxAttempts = itinerary.maxPhotoAttempts ?? 3;
    const attemptsSoFar = countPhotoAttempts(sessionId, teamId, step.id);
    if (attemptsSoFar >= maxAttempts) {
      throw new ApiError(409, "photo_attempts_exceeded", `Massimo ${maxAttempts} tentativi raggiunto`);
    }
  }

  const mod = moduleRegistry.get(step.type);
  const ctx = buildModuleContext(sessionId, teamId, phase, step, definition, initialState);
  const outcome = computeSubmissionOutcome(mod, ctx, payload);
  if (!outcome.accepted) {
    throw new ApiError(422, "validation_failed", outcome.errors.join("; "));
  }

  try {
    const result = transaction(() => {
      const submission = createSubmission({
        sessionId,
        teamId,
        activityId: step.id,
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

        if (effect.type === "itinerary.advance") {
          // Il marker stesso non tocca lo stato (applyEffectToState lo
          // ignora, vedi shared-types): l'avanzamento vero è un
          // team_state.patch separato, registrato anch'esso come
          // effect_event, così il rebuild dagli eventi resta corretto
          // senza dover conoscere il routing.
          const currentPosition = typeof state.position === "number" ? state.position : 1;
          const advancePatch: Effect = {
            type: "team_state.patch",
            payload: { path: "position", value: currentPosition + 1 },
          };
          createEffectEvent({
            sessionId,
            teamId,
            type: advancePatch.type,
            payloadJson: JSON.stringify(advancePatch.payload),
            sourceSubmissionId: submission.id,
          });
          state = applyEffectToState(state, advancePatch);
          continue;
        }

        state = applyEffectToState(state, effect);

        if (effect.type === "score.add") {
          createScoreEvent({
            sessionId,
            teamId,
            amount: Number(effect.payload.amount ?? 0),
            reason: String(effect.payload.reason ?? ""),
            sourceId: submission.id,
          });
        }
      }

      let voucherToken: string | undefined;
      if (step.type === "voucher") {
        const existingVoucher = findVoucherForStep(sessionId, teamId, step.id);
        if (existingVoucher) {
          voucherToken = existingVoucher.token;
        } else {
          voucherToken = newVoucherToken();
          createVoucher(sessionId, teamId, step.id, voucherToken);
        }
      }

      if (step.type === "photoApproval") {
        const attempt = countPhotoAttempts(sessionId, teamId, step.id) + 1;
        const photoBase64 = String((payload as { photoBase64: string }).photoBase64);
        const { filePath } = photoStorage.save({ sessionId, base64: photoBase64 });
        createItineraryPhoto({ sessionId, teamId, stepId: step.id, submissionId: submission.id, filePath, attempt });
      }

      const success = updateTeamStateWithVersionCheck(teamId, teamStateRow.version, stringifyState(state));
      if (!success) {
        throw new ApiError(409, "state_conflict", "team_state modificato concorrentemente, riprovare");
      }

      createAuditEvent({
        actorType: "team",
        actorId: teamId,
        sessionId,
        action: "itinerary.step_submitted",
        payloadJson: JSON.stringify({ stepId: step.id, submissionId: submission.id }),
      });

      return { submissionId: submission.id, voucherToken };
    });

    return { submissionId: result.submissionId, status: "accepted", messages: [], replay: false, voucherToken: result.voucherToken };
  } catch (e) {
    if (isUniqueConstraintError(e, "idempotency_key")) {
      const raced = findSubmissionByIdempotencyKey(idempotencyKey);
      if (raced) {
        return resolveIdempotentReplay(raced, teamId, stepId, payload);
      }
    }
    throw e;
  }
}

/**
 * Richiesta di suggerimento per la tappa corrente: non è una submission
 * (non passa da GameModule/computeSubmissionOutcome), è un'azione a sé,
 * come nell'originale getSuggerimento — penalità punti applicata solo
 * alla prima richiesta per quella tappa, tracciata in
 * team_state.hintsUsed.
 */
export function requestItineraryHint(params: {
  sessionId: string;
  teamId: string;
  phaseId: string;
}): { text: string; alreadyUsed: boolean; pointsDeducted: number } {
  const { sessionId, teamId, phaseId } = params;

  const session = getSession(sessionId);
  if (!session) throw new ApiError(404, "session_not_found", "Sessione non trovata");

  const gameVersion = getGameVersionById(session.game_version_id);
  if (!gameVersion) throw new ApiError(500, "game_version_missing", "game_version mancante");
  const definition = parseDefinition(gameVersion.definition_json);
  const phase = findPhase(definition, phaseId);
  const itinerary = requireItinerary(phase);

  return transaction(() => {
    const teamStateRow = ensureTeamState(teamId);
    const state = parseState(teamStateRow.state_json);
    const step = resolveCurrentStep(definition, phase, state);
    if (!step) throw new ApiError(409, "itinerary_completed", "Nessuna tappa attiva");
    if (!step.hint) throw new ApiError(404, "no_hint", "Nessun suggerimento disponibile per questa tappa");

    const hintsUsed = { ...((state.hintsUsed as Record<string, boolean> | undefined) ?? {}) };
    const alreadyUsed = Boolean(hintsUsed[step.id]);

    if (alreadyUsed) {
      return { text: step.hint, alreadyUsed: true, pointsDeducted: 0 };
    }

    const penalty = itinerary.hintPenalty ?? 5;
    hintsUsed[step.id] = true;
    let newState: Record<string, unknown> = { ...state, hintsUsed };
    const currentScore = typeof newState.score === "number" ? newState.score : 0;
    const deducted = Math.min(penalty, currentScore); // mai punteggio negativo, come l'originale (Math.max(0, ...))
    newState = { ...newState, score: currentScore - deducted };

    const success = updateTeamStateWithVersionCheck(teamId, teamStateRow.version, stringifyState(newState));
    if (!success) throw new ApiError(409, "state_conflict", "team_state modificato concorrentemente, riprovare");

    if (deducted > 0) {
      createScoreEvent({
        sessionId,
        teamId,
        amount: -deducted,
        reason: `itinerary:${step.id}:suggerimento`,
        sourceId: null,
      });
    }
    createAuditEvent({
      actorType: "team",
      actorId: teamId,
      sessionId,
      action: "itinerary.hint_requested",
      payloadJson: JSON.stringify({ stepId: step.id, deducted }),
    });

    return { text: step.hint, alreadyUsed: false, pointsDeducted: deducted };
  });
}

/**
 * Decisione dell'operatore su una foto in attesa: approvazione applica
 * ORA (non al momento dell'upload) punteggio + avanzamento, come
 * submission "figlia" di quella originale (sourceSubmissionId collega
 * gli effect_event alla submission della foto, per audit). Rigetto non
 * applica nulla: la squadra può ritentare (fino al limite tentativi).
 */
export function decideItineraryPhoto(params: {
  photoId: string;
  decision: "approved" | "rejected";
  note?: string;
  actorType: string;
  actorId: string;
}): { advanced: boolean } {
  return transaction(() => {
    const photo = getItineraryPhoto(params.photoId);
    if (!photo) throw new ApiError(404, "photo_not_found", "Foto non trovata");

    const applied = decidePhotoRow(params.photoId, params.decision, params.note ?? null);
    if (!applied) throw new ApiError(409, "photo_already_decided", "Questa foto è già stata valutata");

    createAuditEvent({
      actorType: params.actorType,
      actorId: params.actorId,
      sessionId: photo.session_id,
      action: params.decision === "approved" ? "itinerary.photo_approved" : "itinerary.photo_rejected",
      payloadJson: JSON.stringify({ photoId: photo.id, teamId: photo.team_id, stepId: photo.step_id }),
    });

    if (params.decision === "rejected") {
      return { advanced: false };
    }

    const session = getSession(photo.session_id);
    if (!session || !session.current_phase_id) throw new ApiError(500, "session_missing", "Sessione mancante");
    const gameVersion = getGameVersionById(session.game_version_id);
    if (!gameVersion) throw new ApiError(500, "game_version_missing", "game_version mancante");
    const definition = parseDefinition(gameVersion.definition_json);
    const phase = findPhase(definition, session.current_phase_id);
    const itinerary = requireItinerary(phase);
    const steps = (definition.content[itinerary.stepsSource] as ItineraryStepContent[] | undefined) ?? [];
    const step = steps.find((s) => s.id === photo.step_id);
    if (!step) throw new ApiError(500, "step_missing", `Tappa "${photo.step_id}" non trovata nella game definition`);

    const teamStateRow = ensureTeamState(photo.team_id);
    let state = parseState(teamStateRow.state_json);

    if (step.points > 0) {
      const scoreEffect: Effect = {
        type: "score.add",
        payload: { amount: step.points, reason: `itinerary:${step.id}:foto_approvata` },
      };
      createEffectEvent({
        sessionId: photo.session_id,
        teamId: photo.team_id,
        type: scoreEffect.type,
        payloadJson: JSON.stringify(scoreEffect.payload),
        sourceSubmissionId: photo.submission_id,
      });
      state = applyEffectToState(state, scoreEffect);
      createScoreEvent({
        sessionId: photo.session_id,
        teamId: photo.team_id,
        amount: step.points,
        reason: `itinerary:${step.id}:foto_approvata`,
        sourceId: photo.submission_id,
      });
    }

    const currentPosition = typeof state.position === "number" ? state.position : 1;
    const advancePatch: Effect = { type: "team_state.patch", payload: { path: "position", value: currentPosition + 1 } };
    createEffectEvent({
      sessionId: photo.session_id,
      teamId: photo.team_id,
      type: advancePatch.type,
      payloadJson: JSON.stringify(advancePatch.payload),
      sourceSubmissionId: photo.submission_id,
    });
    state = applyEffectToState(state, advancePatch);

    const success = updateTeamStateWithVersionCheck(photo.team_id, teamStateRow.version, stringifyState(state));
    if (!success) throw new ApiError(409, "state_conflict", "team_state modificato concorrentemente, riprovare");

    return { advanced: true };
  });
}


/**
 * Genera e assegna il percorso di ciascuna squadra della sessione per
 * questa fase itinerary (spec: generaPercorsi dell'originale Apps
 * Script — vincolaGuide/spaziGuide/rotazione a blocchi in coppia, ora
 * portati in packages/game-core/src/itineraryRouting.ts). Va chiamata
 * dalla regia PRIMA di aprire la fase alle squadre: scrive il percorso
 * in base_state_json (setBaseState), così sopravvive a "Reset Sessione"
 * (strumento DEV — la route è dato di setup, non stato di gioco) e resta
 * la fonte da cui resolveCurrentStep legge la sequenza.
 */
export function generateAndAssignRoutes(
  sessionId: string,
  phaseId: string
): { teamId: string; stepsCount: number }[] {
  const session = getSession(sessionId);
  if (!session) throw new ApiError(404, "session_not_found", "Sessione non trovata");

  const gameVersion = getGameVersionById(session.game_version_id);
  if (!gameVersion) throw new ApiError(500, "game_version_missing", "game_version mancante");
  const definition = parseDefinition(gameVersion.definition_json);
  const phase = findPhase(definition, phaseId);
  const itinerary = requireItinerary(phase);

  const steps = (definition.content[itinerary.stepsSource] as ItineraryStepContent[] | undefined) ?? [];
  if (steps.length === 0) {
    throw new ApiError(500, "steps_missing", `content["${itinerary.stepsSource}"] è vuoto o mancante`);
  }

  const teams = listTeams(sessionId);
  if (teams.length === 0) {
    throw new ApiError(409, "no_teams", "Nessuna squadra in questa sessione: crea le squadre prima di generare i percorsi");
  }

  const routingTeams = teams.map((t, index) => ({ id: t.id, index }));
  const results = generateItineraryRoutes(steps, routingTeams, {
    minGuideDistance: itinerary.routing?.minGuideDistance,
  });

  for (const result of results) {
    ensureTeamState(result.teamId);
    // Solo la route va in base_state: posizione/punteggio/hint partono
    // dai default impliciti (resolveCurrentStep/addScore/hintsUsed) e
    // vivono solo nello stato mutabile, avanzato via effect_event.
    setBaseState(result.teamId, JSON.stringify({ route: result.sequence }));
  }

  createAuditEvent({
    actorType: "control",
    actorId: "regia",
    sessionId,
    action: "itinerary.routes_generated",
    payloadJson: JSON.stringify({ phaseId, teamCount: results.length }),
  });

  return results.map((r) => ({ teamId: r.teamId, stepsCount: r.sequence.length }));
}
