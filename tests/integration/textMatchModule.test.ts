import { describe, it, expect } from "vitest";
import { textMatchModule } from "../../packages/game-core/src/modules/textMatch";
import type { ModuleContext } from "../../packages/shared-types/src/index";

// Test diretto del modulo (funzione pura, nessun DB/HTTP necessario) —
// stesso principio di itineraryRouting.test.ts per l'algoritmo di
// routing: qui si verifica la Fase 2 (lista di risposte accettate al
// posto di una sola stringa esatta) senza passare dall'intera pipeline
// itinerary già coperta da itineraryFlow.test.ts.

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

function isCorrect(effects: ReturnType<typeof textMatchModule.applyRules>): boolean {
  return effects.some((e) => e.type === "itinerary.advance");
}

describe("textMatchModule — lista di risposte accettate (refusi/sinonimi noti)", () => {
  it("validateConfig accetta expectedAnswers (nuovo campo) e lo richiede non vuoto", () => {
    expect(textMatchModule.validateConfig({ expectedAnswers: ["Bologna", "bo"] }).valid).toBe(true);
    expect(textMatchModule.validateConfig({ expectedAnswers: [] }).valid).toBe(false);
    expect(textMatchModule.validateConfig({}).valid).toBe(false);
  });

  it("validateConfig accetta ancora expectedAnswer (legacy, game_version già pubblicate)", () => {
    expect(textMatchModule.validateConfig({ expectedAnswer: "Bologna" }).valid).toBe(true);
  });

  it("una risposta che combacia con QUALUNQUE variante della lista è corretta", () => {
    const config = { expectedAnswers: ["Lucio Dalla", "dalla"], points: 10 };
    expect(isCorrect(textMatchModule.applyRules(ctx(config), { answer: "Lucio Dalla" }))).toBe(true);
    expect(isCorrect(textMatchModule.applyRules(ctx(config), { answer: "dalla" }))).toBe(true);
    // Normalizzazione (minuscolo/accenti) invariata, applicata a ogni variante.
    expect(isCorrect(textMatchModule.applyRules(ctx(config), { answer: "LUCIO DALLA" }))).toBe(true);
  });

  it("una risposta fuori dalla lista resta errata", () => {
    const config = { expectedAnswers: ["Lucio Dalla", "dalla"], points: 10 };
    expect(isCorrect(textMatchModule.applyRules(ctx(config), { answer: "Vasco Rossi" }))).toBe(false);
  });

  it("expectedAnswer legacy (singola stringa) continua a funzionare senza expectedAnswers", () => {
    const config = { expectedAnswer: "Bologna", points: 10 };
    expect(isCorrect(textMatchModule.applyRules(ctx(config), { answer: "bologna" }))).toBe(true);
    expect(isCorrect(textMatchModule.applyRules(ctx(config), { answer: "Milano" }))).toBe(false);
  });

  it("expectedAnswers ha priorità su expectedAnswer se entrambi presenti", () => {
    const config = { expectedAnswer: "Bologna", expectedAnswers: ["Milano"], points: 10 };
    expect(isCorrect(textMatchModule.applyRules(ctx(config), { answer: "Bologna" }))).toBe(false);
    expect(isCorrect(textMatchModule.applyRules(ctx(config), { answer: "Milano" }))).toBe(true);
  });
});
