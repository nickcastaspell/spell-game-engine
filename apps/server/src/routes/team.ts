import { Router } from "express";
import { z } from "zod";
import { moduleRegistry } from "../modules-registry";
import { ApiError, asyncRoute, sendOk } from "../lib/response";
import { newDeviceToken, hashToken } from "../lib/tokens";
import { teamAuth } from "../middleware/teamAuth";
import { findPhase, parseDefinition, requireActivity } from "../lib/gameDefinition";
import { parseState } from "../lib/teamState";
import { submitTeamActivity } from "../lib/submissionPipeline";
import { getItineraryStatus, requestItineraryHint, submitItineraryStep } from "../lib/itineraryPipeline";
import {
  createDeviceSession,
  ensureTeamState,
  findActiveSubmission,
  getGameVersionById,
  getSession,
  getTeamByAccessCode,
  getTeamState,
  listAcceptedSubmissionsForTeam,
  revokeActiveDeviceSessions,
  updateTeamStatus,
} from "../lib/repo";

export const teamRouter = Router();

// POST /api/team/login — scambia il codice tavolo con un token di sessione.
// Un codice tavolo non dà accesso alla dashboard regia (criterio §16):
// da qui in poi si usa solo il token, mai più il codice.
teamRouter.post(
  "/login",
  asyncRoute(async (req, res) => {
    const schema = z.object({ accessCode: z.string() });
    const { accessCode } = schema.parse(req.body);

    const team = getTeamByAccessCode(accessCode.toUpperCase());
    if (!team) throw new ApiError(404, "invalid_code", "Codice tavolo non valido");

    // Un solo dispositivo per tavolo (spec §6.3): il nuovo login fa takeover,
    // revocando i device_session precedenti — regola esplicita richiesta dal criterio §16.
    revokeActiveDeviceSessions(team.id);

    const token = newDeviceToken();
    createDeviceSession(team.id, hashToken(token));
    updateTeamStatus(team.id, "CONNECTED");

    sendOk(res, { token, teamId: team.id, teamName: team.name });
  })
);

teamRouter.use(teamAuth);

// GET /api/team/state — fase, attività e stato correnti
teamRouter.get(
  "/state",
  asyncRoute(async (req, res) => {
    const sessionId = req.sessionId!;
    const teamId = req.teamId!;

    const session = getSession(sessionId);
    if (!session) throw new ApiError(404, "session_not_found", "Sessione non trovata");

    const gameVersion = getGameVersionById(session.game_version_id);
    if (!gameVersion) throw new ApiError(500, "game_version_missing", "game_version mancante");
    const definition = parseDefinition(gameVersion.definition_json);

    const teamStateRow = ensureTeamState(teamId) ?? getTeamState(teamId);
    const state = teamStateRow ? parseState(teamStateRow.state_json) : {};

    let activityView: Record<string, unknown> | null = null;
    let activityId: string | null = null;
    let submitted = false;
    // Le fasi "itinerary" (Il mistero della città) non passano da qui: ogni
    // squadra ha una propria tappa corrente, gestita dalle rotte dedicate
    // (routes/itinerary.ts), non dal ciclo apri-fase/invia/chiudi-fase di
    // Less is More. GET /api/team/state resta com'era per single_submission.
    if (session.current_phase_id) {
      const phase = findPhase(definition, session.current_phase_id);
      if (phase.mode !== "itinerary") {
        const activity = requireActivity(phase);
        const mod = moduleRegistry.get(activity.type);
        activityView = mod.playerView({
          sessionId,
          teamId,
          phaseId: phase.id,
          activityId: activity.id,
          activityConfig: activity.config,
          content: definition.content,
          teamState: state,
        });
        activityId = activity.id;
        submitted = Boolean(findActiveSubmission(sessionId, teamId, activity.id));
      }
    }

    sendOk(res, {
      sessionStatus: session.status,
      phaseStatus: session.phase_status,
      currentPhaseId: session.current_phase_id,
      activityId,
      activity: activityView,
      submitted,
      score: typeof state.score === "number" ? state.score : 0,
    });
  })
);

// POST /api/team/submissions — invia una decisione
teamRouter.post(
  "/submissions",
  asyncRoute(async (req, res) => {
    const schema = z.object({
      activityId: z.string(),
      payload: z.record(z.unknown()),
      idempotencyKey: z.string().min(8),
    });
    const body = schema.parse(req.body);

    const result = await submitTeamActivity({
      sessionId: req.sessionId!,
      teamId: req.teamId!,
      activityId: body.activityId,
      payload: body.payload,
      idempotencyKey: body.idempotencyKey,
    });

    sendOk(res, result, result.replay ? 200 : 201);
  })
);

// GET /api/team/itinerary/status — tappa corrente della squadra (fasi itinerary)
teamRouter.get(
  "/itinerary/status",
  asyncRoute(async (req, res) => {
    const sessionId = req.sessionId!;
    const session = getSession(sessionId);
    if (!session) throw new ApiError(404, "session_not_found", "Sessione non trovata");
    if (!session.current_phase_id) {
      throw new ApiError(409, "no_current_phase", "Nessuna fase corrente");
    }
    const status = getItineraryStatus(sessionId, req.teamId!, session.current_phase_id);
    sendOk(res, status);
  })
);

// POST /api/team/itinerary/submit — invia il tentativo per la tappa corrente
teamRouter.post(
  "/itinerary/submit",
  asyncRoute(async (req, res) => {
    const schema = z.object({
      stepId: z.string(),
      payload: z.record(z.unknown()),
      idempotencyKey: z.string().min(8),
    });
    const body = schema.parse(req.body);

    const sessionId = req.sessionId!;
    const session = getSession(sessionId);
    if (!session) throw new ApiError(404, "session_not_found", "Sessione non trovata");
    if (!session.current_phase_id) {
      throw new ApiError(409, "no_current_phase", "Nessuna fase corrente");
    }

    const result = await submitItineraryStep({
      sessionId,
      teamId: req.teamId!,
      phaseId: session.current_phase_id,
      stepId: body.stepId,
      payload: body.payload,
      idempotencyKey: body.idempotencyKey,
    });

    sendOk(res, result, result.replay ? 200 : 201);
  })
);

// POST /api/team/itinerary/hint — richiede il suggerimento della tappa corrente
teamRouter.post(
  "/itinerary/hint",
  asyncRoute(async (req, res) => {
    const sessionId = req.sessionId!;
    const session = getSession(sessionId);
    if (!session) throw new ApiError(404, "session_not_found", "Sessione non trovata");
    if (!session.current_phase_id) {
      throw new ApiError(409, "no_current_phase", "Nessuna fase corrente");
    }
    const result = requestItineraryHint({
      sessionId,
      teamId: req.teamId!,
      phaseId: session.current_phase_id,
    });
    sendOk(res, result);
  })
);

// GET /api/team/result — conferma e feedback disponibili
teamRouter.get(
  "/result",
  asyncRoute(async (req, res) => {
    const sessionId = req.sessionId!;
    const teamId = req.teamId!;
    const submissions = listAcceptedSubmissionsForTeam(sessionId, teamId);
    sendOk(
      res,
      submissions.map((s) => ({
        activityId: s.activity_id,
        submittedAt: s.submitted_at,
      }))
    );
  })
);
