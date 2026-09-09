import { describe, it, expect } from "vitest";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";

const dbFile = path.join(os.tmpdir(), `spell-test-gamedef-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
process.env.DATABASE_URL = `file:${dbFile}`;

const repo = await import("../../apps/server/src/lib/repo");
const { validateGameDefinition, validateGameDefinitionSemantics, GameDefinitionValidationError } = await import(
  "../../apps/server/src/lib/gameDefinitionValidation"
);
const { moduleRegistry } = await import("../../apps/server/src/modules-registry");

const defPath = path.join(__dirname, "..", "..", "game-definitions", "less-is-more.v0.1.json");
const definitionRaw = fs.readFileSync(defPath, "utf-8");
const definition = JSON.parse(definitionRaw);

describe("immutabilità delle game_version pubblicate", () => {
  it("ripubblicare la stessa versione con lo STESSO contenuto è un no-op", () => {
    const game = repo.upsertGame("test-immut", "Test Immutabilità");
    const v1 = repo.upsertGameVersion(game.id, "1.0", JSON.stringify({ a: 1, b: 2 }));
    const v2 = repo.upsertGameVersion(game.id, "1.0", JSON.stringify({ b: 2, a: 1 })); // stesso contenuto, chiavi in altro ordine
    expect(v2.id).toBe(v1.id);
  });

  it("ripubblicare la stessa versione con contenuto DIVERSO viene rifiutato", () => {
    const game = repo.upsertGame("test-immut-2", "Test Immutabilità 2");
    repo.upsertGameVersion(game.id, "1.0", JSON.stringify({ a: 1 }));
    expect(() => repo.upsertGameVersion(game.id, "1.0", JSON.stringify({ a: 2 }))).toThrow(/immutabile/);
  });

  it("una sessione creata su una versione resta valida anche se si tenta (invano) di modificarla dopo", () => {
    const game = repo.upsertGame("test-immut-3", "Test Immutabilità 3");
    const v1 = repo.upsertGameVersion(game.id, "1.0", JSON.stringify({ value: "originale" }));
    const session = repo.createSession(v1.id, "sessione ancorata a v1");

    expect(() => repo.upsertGameVersion(game.id, "1.0", JSON.stringify({ value: "modificato" }))).toThrow();

    const versionSeenBySession = repo.getGameVersionById(session.game_version_id)!;
    expect(JSON.parse(versionSeenBySession.definition_json).value).toBe("originale");
  });
});

describe("validazione della game definition (spec §9)", () => {
  it("accetta la definizione di riferimento di Less is More", () => {
    expect(() => validateGameDefinition(definition)).not.toThrow();
  });

  it("rifiuta una definizione senza fasi", () => {
    const bad = { ...definition, phases: [] };
    expect(() => validateGameDefinition(bad)).toThrow(GameDefinitionValidationError);
  });

  it("rifiuta teamsMax < teamsMin", () => {
    const bad = { ...definition, settings: { ...definition.settings, teamsMin: 20, teamsMax: 10 } };
    expect(() => validateGameDefinition(bad)).toThrow(GameDefinitionValidationError);
  });

  it("rifiuta id di fase duplicati", () => {
    const bad = { ...definition, phases: [definition.phases[0], { ...definition.phases[0] }] };
    expect(() => validateGameDefinition(bad)).toThrow(/duplicato/);
  });

  it("rifiuta id di attività duplicati tra fasi diverse", () => {
    const phase2 = {
      ...definition.phases[0],
      id: "altra-fase",
      activity: { ...definition.phases[0].activity }, // stesso activity.id della fase 1
    };
    const bad = { ...definition, phases: [definition.phases[0], phase2] };
    expect(() => validateGameDefinition(bad)).toThrow(/attività duplicato/);
  });

  it("rifiuta un mode di fase non valido", () => {
    const bad = {
      ...definition,
      phases: [{ ...definition.phases[0], mode: "chissà" }],
    };
    expect(() => validateGameDefinition(bad)).toThrow(GameDefinitionValidationError);
  });
});

describe("validazione semantica della game definition (v5.1 §5)", () => {
  it("accetta la definizione di riferimento (modulo registrato, config valida, riferimenti coerenti)", () => {
    const validated = validateGameDefinition(definition);
    expect(() => validateGameDefinitionSemantics(validated, moduleRegistry)).not.toThrow();
  });

  it("rifiuta un activity.type non registrato in moduleRegistry", () => {
    const validated = validateGameDefinition(definition);
    const bad = {
      ...validated,
      phases: [{ ...validated.phases[0], activity: { ...validated.phases[0].activity, type: "modulo-inesistente" } }],
    };
    expect(() => validateGameDefinitionSemantics(bad, moduleRegistry)).toThrow(/non registrato/);
  });

  it("rifiuta un itemsSource che non esiste in content", () => {
    const validated = validateGameDefinition(definition);
    const bad = {
      ...validated,
      phases: [
        {
          ...validated.phases[0],
          activity: {
            ...validated.phases[0].activity,
            config: { ...validated.phases[0].activity.config, itemsSource: "non_esiste" },
          },
        },
      ],
    };
    expect(() => validateGameDefinitionSemantics(bad, moduleRegistry)).toThrow(/non trovato/);
  });

  it("rifiuta una configurazione di attività non valida secondo module.validateConfig", () => {
    const validated = validateGameDefinition(definition);
    const bad = {
      ...validated,
      phases: [
        {
          ...validated.phases[0],
          activity: {
            ...validated.phases[0].activity,
            config: { required: true }, // manca itemsSource e categories, richiesti da classification.validateConfig
          },
        },
      ],
    };
    expect(() => validateGameDefinitionSemantics(bad, moduleRegistry)).toThrow(GameDefinitionValidationError);
  });

  it("rifiuta un expectedCategory che non è tra le categorie dichiarate", () => {
    const validated = validateGameDefinition(definition);
    const bad = {
      ...validated,
      content: {
        ...validated.content,
        collaborators: [
          { id: "x1", label: "Test", expectedCategory: "CATEGORIA_INESISTENTE" },
        ],
      },
    };
    expect(() => validateGameDefinitionSemantics(bad, moduleRegistry)).toThrow(/non è tra le categorie/);
  });

  it("rifiuta una regola dichiarata ma non registrata in KNOWN_RULES", () => {
    const validated = validateGameDefinition(definition);
    const bad = { ...validated, rules: { classificationScoring: "regola.mai.registrata.v9" } };
    expect(() => validateGameDefinitionSemantics(bad, moduleRegistry)).toThrow(/non registrata/);
  });
});
