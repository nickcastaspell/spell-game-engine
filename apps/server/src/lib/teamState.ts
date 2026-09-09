// Stato piccolo, serializzabile, indipendente dalla UI (spec §8).
// Un unico documento JSON per team: contiene sia i campi "di piattaforma"
// (es. score, cache di lettura ricostruibile dagli score_event) sia i
// dati specifici del gioco, sotto chiavi separate (es. "classifications").

export function parseState(stateJson: string): Record<string, unknown> {
  try {
    return JSON.parse(stateJson) as Record<string, unknown>;
  } catch {
    return {};
  }
}

export function stringifyState(state: Record<string, unknown>): string {
  return JSON.stringify(state);
}

/** Imposta un valore in un percorso puntato (es. "classifications.conoscere"), senza mutare l'originale. */
export function patchAtPath(
  state: Record<string, unknown>,
  path: string,
  value: unknown
): Record<string, unknown> {
  const next = structuredClone(state);
  const keys = path.split(".");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let cursor: any = next;
  for (let i = 0; i < keys.length - 1; i++) {
    const k = keys[i];
    if (typeof cursor[k] !== "object" || cursor[k] === null) {
      cursor[k] = {};
    }
    cursor = cursor[k];
  }
  cursor[keys[keys.length - 1]] = value;
  return next;
}

export function addScore(state: Record<string, unknown>, amount: number): Record<string, unknown> {
  const current = typeof state.score === "number" ? state.score : 0;
  return { ...structuredClone(state), score: current + amount };
}
