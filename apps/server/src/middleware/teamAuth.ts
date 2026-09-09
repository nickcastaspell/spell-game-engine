import { Request, Response, NextFunction } from "express";
import { hashToken } from "../lib/tokens";
import { sendErr } from "../lib/response";
import { findDeviceSessionByTokenHash, getTeam, touchDeviceSession } from "../lib/repo";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      teamId?: string;
      sessionId?: string;
    }
  }
}

/**
 * Risolve il token di sessione del tavolo (device_session) in un teamId.
 * Un codice tavolo NON dà accesso diretto: il login scambia il codice
 * con un token, e da qui in poi si usa solo il token (criterio §16).
 */
export async function teamAuth(req: Request, res: Response, next: NextFunction) {
  const header = req.header("authorization") ?? "";
  const token = header.replace(/^Bearer\s+/i, "");
  if (!token) {
    sendErr(res, 401, "unauthorized", "Token tavolo mancante");
    return;
  }
  const tokenHash = hashToken(token);
  const device = findDeviceSessionByTokenHash(tokenHash);
  if (!device || device.revoked_at) {
    sendErr(res, 401, "unauthorized", "Token tavolo non valido o revocato");
    return;
  }
  touchDeviceSession(device.id);
  const team = getTeam(device.team_id);
  if (!team) {
    sendErr(res, 401, "unauthorized", "Tavolo non trovato");
    return;
  }
  req.teamId = team.id;
  req.sessionId = team.session_id;
  next();
}
