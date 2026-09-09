import { Effect, GameModule, ModuleContext, ValidationResult } from "@spell/shared-types";

/**
 * Tappa "foto": la squadra carica un'immagine, un operatore (regia o
 * facilitatore, vedi apps/server/src/lib/facilitatorAuth.ts) la
 * approva/rigetta in un secondo momento. A differenza di textMatch,
 * l'esito non è noto al momento della submission — questo modulo NON
 * genera "score.add"/"itinerary.advance": li genera l'orchestrazione
 * (lib/itineraryPipeline.ts, funzione decidePhoto) quando arriva la
 * decisione dell'operatore, come punteggio/avanzamento di una submission
 * SEPARATA che riferisce a questa per sourceSubmissionId — lo stesso
 * pattern spec §5 "gli effetti derivano da eventi", solo differito.
 *
 * Il salvataggio vero e proprio del file (validazione dimensione/tipo,
 * scrittura su disco) è responsabilità dell'orchestrazione: qui il
 * modulo valida solo la FORMA del payload (deve contenere una stringa
 * base64 non vuota), non il contenuto binario.
 */

export const photoApprovalModule: GameModule = {
  type: "photoApproval",

  validateConfig(): ValidationResult {
    return { valid: true };
  },

  playerView(): Record<string, unknown> {
    return { type: "photoApproval" };
  },

  validateSubmission(_ctx, payload): ValidationResult {
    const photoBase64 = (payload as { photoBase64?: unknown }).photoBase64;
    if (typeof photoBase64 !== "string" || !photoBase64.trim()) {
      return { valid: false, errors: ["foto mancante"] };
    }
    return { valid: true };
  },

  applyRules(ctx: ModuleContext): Effect[] {
    return [
      { type: "submission.accept", payload: { activityId: ctx.activityId } },
      {
        type: "team_state.patch",
        payload: { path: `stepLog.${ctx.activityId}`, value: { esito: "in_attesa" } },
      },
      {
        type: "message.emit",
        payload: { audience: "team", text: "Foto ricevuta. Un operatore la verificherà a breve." },
      },
    ];
  },

  controlView(): Record<string, unknown> {
    return { type: "photoApproval" };
  },
};
