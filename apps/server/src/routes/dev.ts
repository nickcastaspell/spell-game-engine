import { Router } from "express";
import { z } from "zod";
import { ApiError, asyncRoute, sendOk } from "../lib/response";
import { controlAuth } from "../middleware/controlAuth";
import { toSessionView } from "./control";
import {
  createAuditEvent,
  deleteSessionCascade,
  duplicateSession,
  getSession,
  listAllSessionsWithMeta,
  reopenCompletedSessionDev,
  resetSessionData,
} from "../lib/repo";

// Strumenti SOLO per l'ambiente di sviluppo: reset rapido, archivio
// sessioni, duplica, elimina, riapri. NON fanno parte del game engine —
// non toccano la submission pipeline, l'event sourcing come fonte di
// verità durante il gioco, o il lifecycle ufficiale (packages/game-core/
// src/lifecycle.ts): si limitano a creare o eliminare dati (vedi repo.ts,
// sezione "strumenti DEV"). Questo router viene montato in app.ts SOLO se
// isDevEnvironment() è vero: in produzione /api/dev/* non esiste affatto
// (404 generico), non è solo nascosto nella UI.
export const devRouter = Router();
devRouter.use(controlAuth);

// GET /api/dev/sessions — archivio: tutte le sessioni con stato, data, tavoli.
devRouter.get(
  "/sessions",
  asyncRoute(async (_req, res) => {
    const rows = listAllSessionsWithMeta();
    sendOk(
      res,
      rows.map((r) => ({
        ...toSessionView(r),
        gameName: r.game_name,
        gameSlug: r.game_slug,
        teamCount: r.team_count,
      }))
    );
  })
);

// POST /api/dev/sessions/:id/reset — "🔄 Reset Sessione".
devRouter.post(
  "/sessions/:id/reset",
  asyncRoute(async (req, res) => {
    const sessionId = req.params.id;
    const session = getSession(sessionId);
    if (!session) throw new ApiError(404, "session_not_found", "Sessione non trovata");

    resetSessionData(sessionId);
    // L'audit precedente è stato appena azzerato dal reset: questo evento
    // è il primo della sessione "nuova" e serve solo a tracciare che un
    // reset dev è avvenuto (utile se si guarda l'audit in un secondo momento).
    createAuditEvent({
      actorType: "control",
      actorId: "regia-dev",
      sessionId,
      action: "dev.session_reset",
      payloadJson: "{}",
    });

    sendOk(res, toSessionView(getSession(sessionId)!));
  })
);

// POST /api/dev/sessions/:id/duplicate — stessa gameVersion/tavoli/config,
// senza submission/punteggi/audit. Usata anche per "🎮 Nuova partita"
// (la nuova sessione è già DRAFT per costruzione: nessun passo aggiuntivo
// lato server, il frontend passa subito a mostrarne la dashboard).
devRouter.post(
  "/sessions/:id/duplicate",
  asyncRoute(async (req, res) => {
    const schema = z.object({ name: z.string().optional() });
    const { name } = schema.parse(req.body ?? {});
    const sessionId = req.params.id;
    const session = getSession(sessionId);
    if (!session) throw new ApiError(404, "session_not_found", "Sessione non trovata");

    const copy = duplicateSession(sessionId, name);
    createAuditEvent({
      actorType: "control",
      actorId: "regia-dev",
      sessionId: copy.id,
      action: "dev.session_duplicated",
      payloadJson: JSON.stringify({ from: sessionId }),
    });

    sendOk(res, toSessionView(copy), 201);
  })
);

// DELETE /api/dev/sessions/:id — "Elimina (solo DEV)": cancellazione totale.
devRouter.delete(
  "/sessions/:id",
  asyncRoute(async (req, res) => {
    const sessionId = req.params.id;
    const session = getSession(sessionId);
    if (!session) throw new ApiError(404, "session_not_found", "Sessione non trovata");

    deleteSessionCascade(sessionId);
    sendOk(res, { deleted: true, id: sessionId });
  })
);

// POST /api/dev/sessions/:id/reopen — "Riapri" da COMPLETED a DRAFT.
// Bypassa deliberatamente lifecycle.ts (che non consente questa
// transizione in produzione): richiede conferma lato client, non c'è
// verifica ulteriore lato server oltre allo stato COMPLETED.
devRouter.post(
  "/sessions/:id/reopen",
  asyncRoute(async (req, res) => {
    const sessionId = req.params.id;
    const session = getSession(sessionId);
    if (!session) throw new ApiError(404, "session_not_found", "Sessione non trovata");
    if (session.status !== "COMPLETED") {
      throw new ApiError(
        409,
        "dev_reopen_requires_completed",
        `Riapertura dev disponibile solo da COMPLETED (stato attuale: ${session.status}).`
      );
    }

    const ok = reopenCompletedSessionDev(sessionId);
    if (!ok) throw new ApiError(409, "dev_reopen_failed", "Impossibile riaprire la sessione");

    createAuditEvent({
      actorType: "control",
      actorId: "regia-dev",
      sessionId,
      action: "dev.session_reopened",
      payloadJson: "{}",
    });

    sendOk(res, toSessionView(getSession(sessionId)!));
  })
);
