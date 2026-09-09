import { Effect } from "@spell/shared-types";

/**
 * Interfaccia futura per separare la REGOLA (come si calcola un effetto)
 * dal MODULO che raccoglie l'input (come si presenta e si valida
 * un'attività). Preparazione minima per v5.1 — NON è ancora usata da
 * nessun modulo: `classification` (packages/game-core/src/modules/
 * classification.ts) continua a calcolare il punteggio al suo interno
 * (expectedCategory, pointsPerCorrect) invece di delegare a una
 * RuleStrategy registrata per nome (vedi game-definitions/*.json,
 * campo "rules", e apps/server/src/lib/ruleRegistry.ts).
 *
 * La migrazione vera va fatta insieme alla seconda fase di Less is More,
 * quando si potrà verificare il disaccoppiamento con più di una regola
 * reale — farlo ora, con un solo caso d'uso, rischierebbe di indovinare
 * un'astrazione sbagliata.
 */
export interface RuleContext {
  activityId: string;
  config: Record<string, unknown>;
  content: Record<string, unknown>;
  payload: Record<string, unknown>;
  teamState: Record<string, unknown>;
}

export interface RuleResult {
  effects: Effect[];
}

export interface RuleStrategy {
  validateConfig(config: unknown): void;
  evaluate(context: RuleContext): RuleResult;
}
