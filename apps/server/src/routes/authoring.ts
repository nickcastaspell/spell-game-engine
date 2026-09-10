import { Router } from "express";
import { z } from "zod";
import { GameDefinition } from "@spell/shared-types";
import { ApiError, asyncRoute, sendOk } from "../lib/response";
import { controlAuth } from "../middleware/controlAuth";
import {
  GameDefinitionValidationError,
  validateGameDefinition,
  validateGameDefinitionSemantics,
} from "../lib/gameDefinitionValidation";
import { moduleRegistry } from "../modules-registry";
import {
  createGameDraft,
  deleteGameDraft,
  getGameBySlug,
  getGameDraft,
  getLatestGameVersion,
  GameDraftRow,
  listGameDrafts,
  updateGameDraft,
  upsertGame,
  upsertGameVersion,
} from "../lib/repo";

// Editor "città/tappe" dalla regia (Fase 3): oggi pubblicare un gioco è
// possibile solo modificando a mano un file in game-definitions/ e
// rilanciando "npm run seed" (apps/server/src/seed.ts). Queste rotte
// offrono lo stesso percorso via HTTP, riusando le stesse funzioni di
// validazione/publish di seed.ts — non un flusso parallelo con regole
// proprie. Una "bozza" (game_draft) è modificabile liberamente prima
// della pubblicazione, che la trasforma in una game_version immutabile
// esattamente come le altre (repo.ts upsertGame/upsertGameVersion).
export const authoringRouter = Router();
authoringRouter.use(controlAuth);

/**
 * Scheletro minimo di una caccia "itinerary" (Il mistero della città):
 * un'unica fase con pool di tappe vuoto, pronta per essere popolata
 * dall'editor. Non generalizzato a single_submission/multi_round — fuori
 * scope per questa fase (l'utente ha chiesto "nuova città, nuove tappe",
 * non un editor generico di ogni tipo di gioco).
 */
function emptyItineraryDefinition(slug: string, name: string): GameDefinition {
  return {
    schemaVersion: "0.1",
    game: { id: slug, name, defaultLocale: "it" },
    roles: ["control", "team", "facilitator"],
    settings: { teamsMin: 1, teamsMax: 20, oneDevicePerTeam: true, showLeaderboard: true },
    phases: [
      {
        id: "percorso",
        title: "Percorso",
        mode: "itinerary",
        itinerary: { stepsSource: "tappe", routing: {}, maxPhotoAttempts: 3, hintPenalty: 5 },
        completion: { type: "each_team_at_own_pace" },
      },
    ],
    content: { tappe: [] },
    rules: {},
  };
}

function toDraftView(draft: GameDraftRow) {
  return {
    id: draft.id,
    slug: draft.slug,
    name: draft.name,
    definition: JSON.parse(draft.definition_json) as GameDefinition,
    updatedAt: draft.updated_at,
  };
}

function requireDraft(id: string): GameDraftRow {
  const draft = getGameDraft(id);
  if (!draft) throw new ApiError(404, "draft_not_found", "Bozza non trovata");
  return draft;
}

// POST /api/control/game-drafts — crea una bozza, vuota o clonata da un
// gioco già pubblicato (basedOn = slug), es. per partire da
// "il-mistero-della-citta" e cambiare città/tappe senza ripartire da zero.
authoringRouter.post(
  "/game-drafts",
  asyncRoute(async (req, res) => {
    const schema = z.object({ slug: z.string().min(1), name: z.string().min(1), basedOn: z.string().optional() });
    const { slug, name, basedOn } = schema.parse(req.body);

    let definition: GameDefinition;
    if (basedOn) {
      const game = getGameBySlug(basedOn);
      if (!game) throw new ApiError(404, "game_not_found", `Gioco "${basedOn}" non trovato`);
      const version = getLatestGameVersion(game.id);
      if (!version) throw new ApiError(404, "game_version_missing", `Nessuna versione pubblicata per "${basedOn}"`);
      definition = JSON.parse(version.definition_json) as GameDefinition;
      definition.game = { ...definition.game, id: slug, name };
    } else {
      definition = emptyItineraryDefinition(slug, name);
    }

    const draft = createGameDraft(slug, name, JSON.stringify(definition));
    sendOk(res, toDraftView(draft), 201);
  })
);

// GET /api/control/game-drafts — elenco bozze.
authoringRouter.get(
  "/game-drafts",
  asyncRoute(async (_req, res) => {
    sendOk(res, listGameDrafts().map(toDraftView));
  })
);

// GET /api/control/game-drafts/:id — definizione completa della bozza.
authoringRouter.get(
  "/game-drafts/:id",
  asyncRoute(async (req, res) => {
    sendOk(res, toDraftView(requireDraft(req.params.id)));
  })
);

// PUT /api/control/game-drafts/:id — salva modifiche. Solo validazione
// STRUTTURALE (Zod): una bozza a metà lavoro può avere temporaneamente
// tappe incomplete/riferimenti mancanti, la validazione semantica piena
// scatta solo al publish sotto.
authoringRouter.put(
  "/game-drafts/:id",
  asyncRoute(async (req, res) => {
    const existing = requireDraft(req.params.id);
    const schema = z.object({ name: z.string().min(1).optional(), definition: z.record(z.unknown()) });
    const { name, definition } = schema.parse(req.body);

    let validated: GameDefinition;
    try {
      validated = validateGameDefinition(definition);
    } catch (e) {
      if (e instanceof GameDefinitionValidationError) {
        throw new ApiError(400, "invalid_draft", e.issues.join("; "));
      }
      throw e;
    }

    const updated = updateGameDraft(existing.id, JSON.stringify(validated), name ?? existing.name);
    sendOk(res, toDraftView(updated!));
  })
);

// DELETE /api/control/game-drafts/:id
authoringRouter.delete(
  "/game-drafts/:id",
  asyncRoute(async (req, res) => {
    requireDraft(req.params.id);
    deleteGameDraft(req.params.id);
    sendOk(res, { deleted: true });
  })
);

// POST /api/control/game-drafts/:id/publish — valida anche SEMANTICAMENTE
// (moduli registrati, config di ogni tappa, tappa "finale" presente...),
// poi pubblica come game_version tramite upsertGame/upsertGameVersion
// (stesse funzioni usate da seed.ts — una game_version pubblicata resta
// immutabile anche se creata da qui). La bozza non viene eliminata: resta
// modificabile per preparare la versione successiva.
authoringRouter.post(
  "/game-drafts/:id/publish",
  asyncRoute(async (req, res) => {
    const draft = requireDraft(req.params.id);
    const raw = JSON.parse(draft.definition_json);

    let definition: GameDefinition;
    try {
      definition = validateGameDefinition(raw);
      validateGameDefinitionSemantics(definition, moduleRegistry);
    } catch (e) {
      if (e instanceof GameDefinitionValidationError) {
        throw new ApiError(400, "invalid_draft", e.issues.join("; "));
      }
      throw e;
    }

    const game = upsertGame(definition.game.id, definition.game.name);
    let gameVersion;
    try {
      gameVersion = upsertGameVersion(game.id, definition.schemaVersion, JSON.stringify(definition));
    } catch (e) {
      throw new ApiError(409, "version_conflict", e instanceof Error ? e.message : String(e));
    }

    sendOk(res, { gameId: game.id, slug: game.slug, version: gameVersion.version });
  })
);
