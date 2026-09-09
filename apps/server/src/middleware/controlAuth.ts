import { Request, Response, NextFunction } from "express";
import { sendErr } from "../lib/response";

// Token regia separato dal token tavolo (spec §17 "Autenticazione").
// Per il prototipo: un secret statico da variabile d'ambiente,
// niente account personali (nessun Google/Microsoft, spec §15).
// Default di comodo per lo sviluppo locale quando CONTROL_TOKEN non è
// impostato: "nick", su richiesta esplicita. In produzione va sempre
// impostato CONTROL_TOKEN nell'ambiente — non affidarsi a questo default.
const CONTROL_TOKEN = process.env.CONTROL_TOKEN ?? "nick";

export function controlAuth(req: Request, res: Response, next: NextFunction) {
  const header = req.header("authorization") ?? "";
  const token = header.replace(/^Bearer\s+/i, "");
  if (token !== CONTROL_TOKEN) {
    sendErr(res, 401, "unauthorized", "Token regia mancante o non valido");
    return;
  }
  next();
}
