import { Effect } from "@spell/shared-types";
import { addScore, patchAtPath } from "./teamState";

// Applica un singolo effetto allo stato in memoria. Condiviso tra la
// pipeline di submission (stato in avanti) e il rebuild dello stato
// (rilettura degli effect_event delle submission ancora accettate) — la
// stessa funzione deve produrre lo stesso risultato in entrambi i casi,
// altrimenti "ricostruire lo stato dagli eventi" non sarebbe affidabile.
export function applyEffectToState(
  state: Record<string, unknown>,
  effect: Pick<Effect, "type" | "payload">
): Record<string, unknown> {
  switch (effect.type) {
    case "score.add":
      return addScore(state, Number(effect.payload.amount ?? 0));
    case "team_state.patch":
      return patchAtPath(state, String(effect.payload.path), effect.payload.value);
    default:
      return state;
  }
}
