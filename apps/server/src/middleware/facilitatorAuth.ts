import { Request, Response, NextFunction } from "express";
import { ApiError, sendErr } from "../lib/response";
import { findFacilitatorByTokenAny, getTeam } from "../lib/repo";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      facilitatorId?: string;
      facilitatorSessionId?: string;
      /** Team id consentiti a questo facilitatore (vuoto = tutte le squadre della sessione, vedi facilitatorCanAccessTeam). */
      facilitatorTeamIds?: string[];
    }
  }
}

// Autenticazione facilitatore (Il mistero della città): stesso pattern di
// teamAuth.ts (token nell'header Authorization, niente sessionId
// nell'URL) ma senza device_session — il token del facilitatore è
// creato una volta dalla regia (routes/itinerary.ts, dev tooling o
// control.ts) e resta valido per tutta la sessione, non c'è login/logout
// separato: mirror del ruolo reale (un foglio con il proprio token,
// come nell'originale Apps Script "autenticaFacilitatore").
export async function facilitatorAuth(req: Request, res: Response, next: NextFunction) {
  const header = req.header("authorization") ?? "";
  const token = header.replace(/^Bearer\s+/i, "");
  if (!token) {
    sendErr(res, 401, "unauthorized", "Token facilitatore mancante");
    return;
  }
  const facilitator = findFacilitatorByTokenAny(token);
  if (!facilitator) {
    sendErr(res, 401, "unauthorized", "Token facilitatore non valido");
    return;
  }
  req.facilitatorId = facilitator.id;
  req.facilitatorSessionId = facilitator.session_id;
  req.facilitatorTeamIds = JSON.parse(facilitator.team_ids_json) as string[];
  next();
}

/**
 * Un elenco vuoto di team_ids significa "tutte le squadre della sessione"
 * (facilitatore generico/regia leggera), coerente coi dati reali caricati
 * da questo utente (Lorenza e Cesare in Facilitatori non hanno squadre
 * assegnate — vedi spreadsheet "Il mistero della città 2"). Un elenco
 * non vuoto scopa l'accesso a quelle squadre soltanto.
 */
export function facilitatorCanAccessTeam(req: Request, teamId: string): boolean {
  const scoped = req.facilitatorTeamIds ?? [];
  if (scoped.length === 0) return true;
  return scoped.includes(teamId);
}

/** Verifica che teamId appartenga alla stessa sessione del facilitatore autenticato, oltre allo scoping per squadra. */
export function requireFacilitatorAccess(req: Request, teamId: string): void {
  const team = getTeam(teamId);
  if (!team || team.session_id !== req.facilitatorSessionId) {
    throw new ApiError(404, "team_not_found", "Tavolo non trovato in questa sessione");
  }
  if (!facilitatorCanAccessTeam(req, teamId)) {
    throw new ApiError(403, "forbidden", "Questo facilitatore non è autorizzato su questa squadra");
  }
}
