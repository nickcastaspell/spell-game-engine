import { describe, it, expect, beforeAll, afterAll } from "vitest";
import path from "node:path";
import os from "node:os";
import type { Server } from "node:http";

// Richieste dell'utente sul flusso giocatore/regia: esito di ogni invio
// (per la pagina "risposta esatta"/"corretto entro N metri"), stato della
// foto (in attesa: non va rimandata), buono visibile dopo la tappa bar, e
// COMPLETED non selezionabile finché il percorso è aperto.
const dbFile = path.join(os.tmpdir(), `spell-test-feedback-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
process.env.DATABASE_URL = `file:${dbFile}`;
process.env.CONTROL_TOKEN = "test-control-token";

const { createApp } = await import("../../apps/server/src/app");
const repo = await import("../../apps/server/src/lib/repo");

const definition = {
  schemaVersion: "0.1",
  game: { id: "feedback-fixture", name: "Fixture feedback", defaultLocale: "it" },
  roles: ["control", "team", "facilitator"],
  settings: { teamsMin: 1, teamsMax: 10, oneDevicePerTeam: true, showLeaderboard: false },
  phases: [
    {
      id: "percorso",
      title: "Percorso",
      mode: "itinerary",
      itinerary: { stepsSource: "tappe", routing: {}, maxPhotoAttempts: 2, hintPenalty: 5 },
      completion: { type: "each_team_at_own_pace" },
    },
  ],
  content: {
    tappe: [
      { id: "t-start", number: 1, type: "start", title: "Start", body: "", config: {}, points: 0 },
      { id: "t-quiz", number: 2, type: "textMatch", title: "Quiz", body: "?", config: { expectedAnswer: "Bologna" }, points: 10 },
      { id: "t-geo", number: 3, type: "geoAnswer", title: "Piazza", body: "", config: { lat: 44.4939, lng: 11.3427, toleranceMeters: 100 }, points: 15 },
      { id: "t-foto", number: 4, type: "photoApproval", title: "Foto", body: "", config: {}, points: 20 },
      { id: "t-buono", number: 5, type: "voucher", title: "Bar", body: "", config: {}, points: 0 },
      { id: "t-finale", number: 6, type: "finale", title: "Arrivo", body: "", config: {}, points: 0 },
    ],
  },
  rules: {},
};

const controlAuth = "test-control-token";
let server: Server;
let base: string;
let sessionId: string;
let teamToken: string;
let teamId: string;
let keyCounter = 0;

async function call(method: string, pathname: string, token: string, body?: unknown) {
  const res = await fetch(`${base}${pathname}`, {
    method,
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() };
}

async function submit(stepId: string, payload: Record<string, unknown>) {
  return call("POST", "/api/team/itinerary/submit", teamToken, {
    stepId,
    payload,
    idempotencyKey: `feedback-key-${++keyCounter}-${Math.random().toString(36).slice(2)}`,
  });
}

async function status() {
  return (await call("GET", "/api/team/itinerary/status", teamToken)).json.data;
}

beforeAll(async () => {
  const game = repo.upsertGame(definition.game.id, definition.game.name);
  const gv = repo.upsertGameVersion(game.id, definition.schemaVersion, JSON.stringify(definition));
  const session = repo.createSession(gv.id, "Sessione feedback");
  sessionId = session.id;
  const team = repo.createTeam(sessionId, "Tavolo 1", "FEEDBK");
  teamId = team.id;
  repo.ensureTeamState(team.id);
  repo.updateSessionStatus(sessionId, "LOBBY");
  repo.updateSessionStatus(sessionId, "RUNNING");
  repo.updateSessionPhase(sessionId, "percorso", "OPEN");

  const app = createApp();
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  base = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;

  // Percorso deterministico (la generazione mescola le tappe centrali).
  await call("POST", `/api/control/sessions/${sessionId}/itinerary/generate-routes`, controlAuth, { phaseId: "percorso" });
  await call("PUT", `/api/control/sessions/${sessionId}/itinerary/teams/${teamId}/route`, controlAuth, {
    phaseId: "percorso",
    sequence: [1, 2, 3, 4, 5, 6],
  });
  const login = await fetch(`${base}/api/team/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ accessCode: "FEEDBK" }),
  });
  teamToken = (await login.json()).data.token;
});

afterAll(() => {
  server.close();
});

describe("esito di ogni invio (pagina di feedback lato giocatore)", () => {
  it("start avanza; risposta sbagliata NON avanza e lo dice; risposta esatta avanza con i punti", async () => {
    const start = await submit("t-start", {});
    expect(start.json.data.advanced).toBe(true);

    const wrong = await submit("t-quiz", { answer: "Milano" });
    expect(wrong.status).toBe(201);
    expect(wrong.json.data.advanced).toBe(false);
    expect(wrong.json.data.stepResult.esito).toBe("errato");

    const right = await submit("t-quiz", { answer: "bologna" });
    expect(right.json.data.advanced).toBe(true);
    expect(right.json.data.pointsAwarded).toBe(10);
    expect(right.json.data.stepResult.esito).toBe("corretto");
  });

  it("geoAnswer corretto riporta la distanza in metri (\"corretto entro N metri\")", async () => {
    // ~10 m a nord del punto atteso, dentro la tolleranza di 100 m
    const res = await submit("t-geo", { lat: 44.49399, lng: 11.3427 });
    expect(res.json.data.advanced).toBe(true);
    expect(res.json.data.stepResult.esito).toBe("corretto");
    expect(res.json.data.stepResult.distanzaMetri).toBeGreaterThan(0);
    expect(res.json.data.stepResult.distanzaMetri).toBeLessThanOrEqual(100);
  });
});

describe("tappa foto: stato in attesa e buono dopo la tappa bar", () => {
  it("prima dell'invio la foto non ha stato; dopo l'invio è 'pending' (il client non mostra più il form)", async () => {
    const before = await status();
    expect(before.step.id).toBe("t-foto");
    expect(before.step.photo.status).toBeNull();
    expect(before.step.photo.attemptsLeft).toBe(2);

    const sent = await submit("t-foto", { photoBase64: "data:image/png;base64,iVBORw0KGgo=" });
    expect(sent.json.data.advanced).toBe(false);
    expect(sent.json.data.stepResult.esito).toBe("in_attesa");

    const after = await status();
    expect(after.step.id).toBe("t-foto");
    expect(after.step.photo.status).toBe("pending");
    expect(after.step.photo.attemptsLeft).toBe(1);
  });

  it("dopo il rifiuto la foto risulta 'rejected' (si può riprovare); dopo l'approvazione la squadra avanza", async () => {
    const pending = repo.listPendingPhotos(sessionId);
    expect(pending).toHaveLength(1);
    await call("POST", `/api/control/sessions/${sessionId}/itinerary/photos/${pending[0].id}/decide`, controlAuth, {
      decision: "rejected",
    });
    expect((await status()).step.photo.status).toBe("rejected");

    await submit("t-foto", { photoBase64: "data:image/png;base64,iVBORw0KGgo=" });
    const second = repo.listPendingPhotos(sessionId);
    await call("POST", `/api/control/sessions/${sessionId}/itinerary/photos/${second[0].id}/decide`, controlAuth, {
      decision: "approved",
    });
    expect((await status()).step.id).toBe("t-buono");
  });

  it("il buono compare tra i buoni della squadra subito dopo la tappa bar (e resta dopo un ricaricamento)", async () => {
    expect((await status()).vouchers).toEqual([]);
    const res = await submit("t-buono", {});
    expect(res.json.data.voucherToken).toBeTruthy();

    const after = await status();
    expect(after.vouchers).toEqual([{ stepId: "t-buono", token: res.json.data.voucherToken }]);
  });
});

describe("COMPLETED non selezionabile finché il percorso è aperto", () => {
  it("rifiuta COMPLETED con la fase aperta, lo accetta dopo aver chiuso il percorso", async () => {
    const blocked = await call("POST", `/api/control/sessions/${sessionId}/status`, controlAuth, { status: "COMPLETED" });
    expect(blocked.status).toBe(409);
    expect(blocked.json.error.code).toBe("phase_still_open");

    const closed = await call("POST", `/api/control/sessions/${sessionId}/phase`, controlAuth, {
      action: "close",
      phaseId: "percorso",
    });
    expect(closed.status).toBe(200);

    const ok = await call("POST", `/api/control/sessions/${sessionId}/status`, controlAuth, { status: "COMPLETED" });
    expect(ok.status).toBe(200);
    expect(ok.json.data.status).toBe("COMPLETED");
  });
});

describe("nome della sessione sempre disponibile alla squadra", () => {
  it("GET /api/team/state espone sessionName", async () => {
    const res = await call("GET", "/api/team/state", teamToken);
    expect(res.json.data.sessionName).toBe("Sessione feedback");
  });
});
