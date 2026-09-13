import { Router } from "express";
import fs from "node:fs";
import { z } from "zod";
import { ApiError, asyncRoute, sendOk } from "../lib/response";
import { facilitatorAuth, facilitatorCanAccessTeam, requireFacilitatorAccess } from "../middleware/facilitatorAuth";
import { decideItineraryPhoto, getFacilitatorTeamRoutes, getItineraryOverview } from "../lib/itineraryPipeline";
import { parseDefinition } from "../lib/gameDefinition";
import { parseState } from "../lib/teamState";
import {
  getGameVersionById,
  getItineraryPhoto,
  getSession,
  getTeam,
  listPendingPhotos,
  listPhotosForSession,
  listTeams,
  listTeamStates,
} from "../lib/repo";
import { photoStorage } from "../lib/uploads";

/** Fase "itinerary" della sessione — un facilitatore non ne sceglie una, a differenza della regia (che può avere più fasi/giochi). */
function resolveItineraryPhaseId(sessionId: string): string {
  const session = getSession(sessionId);
  if (!session) throw new ApiError(404, "session_not_found", "Sessione non trovata");
  const gameVersion = getGameVersionById(session.game_version_id);
  if (!gameVersion) throw new ApiError(500, "game_version_missing", "game_version mancante");
  const definition = parseDefinition(gameVersion.definition_json);
  const phase = definition.phases.find((p) => p.mode === "itinerary");
  if (!phase) throw new ApiError(400, "no_itinerary_phase", "Questa sessione non ha una fase itinerary");
  return phase.id;
}

// Rotte del ruolo facilitatore (Il mistero della città): mirror
// dell'originale requireOperatore — accesso scoped alle sole squadre
// assegnate (team_ids_json), non alla sessione intera. Non passa da
// controlAuth (token regia): un facilitatore ha il proprio token, mai
// il token regia (spec: "login separati per ruolo").
export const facilitatorRouter = Router();
facilitatorRouter.use(facilitatorAuth);

// GET /api/facilitator/me — identità del facilitatore autenticato (nome,
// per verificare a colpo d'occhio che il token sia il proprio) e stato
// della sessione a cui appartiene, per mostrare un banner "sala d'attesa"/
// "in pausa"/"conclusa" — stesso sessionStatus già esposto lato squadra
// da GET /api/team/state, qui replicato per il facilitatore.
facilitatorRouter.get(
  "/me",
  asyncRoute(async (req, res) => {
    const session = getSession(req.facilitatorSessionId!);
    if (!session) throw new ApiError(404, "session_not_found", "Sessione non trovata");
    sendOk(res, {
      name: req.facilitatorName,
      sessionId: session.id,
      sessionName: session.name,
      sessionStatus: session.status,
    });
  })
);

// GET /api/facilitator/overview — dove sono ADESSO le squadre assegnate a
// questo facilitatore (posizione, punteggio, tappa corrente con
// coordinate), stesso principio della mappa overview della regia ma
// scoped al proprio elenco squadre. La fase itinerary è risolta da sola
// (primo phases[] con mode "itinerary"): il facilitatore non seleziona
// nulla, a differenza della regia che può avere più fasi/giochi diversi.
facilitatorRouter.get(
  "/overview",
  asyncRoute(async (req, res) => {
    const phaseId = resolveItineraryPhaseId(req.facilitatorSessionId!);
    const scoped = req.facilitatorTeamIds ?? [];
    const overview = getItineraryOverview(req.facilitatorSessionId!, phaseId).filter(
      (entry) => scoped.length === 0 || scoped.includes(entry.teamId)
    );
    sendOk(res, overview);
  })
);

// GET /api/facilitator/routes — percorso COMPLETO (tutte le tappe, con
// stato fatta/corrente/futura ed esito registrato per quelle già
// affrontate) delle squadre assegnate — a differenza di /overview (solo
// la tappa corrente, pensata per non spoilerare tra squadre), qui non
// c'è nulla da nascondere: il facilitatore non gioca. Alimenta la Tab
// Mappa (percorso disegnato per intero, con linee) e il pannello di
// dettaglio per squadra.
facilitatorRouter.get(
  "/routes",
  asyncRoute(async (req, res) => {
    const phaseId = resolveItineraryPhaseId(req.facilitatorSessionId!);
    const scoped = req.facilitatorTeamIds ?? [];
    const teams = listTeams(req.facilitatorSessionId!);
    const teamIds = teams.map((t) => t.id).filter((id) => scoped.length === 0 || scoped.includes(id));
    sendOk(res, getFacilitatorTeamRoutes(req.facilitatorSessionId!, phaseId, teamIds));
  })
);

// GET /api/facilitator/leaderboard — classifica dell'INTERA sessione, non
// scoped alle squadre assegnate: una classifica ha senso solo se
// confronta tutte le squadre, richiesto esplicitamente "con tutte le
// squadre" — a differenza di /overview e /routes, qui lo scoping per
// squadra non si applica affatto.
facilitatorRouter.get(
  "/leaderboard",
  asyncRoute(async (req, res) => {
    const teams = listTeams(req.facilitatorSessionId!);
    const states = listTeamStates(teams.map((t) => t.id));
    const stateByTeam = new Map(states.map((s) => [s.team_id, s]));
    const leaderboard = teams
      .map((t) => {
        const state = stateByTeam.get(t.id);
        const parsed = state ? parseState(state.state_json) : {};
        return { teamId: t.id, teamName: t.name, score: typeof parsed.score === "number" ? parsed.score : 0 };
      })
      .sort((a, b) => b.score - a.score);
    sendOk(res, leaderboard);
  })
);

// GET /api/facilitator/photos?status=... — galleria (tutte le foto, non
// solo quelle in attesa), scoped alle squadre assegnate — stesso
// endpoint della regia, con lo scoping aggiunto.
facilitatorRouter.get(
  "/photos",
  asyncRoute(async (req, res) => {
    const schema = z.object({ status: z.enum(["pending", "approved", "rejected"]).optional() });
    const { status } = schema.parse(req.query);
    const scoped = req.facilitatorTeamIds ?? [];
    const photos = listPhotosForSession(req.facilitatorSessionId!, status, scoped.length > 0 ? scoped : undefined);
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
          status: p.status,
          createdAt: p.created_at,
        };
      })
    );
  })
);

// GET /api/facilitator/photos/pending — foto in attesa di valutazione,
// filtrate sulle squadre di questo facilitatore (vuoto = tutte quelle
// della sessione).
facilitatorRouter.get(
  "/photos/pending",
  asyncRoute(async (req, res) => {
    const scoped = req.facilitatorTeamIds ?? [];
    const photos = listPendingPhotos(req.facilitatorSessionId!, scoped.length > 0 ? scoped : undefined);
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

// GET /api/facilitator/photos/:id/image — file della foto (solo se il
// facilitatore è autorizzato sulla squadra di quella foto).
facilitatorRouter.get(
  "/photos/:id/image",
  asyncRoute(async (req, res) => {
    const photo = getItineraryPhoto(req.params.id);
    if (!photo || photo.session_id !== req.facilitatorSessionId) {
      throw new ApiError(404, "photo_not_found", "Foto non trovata");
    }
    if (!facilitatorCanAccessTeam(req, photo.team_id)) {
      throw new ApiError(403, "forbidden", "Questo facilitatore non è autorizzato su questa squadra");
    }
    const absolutePath = photoStorage.absolutePath(photo.file_path);
    if (!fs.existsSync(absolutePath)) {
      throw new ApiError(404, "photo_file_missing", "File della foto non trovato su disco");
    }
    res.sendFile(absolutePath);
  })
);

// POST /api/facilitator/photos/:id/decide — approva o rigetta una foto in attesa.
facilitatorRouter.post(
  "/photos/:id/decide",
  asyncRoute(async (req, res) => {
    const schema = z.object({ decision: z.enum(["approved", "rejected"]), note: z.string().optional() });
    const body = schema.parse(req.body);

    const photo = getItineraryPhoto(req.params.id);
    if (!photo || photo.session_id !== req.facilitatorSessionId) {
      throw new ApiError(404, "photo_not_found", "Foto non trovata");
    }
    requireFacilitatorAccess(req, photo.team_id);

    const result = decideItineraryPhoto({
      photoId: req.params.id,
      decision: body.decision,
      note: body.note,
      actorType: "facilitator",
      actorId: req.facilitatorId!,
    });

    sendOk(res, result);
  })
);
