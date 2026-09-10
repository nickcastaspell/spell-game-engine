import { describe, it, expect, beforeAll, afterAll } from "vitest";
import path from "node:path";
import os from "node:os";
import type { Server } from "node:http";

// Stesso pattern di itineraryFlow.test.ts: DB temporaneo, server reale su
// porta effimera, richieste HTTP reali. Copre le Fasi 5 (mappa
// anti-spoiler nella risposta di team/itinerary/status) e 6 (overview
// regia + galleria foto) — non ripetute in itineraryFlow.test.ts per non
// gonfiare ulteriormente quel file, che ha già una fixture grande.
const dbFile = path.join(os.tmpdir(), `spell-test-map-gallery-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
process.env.DATABASE_URL = `file:${dbFile}`;
process.env.CONTROL_TOKEN = "test-control-token";

const { createApp } = await import("../../apps/server/src/app");
const repo = await import("../../apps/server/src/lib/repo");

function buildDefinition(gameId: string, showUpcomingStops: boolean) {
  return {
    schemaVersion: "0.1",
    game: { id: gameId, name: `Fixture ${gameId}`, defaultLocale: "it" },
    roles: ["control", "team", "facilitator"],
    settings: { teamsMin: 1, teamsMax: 5, oneDevicePerTeam: true, showLeaderboard: false },
    phases: [
      {
        id: "percorso",
        title: "Percorso",
        mode: "itinerary",
        itinerary: { stepsSource: "tappe", routing: {}, maxPhotoAttempts: 3, hintPenalty: 5, showUpcomingStops },
        completion: { type: "each_team_at_own_pace" },
      },
    ],
    content: {
      tappe: [
        { id: "t1", number: 1, type: "start", title: "Partenza", body: "", config: { lat: 44.49, lng: 11.34 }, points: 0 },
        {
          id: "t2",
          number: 2,
          type: "textMatch",
          title: "Tappa segreta",
          body: "?",
          config: { expectedAnswer: "x", lat: 44.491, lng: 11.341 },
          points: 10,
        },
        { id: "t3", number: 3, type: "photoApproval", title: "Foto di gruppo", body: "", config: { lat: 44.492, lng: 11.342 }, points: 20 },
        { id: "t4", number: 4, type: "finale", title: "Arrivo", body: "", config: { lat: 44.493, lng: 11.343 }, points: 0 },
      ],
    },
    rules: {},
  };
}

let server: Server;
let base: string;
let hiddenSessionId: string;
let visibleSessionId: string;

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

function setUpSession(gameId: string, showUpcomingStops: boolean, accessCodes: string[]): string {
  const def = buildDefinition(gameId, showUpcomingStops);
  const game = repo.upsertGame(def.game.id, def.game.name);
  const gameVersion = repo.upsertGameVersion(game.id, def.schemaVersion, JSON.stringify(def));
  const session = repo.createSession(gameVersion.id, `Sessione ${gameId}`);
  for (const [i, code] of accessCodes.entries()) {
    const team = repo.createTeam(session.id, `Tavolo ${i + 1}`, code);
    repo.ensureTeamState(team.id);
  }
  repo.updateSessionStatus(session.id, "LOBBY");
  repo.updateSessionStatus(session.id, "RUNNING");
  repo.updateSessionPhase(session.id, "percorso", "OPEN");
  return session.id;
}

beforeAll(async () => {
  const app = createApp();
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  base = `http://127.0.0.1:${port}`;

  hiddenSessionId = setUpSession("map-hidden", false, ["MAPHID1", "MAPHID2"]);
  visibleSessionId = setUpSession("map-visible", true, ["MAPVIS1"]);

  const { generateAndAssignRoutes } = await import("../../apps/server/src/lib/itineraryPipeline");
  generateAndAssignRoutes(hiddenSessionId, "percorso");
  generateAndAssignRoutes(visibleSessionId, "percorso");
});

afterAll(() => {
  server.close();
});

describe("Fase 5: mappa del tavolo — route anti-spoiler in /api/team/itinerary/status", () => {
  it("con showUpcomingStops assente (default false), le tappe future non hanno titolo né coordinate", async () => {
    const login = await post("/api/team/login", { accessCode: "MAPHID1" }, "");
    const token = login.json.data.token as string;

    const status = await get("/api/team/itinerary/status", token);
    expect(status.status).toBe(200);
    const route = status.json.data.route as Array<{ number: number; status: string; lat: number | null; lng: number | null; title?: string }>;
    expect(route).toHaveLength(4);

    const current = route.find((r) => r.status === "current")!;
    expect(current.title).toBeDefined();
    expect(current.lat).not.toBeNull();

    const upcoming = route.filter((r) => r.status === "upcoming");
    expect(upcoming.length).toBeGreaterThan(0);
    for (const r of upcoming) {
      expect(r.title).toBeUndefined();
      expect(r.lat).toBeNull();
      expect(r.lng).toBeNull();
    }
  });

  it("le tappe già completate diventano 'done' e restano visibili con titolo e coordinate", async () => {
    const login = await post("/api/team/login", { accessCode: "MAPHID2" }, "");
    const token = login.json.data.token as string;

    const before = await get("/api/team/itinerary/status", token);
    const firstStepId = before.json.data.step.id;
    await post("/api/team/itinerary/submit", { stepId: firstStepId, payload: {}, idempotencyKey: "map-hid2-start" }, token);

    const after = await get("/api/team/itinerary/status", token);
    const route = after.json.data.route as Array<{ status: string; title?: string; lat: number | null }>;
    const done = route.filter((r) => r.status === "done");
    expect(done.length).toBeGreaterThanOrEqual(1);
    for (const r of done) {
      expect(r.title).toBeDefined();
      expect(r.lat).not.toBeNull();
    }
  });

  it("con showUpcomingStops: true, le tappe future mostrano titolo e coordinate", async () => {
    const login = await post("/api/team/login", { accessCode: "MAPVIS1" }, "");
    const token = login.json.data.token as string;

    const status = await get("/api/team/itinerary/status", token);
    const route = status.json.data.route as Array<{ status: string; title?: string; lat: number | null }>;
    const upcoming = route.filter((r) => r.status === "upcoming");
    expect(upcoming.length).toBeGreaterThan(0);
    for (const r of upcoming) {
      expect(r.title).toBeDefined();
      expect(r.lat).not.toBeNull();
    }
  });
});

describe("Fase 6: overview regia e galleria foto", () => {
  it("l'overview mostra solo la tappa CORRENTE di ogni squadra, non l'intero percorso", async () => {
    const res = await get(`/api/control/sessions/${hiddenSessionId}/itinerary/overview?phaseId=percorso`, "test-control-token");
    expect(res.status).toBe(200);
    expect(res.json.data).toHaveLength(2);
    for (const entry of res.json.data) {
      expect(entry.completed).toBe(false);
      expect(entry.currentStep).not.toBeNull();
      expect(typeof entry.currentStep.title).toBe("string");
      expect(entry.currentStep.lat).not.toBeNull();
      // Non deve esporre l'intero percorso della squadra.
      expect(entry.sequence).toBeUndefined();
      expect(entry.route).toBeUndefined();
    }
  });

  it("la galleria mostra tutte le foto della sessione, filtrabili per stato", async () => {
    const login = await post("/api/team/login", { accessCode: "MAPHID1" }, "");
    const token = login.json.data.token as string;

    // Porta la squadra (già avanzata di una tappa dal test precedente) fino
    // alla tappa foto, inviando due foto (una verrà rigettata, una approvata).
    let status = await get("/api/team/itinerary/status", token);
    for (let guard = 0; guard < 10 && status.json.data.step?.view.type !== "photoApproval"; guard++) {
      const step = status.json.data.step;
      const payload = step.view.type === "textMatch" ? { answer: "x" } : {};
      await post("/api/team/itinerary/submit", { stepId: step.id, payload, idempotencyKey: `gallery-setup-${guard}` }, token);
      status = await get("/api/team/itinerary/status", token);
    }
    expect(status.json.data.step.view.type).toBe("photoApproval");
    const photoStepId = status.json.data.step.id;

    await post(
      "/api/team/itinerary/submit",
      { stepId: photoStepId, payload: { photoBase64: "data:image/jpeg;base64,QUFBQQ==" }, idempotencyKey: "gallery-photo-1" },
      token
    );
    await post(
      "/api/team/itinerary/submit",
      { stepId: photoStepId, payload: { photoBase64: "data:image/jpeg;base64,QkJCQg==" }, idempotencyKey: "gallery-photo-2" },
      token
    );

    const pending = repo.listPhotosForSession(hiddenSessionId, "pending");
    expect(pending.length).toBeGreaterThanOrEqual(2);
    const { decideItineraryPhoto } = await import("../../apps/server/src/lib/itineraryPipeline");
    decideItineraryPhoto({ photoId: pending[0].id, decision: "rejected", actorType: "control", actorId: "regia" });
    decideItineraryPhoto({ photoId: pending[1].id, decision: "approved", actorType: "control", actorId: "regia" });

    const all = await get(`/api/control/sessions/${hiddenSessionId}/itinerary/photos`, "test-control-token");
    expect(all.status).toBe(200);
    const statuses = all.json.data.map((p: { status: string }) => p.status);
    expect(statuses).toContain("rejected");
    expect(statuses).toContain("approved");

    const onlyApproved = await get(`/api/control/sessions/${hiddenSessionId}/itinerary/photos?status=approved`, "test-control-token");
    expect(onlyApproved.json.data.every((p: { status: string }) => p.status === "approved")).toBe(true);
    expect(onlyApproved.json.data.length).toBeGreaterThanOrEqual(1);
  });
});

describe("interfaccia facilitatore: overview e galleria scoped alle proprie squadre", () => {
  it("GET /api/facilitator/overview vede solo le squadre assegnate", async () => {
    const teams = repo.listTeams(hiddenSessionId);
    const team1 = teams.find((t) => t.access_code === "MAPHID1")!;

    const created = await post(
      `/api/control/sessions/${hiddenSessionId}/facilitators`,
      { name: "Facilitatore scoped", teamIds: [team1.id] },
      "test-control-token"
    );
    const facToken = created.json.data.token as string;

    const overview = await get("/api/facilitator/overview", facToken);
    expect(overview.status).toBe(200);
    expect(overview.json.data).toHaveLength(1);
    expect(overview.json.data[0].teamId).toBe(team1.id);
    // Non deve esporre l'intero percorso, solo la tappa corrente (stesso
    // principio dell'overview regia — non spoilerare le altre squadre).
    expect(overview.json.data[0].sequence).toBeUndefined();
  });

  it("un facilitatore senza squadre assegnate vede tutta la sessione (elenco vuoto = tutte)", async () => {
    const created = await post(
      `/api/control/sessions/${hiddenSessionId}/facilitators`,
      { name: "Facilitatore generico", teamIds: [] },
      "test-control-token"
    );
    const facToken = created.json.data.token as string;

    const overview = await get("/api/facilitator/overview", facToken);
    expect(overview.status).toBe(200);
    expect(overview.json.data.length).toBe(repo.listTeams(hiddenSessionId).length);
  });

  it("GET /api/facilitator/photos mostra solo le foto delle proprie squadre", async () => {
    const teams = repo.listTeams(hiddenSessionId);
    const team1 = teams.find((t) => t.access_code === "MAPHID1")!; // ha foto (test precedente)
    const team2 = teams.find((t) => t.access_code === "MAPHID2")!; // nessuna foto

    const facForTeam1 = await post(
      `/api/control/sessions/${hiddenSessionId}/facilitators`,
      { name: "Fac team1", teamIds: [team1.id] },
      "test-control-token"
    );
    const galleryTeam1 = await get("/api/facilitator/photos", facForTeam1.json.data.token);
    expect(galleryTeam1.status).toBe(200);
    expect(galleryTeam1.json.data.length).toBeGreaterThan(0);
    expect(galleryTeam1.json.data.every((p: { teamId: string }) => p.teamId === team1.id)).toBe(true);

    const facForTeam2 = await post(
      `/api/control/sessions/${hiddenSessionId}/facilitators`,
      { name: "Fac team2", teamIds: [team2.id] },
      "test-control-token"
    );
    const galleryTeam2 = await get("/api/facilitator/photos", facForTeam2.json.data.token);
    expect(galleryTeam2.json.data).toHaveLength(0);
  });
});
