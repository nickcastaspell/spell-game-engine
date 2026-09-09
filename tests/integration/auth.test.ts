import { describe, it, expect, beforeAll, afterAll } from "vitest";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import type { Server } from "node:http";

const dbFile = path.join(os.tmpdir(), `spell-test-auth-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
process.env.DATABASE_URL = `file:${dbFile}`;
process.env.CONTROL_TOKEN = "test-control-token";

const { createApp } = await import("../../apps/server/src/app");
const repo = await import("../../apps/server/src/lib/repo");

const defPath = path.join(__dirname, "..", "..", "game-definitions", "less-is-more.v0.1.json");
const definitionRaw = fs.readFileSync(defPath, "utf-8");
const definition = JSON.parse(definitionRaw);

let server: Server;
let base: string;
let sessionId: string;
let teamAccessCode: string;

beforeAll(async () => {
  const game = repo.upsertGame(definition.game.id, definition.game.name);
  const gameVersion = repo.upsertGameVersion(game.id, definition.schemaVersion, definitionRaw);
  const session = repo.createSession(gameVersion.id, "Sessione auth test");
  sessionId = session.id;
  const team = repo.createTeam(sessionId, "Tavolo 1", "AUTH001");
  repo.ensureTeamState(team.id);
  teamAccessCode = team.access_code;

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

describe("autorizzazione regia", () => {
  it("rifiuta senza token", async () => {
    const res = await fetch(`${base}/api/control/sessions/${sessionId}/dashboard`);
    expect(res.status).toBe(401);
  });

  it("rifiuta con token errato", async () => {
    const res = await fetch(`${base}/api/control/sessions/${sessionId}/dashboard`, {
      headers: { Authorization: "Bearer token-sbagliato" },
    });
    expect(res.status).toBe(401);
  });

  it("accetta con il token corretto", async () => {
    const res = await fetch(`${base}/api/control/sessions/${sessionId}/dashboard`, {
      headers: { Authorization: "Bearer test-control-token" },
    });
    expect(res.status).toBe(200);
  });
});

describe("autorizzazione tavolo — un codice non dà accesso alla regia (criterio §16)", () => {
  it("il codice tavolo non è accettato come token regia", async () => {
    const res = await fetch(`${base}/api/control/sessions/${sessionId}/dashboard`, {
      headers: { Authorization: `Bearer ${teamAccessCode}` },
    });
    expect(res.status).toBe(401);
  });

  it("login con codice valido restituisce un token; le rotte tavolo richiedono quel token", async () => {
    const loginRes = await fetch(`${base}/api/team/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ accessCode: teamAccessCode }),
    });
    expect(loginRes.status).toBe(200);
    const loginBody = await loginRes.json();
    const token = loginBody.data.token;

    const stateRes = await fetch(`${base}/api/team/state`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(stateRes.status).toBe(200);
  });

  it("un nuovo login sullo stesso tavolo revoca il token precedente (un dispositivo per tavolo, criterio §16)", async () => {
    const login1 = await fetch(`${base}/api/team/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ accessCode: teamAccessCode }),
    });
    const token1 = (await login1.json()).data.token;

    const login2 = await fetch(`${base}/api/team/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ accessCode: teamAccessCode }),
    });
    const token2 = (await login2.json()).data.token;

    const res1 = await fetch(`${base}/api/team/state`, { headers: { Authorization: `Bearer ${token1}` } });
    const res2 = await fetch(`${base}/api/team/state`, { headers: { Authorization: `Bearer ${token2}` } });

    expect(res1.status).toBe(401); // il vecchio token è stato revocato dal takeover
    expect(res2.status).toBe(200);
  });

  it("codice tavolo inesistente viene rifiutato", async () => {
    const res = await fetch(`${base}/api/team/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ accessCode: "NONESISTE" }),
    });
    expect(res.status).toBe(404);
  });
});
