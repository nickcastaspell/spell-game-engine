import { z } from "zod";
import { GameDefinition } from "@spell/shared-types";
import { ModuleRegistry } from "@spell/game-core";
import { KNOWN_RULES } from "./ruleRegistry";

// Validazione runtime della game definition (spec §9). Prima veniva solo
// fatto `JSON.parse(...) as GameDefinition`: un cast, non una verifica —
// un JSON malformato (fase senza id, teamsMax < teamsMin, id duplicati...)
// sarebbe passato inosservato fino a rompersi a runtime, magari a sessione
// già creata. Validiamo una volta, al momento della pubblicazione
// (seed / creazione sessione), non ad ogni richiesta: una game_version è
// immutabile una volta pubblicata (vedi repo.ts upsertGameVersion), quindi
// se è valida alla pubblicazione resta valida per sempre dopo.

const ActivityDefinitionSchema = z.object({
  id: z.string().min(1),
  type: z.string().min(1),
  title: z.string().min(1),
  config: z.record(z.unknown()),
});

const ItineraryPhaseDefinitionSchema = z.object({
  stepsSource: z.string().min(1),
  routing: z.object({
    minGuideDistance: z.number().int().positive().optional(),
  }),
  maxPhotoAttempts: z.number().int().positive().optional(),
  hintPenalty: z.number().int().nonnegative().optional(),
  showUpcomingStops: z.boolean().optional(),
});

// "activity" e "itinerary" sono entrambi opzionali qui a livello strutturale
// (Zod non ha union discriminate comode con optional incrociati) — la
// coerenza con "mode" è verificata nel superRefine sotto, dove possiamo
// dare un messaggio di errore preciso invece del generico "union non
// valida" che si otterrebbe con un discriminatedUnion.
const PhaseDefinitionSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  mode: z.enum(["single_submission", "multi_round", "itinerary"]),
  activity: ActivityDefinitionSchema.optional(),
  itinerary: ItineraryPhaseDefinitionSchema.optional(),
  completion: z.object({
    type: z.enum(["all_teams_submitted", "manual", "each_team_at_own_pace"]),
  }),
});

const GameDefinitionSchema = z
  .object({
    schemaVersion: z.string().min(1),
    game: z.object({
      id: z.string().min(1),
      name: z.string().min(1),
      defaultLocale: z.string().min(1),
    }),
    roles: z.array(z.string()).min(1),
    settings: z
      .object({
        teamsMin: z.number().int().positive(),
        teamsMax: z.number().int().positive(),
        oneDevicePerTeam: z.boolean(),
        showLeaderboard: z.boolean(),
      })
      .refine((s) => s.teamsMax >= s.teamsMin, {
        message: "settings.teamsMax deve essere >= settings.teamsMin",
      }),
    phases: z.array(PhaseDefinitionSchema).min(1),
    content: z.record(z.unknown()),
    rules: z.record(z.string()),
  })
  .superRefine((def, ctx) => {
    const phaseIds = new Set<string>();
    // "activityIds" raccoglie sia gli id delle activity (single_submission/
    // multi_round) sia gli id delle singole tappe itinerary: le submission
    // vengono cercate per (sessionId, teamId, activityId) senza il phaseId
    // (spec §12) e le tappe itinerary usano lo stesso meccanismo (ogni
    // tappa è il suo "activityId" quando la squadra ci transita) — quindi
    // devono essere univoci nell'INTERA definizione, non solo dentro la
    // fase o il pool di tappe.
    const activityIds = new Set<string>();
    def.phases.forEach((phase, phaseIndex) => {
      if (phaseIds.has(phase.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `id di fase duplicato: "${phase.id}"`,
          path: ["phases"],
        });
      }
      phaseIds.add(phase.id);

      // Coerenza mode <-> activity/itinerary: un discriminatedUnion Zod
      // darebbe un messaggio meno chiaro di questo controllo esplicito.
      if (phase.mode === "itinerary") {
        if (!phase.itinerary) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `fase "${phase.id}": mode "itinerary" richiede il campo "itinerary"`,
            path: ["phases", phaseIndex, "itinerary"],
          });
        }
        if (phase.activity) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `fase "${phase.id}": mode "itinerary" non deve avere il campo "activity"`,
            path: ["phases", phaseIndex, "activity"],
          });
        }
      } else {
        if (!phase.activity) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `fase "${phase.id}": mode "${phase.mode}" richiede il campo "activity"`,
            path: ["phases", phaseIndex, "activity"],
          });
          return; // senza activity non ha senso proseguire i controlli sotto per questa fase
        }
        if (activityIds.has(phase.activity.id)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `id di attività duplicato tra fasi: "${phase.activity.id}"`,
            path: ["phases"],
          });
        }
        activityIds.add(phase.activity.id);
      }

      if (phase.mode === "itinerary" && phase.itinerary) {
        const steps = (def.content as Record<string, unknown>)[phase.itinerary.stepsSource];
        if (Array.isArray(steps)) {
          steps.forEach((step, stepIndex) => {
            const id = (step as Record<string, unknown> | null)?.id;
            if (typeof id !== "string" || !id) {
              ctx.addIssue({
                code: z.ZodIssueCode.custom,
                message: `content.${phase.itinerary!.stepsSource}[${stepIndex}]: tappa priva di "id" valido`,
                path: ["content", phase.itinerary!.stepsSource, stepIndex, "id"],
              });
              return;
            }
            if (activityIds.has(id)) {
              ctx.addIssue({
                code: z.ZodIssueCode.custom,
                message: `id di tappa/attività duplicato nell'intera definizione: "${id}"`,
                path: ["content", phase.itinerary!.stepsSource, stepIndex, "id"],
              });
            }
            activityIds.add(id);
          });
        }
      }
    });
  });

export class GameDefinitionValidationError extends Error {
  issues: string[];
  constructor(issues: string[]) {
    super(`game definition non valida: ${issues.join("; ")}`);
    this.name = "GameDefinitionValidationError";
    this.issues = issues;
  }
}

function formatPath(segments: Array<string | number>): string {
  if (segments.length === 0) return "(root)";
  let out = "";
  for (const seg of segments) {
    if (typeof seg === "number") {
      out += `[${seg}]`;
    } else {
      out += out ? `.${seg}` : seg;
    }
  }
  return out;
}

export function validateGameDefinition(raw: unknown): GameDefinition {
  const result = GameDefinitionSchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `${formatPath(i.path)}: ${i.message}`);
    throw new GameDefinitionValidationError(issues);
  }
  return result.data as GameDefinition;
}

/**
 * Validazione SEMANTICA, in aggiunta a quella strutturale Zod (spec §9,
 * v5.1 §5). Va chiamata solo al momento della pubblicazione (seed,
 * creazione sessione in difesa) — non nell'hot path delle richieste,
 * perché richiede il moduleRegistry e chiama validateConfig() dei moduli,
 * lavoro non necessario ad ogni richiesta dato che una game_version
 * pubblicata è immutabile.
 */
export function validateGameDefinitionSemantics(def: GameDefinition, registry: ModuleRegistry): void {
  const issues: string[] = [];

  def.phases.forEach((phase, phaseIndex) => {
    if (phase.mode === "itinerary") {
      issues.push(...validateItinerarySemantics(def, phase, phaseIndex, registry));
      return;
    }

    const activityPath = ["phases", phaseIndex, "activity"];
    if (!phase.activity) return; // già segnalato dalla validazione strutturale (superRefine)

    if (!registry.has(phase.activity.type)) {
      issues.push(`${formatPath([...activityPath, "type"])}: modulo "${phase.activity.type}" non registrato`);
      return; // senza il modulo non ha senso continuare i controlli che dipendono da esso
    }

    const mod = registry.get(phase.activity.type);
    const configValidation = mod.validateConfig(phase.activity.config);
    if (!configValidation.valid) {
      const detail = (configValidation.errors ?? []).join("; ") || "configurazione non valida";
      issues.push(`${formatPath([...activityPath, "config"])}: ${detail}`);
    }

    // itemsSource: convenzione usata da più moduli (non solo classification)
    // per riferirsi a una lista dentro "content". Controllo generico: se la
    // chiave è presente, il riferimento deve esistere ed essere ben formato.
    const config = phase.activity.config as Record<string, unknown>;
    if (typeof config.itemsSource === "string") {
      const items = (def.content as Record<string, unknown>)[config.itemsSource];
      const itemsPath = formatPath([...activityPath, "config", "itemsSource"]);
      if (!Array.isArray(items)) {
        issues.push(`${itemsPath}: content source "${config.itemsSource}" non trovato`);
      } else {
        items.forEach((item, itemIndex) => {
          if (!item || typeof item !== "object" || typeof (item as Record<string, unknown>).id !== "string") {
            issues.push(`content.${config.itemsSource}[${itemIndex}]: elemento privo di "id" valido`);
          }
          if (!item || typeof item !== "object" || typeof (item as Record<string, unknown>).label !== "string") {
            issues.push(`content.${config.itemsSource}[${itemIndex}]: elemento privo di "label" valido`);
          }
        });
      }
    }

    if (phase.activity.type === "classification") {
      issues.push(...validateClassificationSemantics(def, phase, activityPath));
    }
  });

  for (const [ruleKey, ruleName] of Object.entries(def.rules)) {
    if (!KNOWN_RULES.has(ruleName)) {
      issues.push(`rules.${ruleKey}: regola "${ruleName}" non registrata`);
    }
  }

  if (issues.length > 0) {
    throw new GameDefinitionValidationError(issues);
  }
}

function validateClassificationSemantics(
  def: GameDefinition,
  phase: GameDefinition["phases"][number],
  activityPath: Array<string | number>
): string[] {
  const issues: string[] = [];
  // Chiamata solo quando phase.activity.type === "classification" (vedi
  // sopra): a quel punto activity è per forza presente, ma TS non lo sa
  // dall'interno di questa funzione separata.
  const config = (phase.activity!.config) as { itemsSource?: string; categories?: unknown };
  const categories = Array.isArray(config.categories) ? (config.categories as unknown[]) : [];

  const categorySet = new Set<string>();
  const duplicateCategories = new Set<string>();
  for (const c of categories) {
    if (typeof c !== "string") continue;
    if (categorySet.has(c)) duplicateCategories.add(c);
    categorySet.add(c);
  }
  if (duplicateCategories.size > 0) {
    issues.push(
      `${formatPath([...activityPath, "config", "categories"])}: categorie duplicate: ${[...duplicateCategories].join(", ")}`
    );
  }

  if (typeof config.itemsSource === "string") {
    const items = (def.content as Record<string, unknown>)[config.itemsSource];
    if (Array.isArray(items)) {
      const idSet = new Set<string>();
      const duplicateIds = new Set<string>();
      items.forEach((item, itemIndex) => {
        const record = item as Record<string, unknown>;
        const id = typeof record?.id === "string" ? record.id : undefined;
        if (id) {
          if (idSet.has(id)) duplicateIds.add(id);
          idSet.add(id);
        }
        const expected = record?.expectedCategory;
        if (expected !== undefined && !categorySet.has(String(expected))) {
          issues.push(
            `content.${config.itemsSource}[${itemIndex}].expectedCategory: "${expected}" non è tra le categorie dichiarate in ${formatPath([...activityPath, "config", "categories"])}`
          );
        }
      });
      if (duplicateIds.size > 0) {
        issues.push(`content.${config.itemsSource}: id elemento duplicati: ${[...duplicateIds].join(", ")}`);
      }
    }
  }

  return issues;
}

/**
 * Validazione semantica per fasi "itinerary" (Il mistero della città):
 * ogni tappa in content[stepsSource] è trattata come una mini "activity" —
 * il suo "type" deve corrispondere a un modulo registrato, e il modulo
 * valida la config della tappa esattamente come farebbe per un'activity
 * normale (stesso contratto GameModule.validateConfig, nessuna eccezione
 * speciale per l'itinerario).
 */
function validateItinerarySemantics(
  def: GameDefinition,
  phase: GameDefinition["phases"][number],
  phaseIndex: number,
  registry: ModuleRegistry
): string[] {
  const issues: string[] = [];
  const phasePath = ["phases", phaseIndex];

  if (!phase.itinerary) return issues; // già segnalato dalla validazione strutturale

  const stepsSource = phase.itinerary.stepsSource;
  const steps = (def.content as Record<string, unknown>)[stepsSource];
  if (!Array.isArray(steps)) {
    issues.push(`${formatPath([...phasePath, "itinerary", "stepsSource"])}: content source "${stepsSource}" non trovato`);
    return issues;
  }
  if (steps.length === 0) {
    issues.push(`content.${stepsSource}: nessuna tappa definita`);
    return issues;
  }

  const numbers = new Set<number>();
  let hasFinale = false;

  steps.forEach((raw, stepIndex) => {
    const step = raw as Record<string, unknown>;
    const stepPath = `content.${stepsSource}[${stepIndex}]`;

    if (typeof step.type !== "string" || !step.type) {
      issues.push(`${stepPath}: "type" mancante`);
      return;
    }
    if (!registry.has(step.type)) {
      issues.push(`${stepPath}.type: modulo "${step.type}" non registrato`);
      return;
    }
    if (step.type === "finale") hasFinale = true;

    const mod = registry.get(step.type);
    const configValidation = mod.validateConfig((step.config as Record<string, unknown>) ?? {});
    if (!configValidation.valid) {
      const detail = (configValidation.errors ?? []).join("; ") || "configurazione non valida";
      issues.push(`${stepPath}.config: ${detail}`);
    }

    if (typeof step.number !== "number") {
      issues.push(`${stepPath}: "number" mancante o non numerico`);
    } else {
      if (numbers.has(step.number)) {
        issues.push(`content.${stepsSource}: "number" duplicato: ${step.number}`);
      }
      numbers.add(step.number);
    }

    if (typeof step.points !== "number" || step.points < 0) {
      issues.push(`${stepPath}: "points" mancante o negativo`);
    }

    if (step.groups !== undefined) {
      const groupsOk = Array.isArray(step.groups) && step.groups.every((g) => typeof g === "string");
      if (!groupsOk) issues.push(`${stepPath}.groups: deve essere un array di stringhe, se presente`);
    }
  });

  if (!hasFinale) {
    issues.push(`content.${stepsSource}: nessuna tappa di tipo "finale" — l'itinerario non avrebbe una fine`);
  }

  // "guida" qui è config.kind (vedi itineraryRouting.ts:stepConstraintKind),
  // non ItineraryStepContent.type — quest'ultimo è il modulo motore
  // (es. "textMatch"), non la distinzione testo/guida/qr dell'originale.
  const hasGuidaStep = steps.some((raw) => {
    const step = raw as Record<string, unknown>;
    const config = step.config as Record<string, unknown> | undefined;
    return config?.kind === "guida";
  });
  if (phase.itinerary.routing.minGuideDistance !== undefined && !hasGuidaStep) {
    issues.push(
      `${formatPath([...phasePath, "itinerary", "routing", "minGuideDistance"])}: impostato ma nessuna tappa con config.kind "guida" è presente`
    );
  }

  return issues;
}
