import { Router } from "express";
import fs from "node:fs";
import { z } from "zod";
import { ApiError, asyncRoute, sendOk } from "../lib/response";
import { facilitatorAuth, facilitatorCanAccessTeam, requireFacilitatorAccess } from "../middleware/facilitatorAuth";
import { decideItineraryPhoto } from "../lib/itineraryPipeline";
import { getItineraryPhoto, getTeam, listPendingPhotos } from "../lib/repo";
import { photoStorage } from "../lib/uploads";

// Rotte del ruolo facilitatore (Il mistero della città): mirror
// dell'originale requireOperatore — accesso scoped alle sole squadre
// assegnate (team_ids_json), non alla sessione intera. Non passa da
// controlAuth (token regia): un facilitatore ha il proprio token, mai
// il token regia (spec: "login separati per ruolo").
export const facilitatorRouter = Router();
facilitatorRouter.use(facilitatorAuth);

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
