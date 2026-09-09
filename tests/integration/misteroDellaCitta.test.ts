import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type { Server } from "node:http";

// Verifica la game definition REALE de "Il mistero della città" (dati
// autentici della caccia al tesoro di Bologna del 2026-06-17, non un
// fixture sintetico) — costruita da game-definitions/il-mistero-della-citta.v0.1.json
// a partire dallo spreadsheet caricato dall'utente (35 tappe reali).
const dbFile = path.join(os.tmpdir(), `spell-test-mistero-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
process.env.DATABASE_URL = `file:${dbFile}`;
process.env.CONTROL_TOKEN = "test-control-token";

const { createApp } = await import("../../apps/server/src/app");
const repo = await import("../../apps/server/src/lib/repo");
const { validateGameDefinition, validateGameDefinitionSemantics } = await import(
  "../../apps/server/src/lib/gameDefinitionValidation"
);
const { moduleRegistry } = await import("../../apps/server/src/modules-registry");

const defPath = path.join(__dirname, "..", "..", "game-definitions", "il-mistero-della-citta.v0.1.json");
const definitionRaw = fs.readFileSync(defPath, "utf-8");
const rawParsed = JSON.parse(definitionRaw);

// Le 8 squadre reali, nell'ordine in cui comparivano nel foglio Squadre
// (id 1..8): l'ordine di creazione determina il numero ordinale usato per
// il matching di "groups" nel routing (vedi itineraryRouting.ts).
const REAL_TEAM_NAMES = ["Gialli", "Arancioni", "Blu", "Neri", "Viola", "Verdi", "Rossi", "Bianchi"];

let server: Server;
let base: string;
let sessionId: string;
let teamIds: string[];

async function post(pathname: string, body: unknown, token: string) {
  const res = await fetch(`${base}${pathname}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() };
}

async function get(pathname: string, token: string) {
  const res = await fetch(`${base}${pathname}`, { headers: { authorization: `Bearer ${token}` } });
  return { status: res.status, json: await res.json() };
}

beforeAll(async () => {
  const game = repo.upsertGame(rawParsed.game.id, rawParsed.game.name);
  const gameVersion = repo.upsertGameVersion(game.id, rawParsed.schemaVersion, definitionRaw);
  const session = repo.createSession(gameVersion.id, "Sessione mistero test");
  sessionId = session.id;

  teamIds = [];
  for (const name of REAL_TEAM_NAMES) {
    const team = repo.createTeam(sessionId, name, `CODE-${name.toUpperCase()}`);
    repo.ensureTeamState(team.id);
    teamIds.push(team.id);
  }

  repo.updateSessionStatus(sessionId, "LOBBY");
  repo.updateSessionStatus(sessionId, "RUNNING");
  repo.updateSessionPhase(sessionId, "percorso", "OPEN");

  const app = createApp();
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  base = `http://127.0.0.1:${port}`;
});

afterAll(() => {
  server.close();
});

describe("game definition reale: struttura e semantica", () => {
  it("valida strutturalmente (Zod) e semanticamente (moduli, punti, tappa finale)", () => {
    const def = validateGameDefinition(rawParsed);
    expect(() => validateGameDefinitionSemantics(def, moduleRegistry)).not.toThrow();
  });

  it("contiene esattamente 35 tappe reali, con i conteggi per tipo attesi", () => {
    const steps = rawParsed.content.tappe as Array<{ type: string; config: Record<string, unknown> }>;
    expect(steps).toHaveLength(35);
    const byType = (t: string) => steps.filter((s) => s.type === t).length;
    expect(byType("start")).toBe(1);
    expect(byType("finale")).toBe(1);
    expect(byType("voucher")).toBe(1);
    expect(byType("photoApproval")).toBe(12);
    expect(byType("textMatch")).toBe(20);
    const guidaCount = steps.filter((s) => s.config.kind === "guida").length;
    expect(guidaCount).toBe(4);
  });
});

describe("il mistero della città: routing con le 8 squadre reali", () => {
  it("la regia genera un percorso per tutte le 8 squadre", async () => {
    const res = await post(
      `/api/control/sessions/${sessionId}/itinerary/generate-routes`,
      { phaseId: "percorso" },
      "test-control-token"
    );
    expect(res.status).toBe(200);
    expect(res.json.data.teams).toHaveLength(8);
    for (const t of res.json.data.teams) {
      expect(t.stepsCount).toBeGreaterThan(0);
    }
  });

  it("ogni percorso inizia con la tappa start e finisce con la tappa finale", () => {
    for (const teamId of teamIds) {
      const state = JSON.parse(repo.getTeamState(teamId)!.state_json);
      const route: number[] = state.route;
      expect(route[0]).toBe(1); // tappa-1 = start (Porta San Mamolo)
      expect(route[route.length - 1]).toBe(26); // tappa-26 = finale (Ristorante Victoria)
      expect(route).toContain(28); // tappa-28 = buono (Sosta meritata)
    }
  });

  it('"groups" scopa le tappe alla squadra col numero ordinale corrispondente (1 = prima squadra creata = Gialli)', () => {
    // tappa-2 ("L'orfanotrofio") ha gruppi ["1","2"]: solo Gialli (ordinale 1)
    // e Arancioni (ordinale 2) devono trovarla nel proprio percorso.
    const routeGialli = JSON.parse(repo.getTeamState(teamIds[0])!.state_json).route as number[];
    const routeArancioni = JSON.parse(repo.getTeamState(teamIds[1])!.state_json).route as number[];
    const routeBlu = JSON.parse(repo.getTeamState(teamIds[2])!.state_json).route as number[];
    expect(routeGialli).toContain(2);
    expect(routeArancioni).toContain(2);
    expect(routeBlu).not.toContain(2);

    // tappa-19 ("Diabolik e il greco") ha gruppi ["2","4,6,8"→"2,4,6,8"]: solo
    // Arancioni(2)/Neri(4)/Verdi(6)/Bianchi(8), non Gialli(1)/Blu(3).
    const routeNeri = JSON.parse(repo.getTeamState(teamIds[3])!.state_json).route as number[];
    expect(routeArancioni).toContain(19);
    expect(routeNeri).toContain(19);
    expect(routeGialli).not.toContain(19);
    expect(routeBlu).not.toContain(19);
  });

  it("le tappe guida rispettano la distanza minima e non cadono a inizio/fine tratto centrale", () => {
    const guidaNumbers = new Set(
      (rawParsed.content.tappe as Array<{ number: number; config: Record<string, unknown> }>)
        .filter((s) => s.config.kind === "guida")
        .map((s) => s.number)
    );
    for (const teamId of teamIds) {
      const route: number[] = JSON.parse(repo.getTeamState(teamId)!.state_json).route;
      const mid = route.slice(1, route.length - 1); // tra start e finale
      const guidaPositions = mid
        .map((num, idx) => ({ num, idx }))
        .filter(({ num }) => guidaNumbers.has(num))
        .map(({ idx }) => idx);
      // prime 2 e ultime 2 posizioni del tratto centrale non sono guida
      const firstTwo = [0, 1];
      const lastTwo = [mid.length - 2, mid.length - 1];
      for (const pos of guidaPositions) {
        expect(firstTwo.includes(pos) || lastTwo.includes(pos)).toBe(false);
      }
      // distanza minima 2 tra guide consecutive
      for (let a = 0; a < guidaPositions.length; a++) {
        for (let b = a + 1; b < guidaPositions.length; b++) {
          expect(Math.abs(guidaPositions[a] - guidaPositions[b])).toBeGreaterThanOrEqual(2);
        }
      }
    }
  });
});

describe("il mistero della città: una squadra gioca con contenuti reali", () => {
  it("Gialli risponde correttamente alle prime tappe testo/guida reali e avanza con il punteggio giusto", async () => {
    const login = await post("/api/team/login", { accessCode: "CODE-GIALLI" }, "");
    expect(login.status).toBe(200);
    const token = login.json.data.token as string;

    // tappa-1 è sempre start.
    const status1 = await get("/api/team/itinerary/status", token);
    expect(status1.json.data.step.id).toBe("tappa-1");
    const submitStart = await post(
      "/api/team/itinerary/submit",
      { stepId: "tappa-1", payload: {}, idempotencyKey: "mistero-gialli-start-1" },
      token
    );
    expect(submitStart.status).toBe(201);

    // Risolve le tappe risposta-nota finché non ne troviamo una testMatch/guida
    // con risposta reale conosciuta, verificando che la normalizzazione
    // (minuscole/accenti/apostrofi) funzioni sui dati reali, non su un fixture.
    // Solo tappe che i Gialli (ordinale 1) incontrano davvero nel proprio
    // percorso: tappa-3 (gruppi "3,4") e altre riservate ad altre squadre
    // sono escluse di proposito, non dimenticate.
    const knownAnswers: Record<string, string> = {
      "tappa-7": "CONSERVO ED AUMENTO", // maiuscolo, diverso dal case originale "Conservo ed aumento" — verifica normalizzazione
      "tappa-8": "giambologna", // guida, minuscolo, diverso dal case originale "Giambologna"
      "tappa-9": "Gregorio XIII",
      "tappa-11": "voltone caccianemici", // minuscolo, diverso dal case originale "Voltone Caccianemici"
      "tappa-12": "1",
      "tappa-13": "stabat mater", // guida, minuscolo, diverso dal case originale "Stabat Mater"
    };

    // Le tappe "photoApproval" incontrate lungo il percorso di Gialli non
    // sono l'oggetto di questo test (il flusso foto/facilitatore ha il suo
    // test dedicato in itineraryFlow.test.ts) — qui vengono semplicemente
    // risolte in automatico (submit + approvazione diretta) per poter
    // proseguire fino a incontrare abbastanza tappe testo/guida scriptate,
    // invece di fermarsi alla prima foto del percorso.
    let guard = 0;
    let answeredKnownCount = 0;
    let totalExpectedPoints = 0;
    while (guard++ < 25 && answeredKnownCount < Object.keys(knownAnswers).length) {
      const status = await get("/api/team/itinerary/status", token);
      if (status.json.data.completed) break;
      const step = status.json.data.step;

      if (step.view.type === "photoApproval") {
        const submitPhoto = await post(
          "/api/team/itinerary/submit",
          { stepId: step.id, payload: { photoBase64: "data:image/jpeg;base64,QUFBQQ==" }, idempotencyKey: `mistero-gialli-photo-${step.id}` },
          token
        );
        expect(submitPhoto.status).toBe(201);
        const { decideItineraryPhoto } = await import("../../apps/server/src/lib/itineraryPipeline");
        const pending = repo.listPendingPhotos(sessionId, [teamIds[0]]);
        decideItineraryPhoto({ photoId: pending[0].id, decision: "approved", actorType: "test-setup", actorId: "auto" });
        const photoStepDef = (rawParsed.content.tappe as Array<{ id: string; points: number }>).find(
          (s) => s.id === step.id
        )!;
        totalExpectedPoints += photoStepDef.points;
        continue;
      }

      const answer = knownAnswers[step.id];
      if (!answer) {
        // Tappa testo/guida che non abbiamo scriptato: non è nel novero
        // delle verifiche di questo test, ma non deve bloccarlo — non può
        // però essere risolta "a caso" (romperebbe l'assunzione di
        // punteggio atteso), quindi qui ci fermiamo.
        break;
      }
      const submit = await post(
        "/api/team/itinerary/submit",
        { stepId: step.id, payload: { answer }, idempotencyKey: `mistero-gialli-${step.id}` },
        token
      );
      expect(submit.status).toBe(201);
      answeredKnownCount++;

      const stepDef = (rawParsed.content.tappe as Array<{ id: string; points: number }>).find(
        (s) => s.id === step.id
      )!;
      totalExpectedPoints += stepDef.points;

      const statusAfter = await get("/api/team/itinerary/status", token);
      expect(statusAfter.json.data.step?.id).not.toBe(step.id); // è avanzato
    }

    expect(answeredKnownCount).toBe(Object.keys(knownAnswers).length);
    const finalScore = JSON.parse(repo.getTeamState(teamIds[0])!.state_json).score ?? 0;
    expect(finalScore).toBe(totalExpectedPoints);
  });
});
