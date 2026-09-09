import { Effect, GameModule, ModuleContext, ValidationResult } from "@spell/shared-types";

/**
 * Modulo generico per tappe "a risposta secca", usato dentro fasi
 * "itinerary" (Il mistero della città): risposta testuale libera (tipo
 * originale "testo"), risposta ascoltata da una guida ("guida") o codice
 * QR scansionato ("qr") — nel gioco originale erano tre gestori quasi
 * identici (_valutaTesto/_valutaQR); qui un solo modulo con `kind` che
 * serve solo a etichettare la UI, stesso confronto normalizzato per tutti.
 *
 * A differenza di "classification" (single_submission: un solo invio,
 * poi la regia riapre), qui un tentativo sbagliato NON è un errore di
 * validazione: viene comunque registrato come submission (== tentativo),
 * ma senza punteggio né avanzamento — la squadra può riprovare subito,
 * senza intervento della regia (l'orchestrazione itinerary, non questo
 * modulo, non applica il vincolo "una sola submission attiva" di
 * submissionPipeline.ts).
 */

interface TextMatchConfig {
  expectedAnswer: string;
  kind?: "testo" | "guida" | "qr";
  points?: number;
}

function normalizza(s: string): string {
  return String(s ?? "")
    .toLowerCase()
    .trim()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

function getConfig(ctx: ModuleContext): TextMatchConfig {
  return ctx.activityConfig as unknown as TextMatchConfig;
}

export const textMatchModule: GameModule = {
  type: "textMatch",

  validateConfig(config): ValidationResult {
    const c = config as unknown as TextMatchConfig;
    const errors: string[] = [];
    if (!c.expectedAnswer || typeof c.expectedAnswer !== "string") {
      errors.push("expectedAnswer mancante o non valido");
    }
    if (c.kind !== undefined && !["testo", "guida", "qr"].includes(c.kind)) {
      errors.push('kind deve essere "testo", "guida" o "qr" se presente');
    }
    return { valid: errors.length === 0, errors: errors.length ? errors : undefined };
  },

  playerView(ctx): Record<string, unknown> {
    const config = getConfig(ctx);
    return { type: "textMatch", kind: config.kind ?? "testo" };
  },

  validateSubmission(_ctx, payload): ValidationResult {
    const answer = (payload as { answer?: unknown }).answer;
    if (typeof answer !== "string" || !answer.trim()) {
      return { valid: false, errors: ["risposta mancante"] };
    }
    return { valid: true };
  },

  applyRules(ctx, payload): Effect[] {
    const config = getConfig(ctx);
    const answer = String((payload as { answer: string }).answer);
    const corretta = normalizza(answer) === normalizza(config.expectedAnswer);
    const effects: Effect[] = [];

    effects.push({
      type: "team_state.patch",
      payload: {
        path: `stepLog.${ctx.activityId}`,
        value: { esito: corretta ? "corretto" : "errato", risposta: answer },
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
      // Segnala all'orchestrazione itinerary di avanzare la squadra alla
      // tappa successiva del proprio percorso — vedi commento sul tipo
      // "itinerary.advance" in shared-types/src/index.ts.
      effects.push({ type: "itinerary.advance", payload: {} });
    }

    effects.push({ type: "submission.accept", payload: { activityId: ctx.activityId } });
    effects.push({
      type: "message.emit",
      payload: {
        audience: "team",
        text: corretta ? "Risposta corretta! Avanzate." : "Risposta non corretta, riprovate.",
      },
    });

    return effects;
  },

  controlView(ctx): Record<string, unknown> {
    const config = getConfig(ctx);
    return { type: "textMatch", kind: config.kind ?? "testo" };
  },
};
