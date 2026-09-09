import { Router } from "express";
import { z } from "zod";
import { assertTransition, InvalidTransitionError } from "@spell/game-core";
import { SessionStatus } from "@spell/shared-types";
import { ApiError, asyncRoute, sendOk } from "../lib/response";
import fs from "node:fs";
import { newAccessCode } from "../lib/tokens";
import { controlAuth } from "../middleware/controlAuth";
import { photoStorage } from "../lib/uploads";
import { getItineraryPhoto } from "../lib/repo";
import { findPhase, parseDefinition, requireActivity } from "../lib/gameDefinition";
import { validateGameDefinition, validateGameDefinitionSemantics } from "../lib/gameDefinitionValidation";
import { moduleRegistry } from "../modules-registry";
import { parseState } from "../lib/teamState";
import { reopenTeamSubmission } from "../lib/submissionPipeline";
import { decideItineraryPhoto, generateAndAssignRoutes } from "../lib/itineraryPipeline";
import { newFacilitatorToken } from "../lib/tokens";
import {
  countTeams,
  createAuditEvent,
  createFacilitator,
  createSession,
  createTeam,
  ensureTeamState,
  getGameBySlug,
  getGameVersionById,
  getGameVersionByVersion,
  getLatestGameVersion,
  getSession,
  getTeam,
  listAcceptedSubmissions,
  listActiveDeviceSessionsForTeams,
  listFacilitators,
  listPendingPhotos,
  listSubmissionsForTeam,
  listTeamStates,
  listTeams,
  updateSessionPhase,
  updateSessionStatus,
  type SessionRow,
} from "../lib/repo";

export const controlRouter = Router();
controlRouter.use(controlAuth);

// Vista camelCase coerente col resto dell'API (spec §12): non esponiamo
// le colonne snake_case del DB nelle risposte HTTP.
// Esportata: riusata anche da routes/dev.ts, per non duplicare il mapping.
export function toSessionView(session: SessionRow) {
  return {
    id: session.id,
    gameVersionId: session.game_version_id,
    name: session.name,
    status: session.status,
    currentPhaseId: session.current_phase_id,
    currentRound: session.current_round,
    phaseStatus: session.phase_status,
    createdAt: session.created_at,
    updatedAt: session.updated_at,
  };
}

// POST /api/control/sessions — crea una sessione (spec §12, §19.2)
controlRouter.post(
  "/sessions",
  asyncRoute(async (req, res) => {
    const schema = z.object({ gameSlug: z.string(), version: z.string().optional(), name: z.string() });
    const body = schema.parse(req.body);

    const game = getGameBySlug(body.gameSlug);
    if (!game) throw new ApiError(404, "game_not_found", `Gioco non trovato: ${body.gameSlug}`);

    const gameVersion = body.version
      ? getGameVersionByVersion(game.id, body.version)
      : getLatestGameVersion(game.id);
    if (!gameVersion) throw new ApiError(404, "game_version_not_found", "Nessuna versione pubblicata");

    // Difesa in profondità: la game_version è validata al momento della
    // pubblicazione (seed.ts), ma verifichiamo di nuovo qui nel caso sia
    // arrivata nel DB per un'altra via — non è un'operazione hot-path
    // (una volta per sessione creata, non per richiesta).
    let definition;
    try {
      definition = validateGameDefinition(JSON.parse(gameVersion.definition_json));
      validateGameDefinitionSemantics(definition, moduleRegistry);
    } catch {
      throw new ApiError(500, "invalid_game_version", "La game_version salvata non è valida");
    }

    const session = createSession(gameVersion.id, body.name);

    createAuditEvent({
      actorType: "control",
      actorId: "regia",
      sessionId: session.id,
      action: "session.created",
      payloadJson: JSON.stringify({ gameSlug: body.gameSlug }),
    });

    sendOk(res, toSessionView(session), 201);
  })
);

// POST /api/control/sessions/:id/teams — genera i tavoli
controlRouter.post(
  "/sessions/:id/teams",
  asyncRoute(async (req, res) => {
    const schema = z.object({ count: z.number().int().min(1).max(50) });
    const { count } = schema.parse(req.body);
    const sessionId = req.params.id;

    const session = getSession(sessionId);
    if (!session) throw new ApiError(404, "session_not_found", "Sessione non trovata");

    // teamsMax è una regola del GIOCO (dichiarata nella sua game
    // definition), non un limite tecnico della piattaforma: prima veniva
    // ignorata e si potevano generare fino a 50 tavoli anche per un gioco
    // che ne dichiara 20 al massimo. z.number().max(50) sopra resta come
    // guardia di sanità assoluta; questo è il vincolo vero.
    const gameVersion = getGameVersionById(session.game_version_id);
    if (!gameVersion) throw new ApiError(500, "game_version_missing", "game_version mancante");
    const definition = parseDefinition(gameVersion.definition_json);

    const existing = countTeams(sessionId);
    if (existing + count > definition.settings.teamsMax) {
      throw new ApiError(
        409,
        "teams_max_exceeded",
        `Il gioco "${definition.game.name}" consente al massimo ${definition.settings.teamsMax} tavoli ` +
          `(già presenti: ${existing}, richiesti: ${count}).`
      );
    }

    const teams = [];
    for (let i = 0; i < count; i++) {
      const idx = existing + i + 1;
      const team = createTeam(sessionId, `Tavolo ${idx}`, newAccessCode());
      ensureTeamState(team.id);
      // Vista camelCase, coerente con la dashboard (spec §12: formato
      // uniforme delle risposte — non esponiamo le colonne snake_case del DB).
      teams.push({
        id: team.id,
        sessionId: team.session_id,
        name: team.name,
        accessCode: team.access_code,
        status: team.status,
      });
    }

    sendOk(res, teams, 201);
  })
);

// POST /api/control/sessions/:id/status — cambia stato sessione
controlRouter.post(
  "/sessions/:id/status",
  asyncRoute(async (req, res) => {
    const schema = z.object({ status: z.enum(["DRAFT", "LOBBY", "RUNNING", "PAUSED", "COMPLETED", "ARCHIVED"]) });
    const { status } = schema.parse(req.body);
    const sessionId = req.params.id;

    const session = getSession(sessionId);
    if (!session) throw new ApiError(404, "session_not_found", "Sessione non trovata");

    try {
      assertTransition(session.status as SessionStatus, status as SessionStatus);
    } catch (e) {
      if (e instanceof InvalidTransitionError) {
        throw new ApiError(409, "invalid_transition", e.message);
      }
      throw e;
    }

    // teamsMin: la regia non dovrebbe poter avviare la sessione (farla
    // entrare in LOBBY o partire in RUNNING) sotto la soglia minima di
    // tavoli dichiarata dal gioco — prima non era verificato affatto.
    if (status === "LOBBY" || status === "RUNNING") {
      const gameVersion = getGameVersionById(session.game_version_id);
      if (gameVersion) {
        const definition = parseDefinition(gameVersion.definition_json);
        const teamCount = countTeams(sessionId);
        if (teamCount < definition.settings.teamsMin) {
          throw new ApiError(
            409,
            "teams_min_not_reached",
            `Il gioco "${definition.game.name}" richiede almeno ${definition.settings.teamsMin} tavoli ` +
              `(presenti: ${teamCount}) prima di passare a ${status}.`
          );
        }
      }
    }

    const updated = updateSessionStatus(sessionId, status);
    createAuditEvent({
      actorType: "control",
      actorId: "regia",
      sessionId,
      action: "session.status_changed",
      payloadJson: JSON.stringify({ from: session.status, to: status }),
    });

    sendOk(res, toSessionView(updated));
  })
);

// POST /api/control/sessions/:id/phase — apre/chiude/riapre una fase
controlRouter.post(
  "/sessions/:id/phase",
  asyncRoute(async (req, res) => {
    const schema = z.object({
      action: z.enum(["open", "close", "reopen_team"]),
      phaseId: z.string(),
      teamId: z.string().optional(),
    });
    const body = schema.parse(req.body);
    const sessionId = req.params.id;

    const session = getSession(sessionId);
    if (!session) throw new ApiError(404, "session_not_found", "Sessione non trovata");
    if (session.status !== "RUNNING") {
      throw new ApiError(409, "session_not_running", "La sessione deve essere RUNNING");
    }

    const gameVersion = getGameVersionById(session.game_version_id);
    if (!gameVersion) throw new ApiError(500, "game_version_missing", "game_version mancante");
    const definition = parseDefinition(gameVersion.definition_json);
    findPhase(definition, body.phaseId); // valida che la fase esista

    if (body.action === "open") {
      const updated = updateSessionPhase(sessionId, body.phaseId, "OPEN");
      sendOk(res, toSessionView(updated));
      return;
    }

    if (body.action === "close") {
      const updated = updateSessionPhase(sessionId, session.current_phase_id, "CLOSED");
      sendOk(res, toSessionView(updated));
      return;
    }

    if (body.action === "reopen_team") {
      if (!body.teamId) throw new ApiError(400, "team_id_required", "teamId richiesto per reopen_team");
      const phase = findPhase(definition, body.phaseId);
      const count = await reopenTeamSubmission(sessionId, body.teamId, requireActivity(phase).id);
      sendOk(res, { reopened: count });
      return;
    }
  })
);

// GET /api/control/sessions/:id/dashboard — stato aggregato
controlRouter.get(
  "/sessions/:id/dashboard",
  asyncRoute(async (req, res) => {
    const sessionId = req.params.id;
    const session = getSession(sessionId);
    if (!session) throw new ApiError(404, "session_not_found", "Sessione non trovata");

    const gameVersion = getGameVersionById(session.game_version_id);
    const definition = gameVersion ? parseDefinition(gameVersion.definition_json) : null;
    // Le fasi "itinerary" (Il mistero della città) non hanno una singola
    // activity sincronizzata: ogni squadra ha la propria tappa corrente, non
    // c'è un unico activityId per cui contare "chi ha inviato" a livello di
    // sessione. Per queste fasi la dashboard sintetica sotto (submittedCount
    // ecc.) resta a zero/vuota — le statistiche itinerary-specifiche sono
    // esposte da endpoint dedicati (vedi routes/itinerary.ts).
    const currentPhase =
      definition && session.current_phase_id ? findPhase(definition, session.current_phase_id) : null;
    const activityId = currentPhase && currentPhase.mode !== "itinerary" ? requireActivity(currentPhase).id : null;

    const teams = listTeams(sessionId);
    const teamStates = listTeamStates(teams.map((t) => t.id));
    const stateByTeam = new Map(teamStates.map((s) => [s.team_id, s]));

    const submissions = activityId ? listAcceptedSubmissions(sessionId, activityId) : [];
    const submittedTeamIds = new Set(submissions.map((s) => s.team_id));

    const devices = listActiveDeviceSessionsForTeams(teams.map((t) => t.id));
    const connectedTeamIds = new Set(devices.map((d) => d.team_id));

    const teamsView = teams.map((t) => {
      const state = stateByTeam.get(t.id);
      const parsed = state ? parseState(state.state_json) : {};
      return {
        teamId: t.id,
        name: t.name,
        accessCode: t.access_code,
        connected: connectedTeamIds.has(t.id),
        submitted: submittedTeamIds.has(t.id),
        score: typeof parsed.score === "number" ? parsed.score : 0,
        stateVersion: state?.version ?? 0,
      };
    });

    // Elenco fasi del gioco (v5.1): la regia non deve più avere l'id della
    // fase scritto a mano nell'HTML — lo legge da qui.
    const phases = definition ? definition.phases.map((p) => ({ id: p.id, title: p.title, mode: p.mode })) : [];

    sendOk(res, {
      sessionId: session.id,
      status: session.status,
      currentPhaseId: session.current_phase_id,
      phaseStatus: session.phase_status,
      currentRound: session.current_round,
      phases,
      teams: teamsView,
      submittedCount: submittedTeamIds.size,
      totalTeams: teams.length,
      allSubmitted: teams.length > 0 && submittedTeamIds.size === teams.length,
    });
  })
);

// POST /api/control/sessions/:id/itinerary/generate-routes — genera e assegna
// il percorso di ciascuna squadra per una fase itinerary (spec: generaPercorsi
// dell'originale). Va chiamata prima di aprire la fase (action "open" su
// /phase) — non fa nulla di automatico all'apertura perché la regia potrebbe
// voler rigenerare i percorsi (es. dopo aver aggiunto/tolto una squadra)
// prima di aprirla davvero.
controlRouter.post(
  "/sessions/:id/itinerary/generate-routes",
  asyncRoute(async (req, res) => {
    const schema = z.object({ phaseId: z.string() });
    const { phaseId } = schema.parse(req.body);
    const sessionId = req.params.id;

    const results = generateAndAssignRoutes(sessionId, phaseId);
    sendOk(res, { teams: results });
  })
);

// POST /api/control/sessions/:id/facilitators — crea un facilitatore con
// token dedicato, scoped su un sottoinsieme di squadre (vuoto = tutte).
controlRouter.post(
  "/sessions/:id/facilitators",
  asyncRoute(async (req, res) => {
    const schema = z.object({ name: z.string().min(1), teamIds: z.array(z.string()).default([]) });
    const body = schema.parse(req.body);
    const sessionId = req.params.id;

    const session = getSession(sessionId);
    if (!session) throw new ApiError(404, "session_not_found", "Sessione non trovata");

    for (const teamId of body.teamIds) {
      const team = getTeam(teamId);
      if (!team || team.session_id !== sessionId) {
        throw new ApiError(400, "invalid_team_id", `Squadra "${teamId}" non trovata in questa sessione`);
      }
    }

    const token = newFacilitatorToken();
    const facilitator = createFacilitator(sessionId, body.name, token, body.teamIds);

    createAuditEvent({
      actorType: "control",
      actorId: "regia",
      sessionId,
      action: "facilitator.created",
      payloadJson: JSON.stringify({ facilitatorId: facilitator.id, name: body.name }),
    });

    sendOk(
      res,
      { id: facilitator.id, name: facilitator.name, token: facilitator.token, teamIds: body.teamIds },
      201
    );
  })
);

// GET /api/control/sessions/:id/facilitators — elenco facilitatori della sessione
controlRouter.get(
  "/sessions/:id/facilitators",
  asyncRoute(async (req, res) => {
    const facilitators = listFacilitators(req.params.id);
    sendOk(
      res,
      facilitators.map((f) => ({
        id: f.id,
        name: f.name,
        token: f.token,
        teamIds: JSON.parse(f.team_ids_json) as string[],
      }))
    );
  })
);

// GET /api/control/sessions/:id/itinerary/photos/pending — pannello foto
// lato regia: come /api/facilitator/photos/pending ma senza scoping per
// squadra (la regia vede tutto, come requireAdmin nell'originale accanto
// a requireOperatore). Comoda per sessioni di test o quando non sono
// ancora stati creati facilitatori dedicati.
controlRouter.get(
  "/sessions/:id/itinerary/photos/pending",
  asyncRoute(async (req, res) => {
    const sessionId = req.params.id;
    const photos = listPendingPhotos(sessionId);
    sendOk(
      res,
      photos.map((p) => {
        const team = getTeam(p.team_id);
        return {
          id: p.id,
          teamId: p.team_id,
          teamName: team?.name ?? p.team_id,
          stepId: p.step_id,
          attempt: p.attempt,
          createdAt: p.created_at,
        };
      })
    );
  })
);

// GET /api/control/sessions/:id/itinerary/photos/:photoId/image — anteprima foto per la regia.
controlRouter.get(
  "/sessions/:id/itinerary/photos/:photoId/image",
  asyncRoute(async (req, res) => {
    const photo = getItineraryPhoto(req.params.photoId);
    if (!photo || photo.session_id !== req.params.id) {
      throw new ApiError(404, "photo_not_found", "Foto non trovata");
    }
    const absolutePath = photoStorage.absolutePath(photo.file_path);
    if (!fs.existsSync(absolutePath)) {
      throw new ApiError(404, "photo_file_missing", "File della foto non trovato su disco");
    }
    res.sendFile(absolutePath);
  })
);

// POST /api/control/sessions/:id/itinerary/photos/:photoId/decide — approva/rigetta dalla regia.
controlRouter.post(
  "/sessions/:id/itinerary/photos/:photoId/decide",
  asyncRoute(async (req, res) => {
    const schema = z.object({ decision: z.enum(["approved", "rejected"]), note: z.string().optional() });
    const body = schema.parse(req.body);
    const result = decideItineraryPhoto({
      photoId: req.params.photoId,
      decision: body.decision,
      note: body.note,
      actorType: "control",
      actorId: "regia",
    });
    sendOk(res, result);
  })
);

// GET /api/control/sessions/:id/submissions/:teamId — dettaglio submission di un tavolo
controlRouter.get(
  "/sessions/:id/submissions/:teamId",
  asyncRoute(async (req, res) => {
    const { id: sessionId, teamId } = req.params;
    const submissions = listSubmissionsForTeam(sessionId, teamId);
    sendOk(
      res,
      submissions.map((s) => ({ ...s, payload: JSON.parse(s.payload_json) }))
    );
  })
);
