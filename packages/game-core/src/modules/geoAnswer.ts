import { Effect, GameModule, ModuleContext, ValidationResult } from "@spell/shared-types";
import { haversineMeters } from "../itineraryRouting";

/**
 * Modulo per tappe "a risposta secca" verificata via posizione geografica,
 * dentro fasi "itinerary" (Il mistero della città): la squadra invia le
 * coordinate del punto in cui si trova (rilevate dal GPS del telefono o
 * inserite a mano se il permesso è negato — la distinzione è solo lato
 * client, apps/web/public/team.html, questo modulo riceve sempre lat/lng),
 * corretta se entro `toleranceMeters` dal punto atteso in config.
 *
 * Stesso comportamento di textMatch.ts per un tentativo sbagliato: resta
 * registrato come submission ma non fa avanzare né assegna punti, la
 * squadra può riprovare subito.
 *
 * lat/lng sono facoltativi (nessun obbligo di tappa oltre a inizio/fine,
 * per richiesta esplicita): se assenti non c'è un punto atteso da
 * verificare, quindi qualunque posizione inviata viene accettata — la
 * tappa diventa di fatto un "check-in libero" (vedi applyRules).
 */

const DEFAULT_TOLERANCE_METERS = 40;

interface GeoAnswerConfig {
  lat?: number;
  lng?: number;
  toleranceMeters?: number;
  points?: number;
}

function getConfig(ctx: ModuleContext): GeoAnswerConfig {
  return ctx.activityConfig as unknown as GeoAnswerConfig;
}

function hasTarget(config: GeoAnswerConfig): boolean {
  return typeof config.lat === "number" && typeof config.lng === "number";
}

export const geoAnswerModule: GameModule = {
  type: "geoAnswer",

  validateConfig(config): ValidationResult {
    const c = config as unknown as GeoAnswerConfig;
    const errors: string[] = [];
    if ((c.lat !== undefined && typeof c.lat !== "number") || (c.lng !== undefined && typeof c.lng !== "number")) {
      errors.push("lat/lng, se presenti, devono essere numerici");
    }
    if (c.toleranceMeters !== undefined && !(c.toleranceMeters > 0)) {
      errors.push("toleranceMeters deve essere un numero positivo se presente");
    }
    return { valid: errors.length === 0, errors: errors.length ? errors : undefined };
  },

  playerView(ctx): Record<string, unknown> {
    const config = getConfig(ctx);
    return { type: "geoAnswer", toleranceMeters: config.toleranceMeters ?? DEFAULT_TOLERANCE_METERS };
  },

  validateSubmission(_ctx, payload): ValidationResult {
    const { lat, lng } = payload as { lat?: unknown; lng?: unknown };
    if (typeof lat !== "number" || typeof lng !== "number" || Number.isNaN(lat) || Number.isNaN(lng)) {
      return { valid: false, errors: ["posizione mancante o non valida"] };
    }
    return { valid: true };
  },

  applyRules(ctx, payload): Effect[] {
    const config = getConfig(ctx);
    const { lat, lng } = payload as { lat: number; lng: number };
    const tolerance = config.toleranceMeters ?? DEFAULT_TOLERANCE_METERS;
    // Nessun punto atteso in config: tappa "check-in libero", qualunque
    // posizione inviata è accettata (vedi nota sopra hasTarget).
    const distanza = hasTarget(config) ? haversineMeters({ lat, lng }, { lat: config.lat!, lng: config.lng! }) : 0;
    const corretta = hasTarget(config) ? distanza <= tolerance : true;
    const effects: Effect[] = [];

    effects.push({
      type: "team_state.patch",
      payload: {
        path: `stepLog.${ctx.activityId}`,
        value: { esito: corretta ? "corretto" : "errato", posizione: { lat, lng }, distanzaMetri: Math.round(distanza) },
      },
    });

    if (corretta) {
      const points = typeof config.points === "number" ? config.points : 0;
      if (points > 0) {
        effects.push({
          type: "score.add",
          payload: { amount: points, reason: `itinerary:${ctx.activityId}:corretto` },
        });
      }
      effects.push({ type: "itinerary.advance", payload: {} });
    }

    effects.push({ type: "submission.accept", payload: { activityId: ctx.activityId } });
    effects.push({
      type: "message.emit",
      payload: {
        audience: "team",
        text: corretta ? "Posizione corretta! Avanzate." : "Non siete nel posto giusto, riprovate.",
      },
    });

    return effects;
  },

  controlView(ctx): Record<string, unknown> {
    const config = getConfig(ctx);
    return {
      type: "geoAnswer",
      lat: config.lat,
      lng: config.lng,
      toleranceMeters: config.toleranceMeters ?? DEFAULT_TOLERANCE_METERS,
    };
  },
};
