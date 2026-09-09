import { Effect, GameModule, ModuleContext, ValidationResult } from "@spell/shared-types";

// Tre moduli banali per tappe itinerary che non richiedono un vero input
// dalla squadra: la submission è "prendo atto / continuo" (payload {}),
// avanzano sempre (start/finale) o generano un voucher idempotente
// (buono) — corrispondono a _gestisciStart/_gestisciBuono/_gestisciFinale
// nel sistema originale. Il client (team.html) le invia automaticamente
// non appena la tappa diventa quella corrente, senza chiedere input.

const noOpValidateConfig: GameModule["validateConfig"] = (): ValidationResult => ({ valid: true });

export const startModule: GameModule = {
  type: "start",
  validateConfig: noOpValidateConfig,
  playerView(): Record<string, unknown> {
    return { type: "start" };
  },
  validateSubmission(): ValidationResult {
    return { valid: true };
  },
  applyRules(ctx): Effect[] {
    return [
      { type: "submission.accept", payload: { activityId: ctx.activityId } },
      { type: "itinerary.advance", payload: {} },
      { type: "message.emit", payload: { audience: "team", text: "Buona fortuna!" } },
    ];
  },
  controlView(): Record<string, unknown> {
    return { type: "start" };
  },
};

export const finaleModule: GameModule = {
  type: "finale",
  validateConfig: noOpValidateConfig,
  playerView(): Record<string, unknown> {
    return { type: "finale" };
  },
  validateSubmission(): ValidationResult {
    return { valid: true };
  },
  applyRules(ctx): Effect[] {
    // Nessun "itinerary.advance": non c'è una tappa successiva, questo è
    // il traguardo. L'orchestrazione riconosce il tipo "finale" e segna
    // l'itinerario completato invece di cercare una tappa dopo (vedi
    // itineraryPipeline.ts).
    return [
      { type: "submission.accept", payload: { activityId: ctx.activityId } },
      { type: "team_state.patch", payload: { path: "itineraryCompletedAt", value: new Date().toISOString() } },
      { type: "message.emit", payload: { audience: "team", text: "Avete completato il percorso!" } },
    ];
  },
  controlView(): Record<string, unknown> {
    return { type: "finale" };
  },
};

interface VoucherConfig {
  ricompensaNome?: string;
}

export const voucherModule: GameModule = {
  type: "voucher",
  validateConfig: noOpValidateConfig,
  playerView(ctx): Record<string, unknown> {
    const config = ctx.activityConfig as unknown as VoucherConfig;
    return { type: "voucher", ricompensaNome: config.ricompensaNome ?? null };
  },
  validateSubmission(): ValidationResult {
    return { valid: true };
  },
  applyRules(ctx): Effect[] {
    // Il token del buono viene generato dall'orchestrazione (serve accesso
    // al bar_id assegnato alla squadra nel proprio base_state e alla
    // tabella "voucher" dedicata, fuori dal contratto generico del
    // modulo) — qui il modulo si limita a segnalare avanzamento, come
    // start/textMatch corretto.
    return [
      { type: "submission.accept", payload: { activityId: ctx.activityId } },
      { type: "itinerary.advance", payload: {} },
      { type: "message.emit", payload: { audience: "team", text: "Avete guadagnato una ricompensa!" } },
    ];
  },
  controlView(): Record<string, unknown> {
    return { type: "voucher" };
  },
};
