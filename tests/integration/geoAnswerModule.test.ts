import { describe, it, expect } from "vitest";
import { geoAnswerModule } from "../../packages/game-core/src/modules/geoAnswer";
import type { ModuleContext } from "../../packages/shared-types/src/index";

// Test diretto del modulo (funzione pura, nessun DB/HTTP necessario), stesso
// principio di textMatchModule.test.ts: verifica che lat/lng siano ora
// facoltativi (nessun obbligo di tappa oltre a inizio/fine) e che, quando
// assenti, la tappa diventi un "check-in libero" che accetta qualunque
// posizione inviata.

function ctx(activityConfig: Record<string, unknown>): ModuleContext {
  return {
    sessionId: "ses-test",
    teamId: "team-test",
    phaseId: "percorso",
    activityId: "tappa-test",
    activityConfig,
    content: {},
    teamState: {},
  };
}

function isCorrect(effects: ReturnType<typeof geoAnswerModule.applyRules>): boolean {
  return effects.some((e) => e.type === "itinerary.advance");
}

describe("geoAnswerModule — lat/lng facoltativi", () => {
  it("validateConfig accetta una config senza lat/lng", () => {
    expect(geoAnswerModule.validateConfig({}).valid).toBe(true);
  });

  it("validateConfig rifiuta lat/lng non numerici se presenti", () => {
    expect(geoAnswerModule.validateConfig({ lat: "x", lng: 11 }).valid).toBe(false);
  });

  it("con lat/lng impostati, il comportamento a distanza resta invariato", () => {
    const config = { lat: 44.4939, lng: 11.3427, toleranceMeters: 40, points: 10 };
    expect(isCorrect(geoAnswerModule.applyRules(ctx(config), { lat: 44.4939, lng: 11.3427 }))).toBe(true);
    expect(isCorrect(geoAnswerModule.applyRules(ctx(config), { lat: 45.0, lng: 12.0 }))).toBe(false);
  });

  it("senza lat/lng in config, qualunque posizione inviata è accettata (check-in libero)", () => {
    const config = { points: 10 };
    expect(isCorrect(geoAnswerModule.applyRules(ctx(config), { lat: 0, lng: 0 }))).toBe(true);
    expect(isCorrect(geoAnswerModule.applyRules(ctx(config), { lat: 45.0, lng: 12.0 }))).toBe(true);
  });
});
