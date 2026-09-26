// Tipo di gioco dedotto dalla game definition: serve alla Regia e
// all'Editor per concentrarsi sulle cacce "Il mistero di…" (fasi
// "itinerary") senza mescolarle a Less is More, The Pump o giochi di prova.
export type GameKind = "itinerary" | "pump" | "other";

export function gameKindFromDefinition(definitionJson: string): GameKind {
  try {
    const def = JSON.parse(definitionJson) as { phases?: Array<{ mode?: string }> };
    const modes = (def.phases ?? []).map((p) => p.mode);
    if (modes.includes("itinerary")) return "itinerary";
    if (modes.includes("pump")) return "pump";
  } catch {
    // definizione illeggibile: trattata come "other", non blocca l'elenco
  }
  return "other";
}
