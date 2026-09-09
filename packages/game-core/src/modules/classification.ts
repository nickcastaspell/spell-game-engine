import {
  Effect,
  GameModule,
  ModuleContext,
  ValidationResult,
} from "@spell/shared-types";

/**
 * Primo modulo MVP (spec §10):
 * input: elenco elementi + categorie consentite
 * submission: { assignments: { itemId: categoryId } }
 * validation: tutti gli elementi richiesti, categorie valide, un solo invio attivo
 * output: submission.accepted + eventuali score_event + team_state.updated
 *
 * DEBITO TECNICO (registrato in v5.1, non risolto qui): questo modulo
 * mescola ancora raccolta e regola — expectedCategory/pointsPerCorrect
 * sono calcolati qui dentro invece di essere delegati a una RuleStrategy
 * esterna (vedi ../ruleStrategy.ts, interfaccia preparata ma non cablata).
 * La game definition dichiara "classificationScoring":
 * "lessIsMore.classification.v1" in "rules", ma quel nome oggi serve solo
 * a passare la validazione semantica (apps/server/src/lib/
 * gameDefinitionValidation.ts) — non seleziona davvero una regola qui.
 * Non toccare la logica sotto per separare le due cose ora: farlo con un
 * solo modulo/gioco reale rischia di produrre un'astrazione sbagliata.
 * La separazione va fatta insieme alla seconda fase di Less is More.
 */

interface ClassificationConfig {
  itemsSource: string;
  categories: string[];
  required: boolean;
  /** punti assegnati per assegnazione corretta, se gli item hanno expectedCategory */
  pointsPerCorrect?: number;
}

interface ClassificationItem {
  id: string;
  label: string;
  /** opzionale: se presente, il modulo può calcolare un punteggio */
  expectedCategory?: string;
}

interface ClassificationSubmission {
  assignments: Record<string, string>;
}

function getConfig(ctx: ModuleContext): ClassificationConfig {
  const c = ctx.activityConfig as unknown as ClassificationConfig;
  return {
    itemsSource: c.itemsSource,
    categories: c.categories,
    required: c.required ?? true,
    pointsPerCorrect: c.pointsPerCorrect ?? 1,
  };
}

function getItems(ctx: ModuleContext, config: ClassificationConfig): ClassificationItem[] {
  const items = ctx.content[config.itemsSource];
  return Array.isArray(items) ? (items as ClassificationItem[]) : [];
}

export const classificationModule: GameModule = {
  type: "classification",

  validateConfig(config): ValidationResult {
    const errors: string[] = [];
    const c = config as unknown as ClassificationConfig;
    if (!c.itemsSource || typeof c.itemsSource !== "string") {
      errors.push("itemsSource mancante o non valido");
    }
    if (!Array.isArray(c.categories) || c.categories.length === 0) {
      errors.push("categories deve essere un array non vuoto");
    }
    return { valid: errors.length === 0, errors: errors.length ? errors : undefined };
  },

  playerView(ctx): Record<string, unknown> {
    const config = getConfig(ctx);
    const items = getItems(ctx, config).map((i) => ({ id: i.id, label: i.label }));
    return {
      type: "classification",
      items,
      categories: config.categories,
      required: config.required,
    };
  },

  validateSubmission(ctx, payload): ValidationResult {
    const config = getConfig(ctx);
    const items = getItems(ctx, config);
    const sub = payload as unknown as ClassificationSubmission;
    const errors: string[] = [];

    if (!sub || typeof sub.assignments !== "object" || sub.assignments === null) {
      return { valid: false, errors: ["payload privo di 'assignments'"] };
    }

    if (config.required) {
      for (const item of items) {
        if (!(item.id in sub.assignments)) {
          errors.push(`elemento mancante: ${item.id}`);
        }
      }
    }

    for (const [itemId, categoryId] of Object.entries(sub.assignments)) {
      if (!items.find((i) => i.id === itemId)) {
        errors.push(`elemento sconosciuto: ${itemId}`);
        continue;
      }
      if (!config.categories.includes(categoryId)) {
        errors.push(`categoria non valida per ${itemId}: ${categoryId}`);
      }
    }

    return { valid: errors.length === 0, errors: errors.length ? errors : undefined };
  },

  applyRules(ctx, payload): Effect[] {
    const config = getConfig(ctx);
    const items = getItems(ctx, config);
    const sub = payload as unknown as ClassificationSubmission;
    const effects: Effect[] = [];

    let correct = 0;
    let scorable = 0;
    for (const item of items) {
      if (item.expectedCategory === undefined) continue;
      scorable += 1;
      if (sub.assignments[item.id] === item.expectedCategory) {
        correct += 1;
      }
    }

    if (scorable > 0) {
      const points = correct * (config.pointsPerCorrect ?? 1);
      effects.push({
        type: "score.add",
        payload: {
          amount: points,
          reason: `classification:${ctx.activityId}:correct=${correct}/${scorable}`,
        },
      });
    }

    effects.push({
      type: "team_state.patch",
      payload: {
        path: `classifications.${ctx.activityId}`,
        value: { assignments: sub.assignments, correct, scorable },
      },
    });

    effects.push({
      type: "submission.accept",
      payload: { activityId: ctx.activityId },
    });

    effects.push({
      type: "phase.team_complete",
      payload: { phaseId: ctx.phaseId },
    });

    effects.push({
      type: "message.emit",
      payload: {
        audience: "team",
        text: "Invio ricevuto e registrato.",
      },
    });

    return effects;
  },

  controlView(ctx): Record<string, unknown> {
    const config = getConfig(ctx);
    const items = getItems(ctx, config);
    return {
      type: "classification",
      itemCount: items.length,
      categories: config.categories,
    };
  },
};
