import { describe, it, expect, beforeAll, afterAll } from "vitest";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import type { Server } from "node:http";

const dbFile = path.join(os.tmpdir(), `spell-test-limits-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
process.env.DATABASE_URL = `file:${dbFile}`;
process.env.CONTROL_TOKEN = "test-control-token";

const { createApp } = await import("../../apps/server/src/app");
const repo = await import("../../apps/server/src/lib/repo");

const defPath = path.join(__dirname, "..", "..", "game-definitions", "less-is-more.v0.1.json");
const definitionRaw = fs.readFileSync(defPath, "utf-8");
const definition = JSON.parse(definitionRaw); // teamsMin: 2, teamsMax: 20

let server: Server;
let base: string;
const authHeaders = { Authorization: "Bearer test-control-token", "Content-Type": "application/json" };

beforeAll(async () => {
  const game = repo.upsertGame(definition.game.id, definition.game.name);
  repo.upsertGameVersion(game.id, definition.schemaVersion, definitionRaw);

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

describe("teamsMax dalla game definition (spec §9, criteri §16)", () => {
  it("rifiuta di generare più tavoli di quanti il gioco ne consenta (teamsMax: 20)", async () => {
    const sessionRes = await fetch(`${base}/api/control/sessions`, {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ gameSlug: "less-is-more", name: "test teamsMax" }),
    });
    const session = (await sessionRes.json()).data;

    const okRes = await fetch(`${base}/api/control/sessions/${session.id}/teams`, {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ count: 20 }),
    });
    expect(okRes.status).toBe(201);

    const overRes = await fetch(`${base}/api/control/sessions/${session.id}/teams`, {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ count: 1 }), // 20 già presenti + 1 supera teamsMax
    });
    expect(overRes.status).toBe(409);
    const body = await overRes.json();
    expect(body.error.code).toBe("teams_max_exceeded");
  });
});

describe("teamsMin dalla game definition (spec §9)", () => {
  it("blocca il passaggio a LOBBY sotto la soglia minima di tavoli (teamsMin: 2)", async () => {
    const sessionRes = await fetch(`${base}/api/control/sessions`, {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ gameSlug: "less-is-more", name: "test teamsMin" }),
    });
    const session = (await sessionRes.json()).data;

    await fetch(`${base}/api/control/sessions/${session.id}/teams`, {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ count: 1 }), // sotto teamsMin: 2
    });

    const lobbyRes = await fetch(`${base}/api/control/sessions/${session.id}/status`, {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ status: "LOBBY" }),
    });
    expect(lobbyRes.status).toBe(409);
    const body = await lobbyRes.json();
    expect(body.error.code).toBe("teams_min_not_reached");
  });

  it("consente LOBBY una volta raggiunta la soglia minima", async () => {
    const sessionRes = await fetch(`${base}/api/control/sessions`, {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ gameSlug: "less-is-more", name: "test teamsMin ok" }),
    });
    const session = (await sessionRes.json()).data;

    await fetch(`${base}/api/control/sessions/${session.id}/teams`, {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ count: 2 }),
    });

    const lobbyRes = await fetch(`${base}/api/control/sessions/${session.id}/status`, {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ status: "LOBBY" }),
    });
    expect(lobbyRes.status).toBe(200);
  });
});
