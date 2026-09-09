import { Effect, GameModule, ModuleContext } from "@spell/shared-types";

export type SubmissionOutcome =
  | { accepted: true; effects: Effect[] }
  | { accepted: false; errors: string[] };

/**
 * Logica pura submission -> regole -> effetti (spec §6, §10).
 * Non tocca il database: la persistenza (transazione, idempotenza,
 * optimistic locking) è responsabilità dell'applicazione (apps/server),
 * cosi' il core resta testabile senza DB e riusabile da qualsiasi gioco.
 */
export function computeSubmissionOutcome(
  mod: GameModule,
  ctx: ModuleContext,
  payload: Record<string, unknown>
): SubmissionOutcome {
  const validation = mod.validateSubmission(ctx, payload);
  if (!validation.valid) {
    return { accepted: false, errors: validation.errors ?? ["submission non valida"] };
  }
  const effects = mod.applyRules(ctx, payload);
  return { accepted: true, effects };
}
