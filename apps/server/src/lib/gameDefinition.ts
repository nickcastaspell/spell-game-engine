import { ActivityDefinition, GameDefinition, ItineraryPhaseDefinition, PhaseDefinition } from "@spell/shared-types";
import { ApiError } from "./response";

export function parseDefinition(definitionJson: string): GameDefinition {
  return JSON.parse(definitionJson) as GameDefinition;
}

export function findPhase(def: GameDefinition, phaseId: string): PhaseDefinition {
  const phase = def.phases.find((p) => p.id === phaseId);
  if (!phase) {
    throw new ApiError(404, "phase_not_found", `Fase non trovata: ${phaseId}`);
  }
  return phase;
}

/**
 * `PhaseDefinition.activity` è opzionale nel tipo (le fasi "itinerary" non
 * ce l'hanno, vedi shared-types) perché una sola interfaccia deve coprire
 * entrambe le modalità. Ma il vecchio flusso single_submission/multi_round
 * di Less is More (control.ts, team.ts, submissionPipeline.ts) lo richiede
 * sempre — questo helper lo rende esplicito con un errore chiaro invece di
 * un accesso a `undefined` silenzioso, senza dover ripetere il controllo
 * in ogni file.
 */
export function requireActivity(phase: PhaseDefinition): ActivityDefinition {
  if (!phase.activity) {
    throw new ApiError(
      500,
      "phase_activity_missing",
      `La fase "${phase.id}" (mode: ${phase.mode}) non ha una "activity" — atteso solo per fasi itinerary.`
    );
  }
  return phase.activity;
}

/** Simmetrico a requireActivity, per le fasi "itinerary". */
export function requireItinerary(phase: PhaseDefinition): ItineraryPhaseDefinition {
  if (!phase.itinerary) {
    throw new ApiError(
      500,
      "phase_itinerary_missing",
      `La fase "${phase.id}" (mode: ${phase.mode}) non ha una configurazione "itinerary".`
    );
  }
  return phase.itinerary;
}
