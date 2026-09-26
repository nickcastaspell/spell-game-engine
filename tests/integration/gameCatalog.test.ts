import { describe, it, expect, beforeAll, afterAll } from "vitest";
import path from "node:path";
import os from "node:os";
import type { Server } from "node:http";

// Editor: elenco di tutte le cacce pubblicate (con tipo, versioni e sessioni)
// ed eliminazione; Regia: elenco sessioni con il tipo di gioco per poter
// concentrarsi su "Il mistero di…".
const dbFile = path.join(os.tmpdir(), `spell-test-catalog-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
process.env.DATABASE_URL = `file:${dbFile}`;
process.env.CONTROL_TOKEN = "test-control-token";

const { createApp } = await import("../../apps/server/src/app");
const repo = await import("../../apps/server/src/lib/repo");

let server: Server;
let base: string;
const auth = { authorization: "Bearer test-control-token", "content-type": "application/json" };

async function call(method: string, pathname: string) {
  const res = await fetch(`${base}${pathname}`, { method, headers: auth });
  return { status: res.status, json: await res.json() };
}

function publish(slug: string, name: string, phases: unknown[]) {
  const game = repo.upsertGame(slug, name);
  const gv = repo.upsertGameVersion(game.id, "0.1", JSON.stringify({ schemaVersion: "0.1", game: { id: slug, name }, phases }));
  return { game, gv };
}

beforeAll(async () => {
  const app = createApp();
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  base = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
});

afterAll(() => {
  server.close();
});

describe("elenco cacce e sessioni con tipo di gioco", () => {
  it("GET /games distingue le cacce itinerary dagli altri giochi e conta versioni/sessioni", async () => {
    const it1 = publish("cat-itinerary", "Il mistero di Test", [{ id: "p", mode: "itinerary" }]);
    publish("cat-pump", "Pompa", [{ id: "p", mode: "pump" }]);
    publish("cat-classic", "Classico", [{ id: "p", mode: "single_submission" }]);
    repo.createSession(it1.gv.id, "Sessione A");

    const res = await call("GET", "/api/control/games");
    const bySlug = Object.fromEntries(res.json.data.map((g: { slug: string }) => [g.slug, g]));
    expect(bySlug["cat-itinerary"]).toMatchObject({ type: "itinerary", versions: 1, sessions: 1 });
    expect(bySlug["cat-pump"].type).toBe("pump");
    expect(bySlug["cat-classic"].type).toBe("other");
  });

  it("GET /sessions riporta gameType, per filtrare 'Il mistero di…' in Regia", async () => {
    const res = await call("GET", "/api/control/sessions");
    const a = res.json.data.find((s: { name: string }) => s.name === "Sessione A");
    expect(a.gameType).toBe("itinerary");
  });
});

describe("DELETE /api/control/games/:slug", () => {
  it("rifiuta se la caccia ha sessioni, a meno di conferma esplicita (withSessions=true)", async () => {
    const refused = await call("DELETE", "/api/control/games/cat-itinerary");
    expect(refused.status).toBe(409);
    expect(refused.json.error.code).toBe("game_has_sessions");
    expect((await call("GET", "/api/control/games")).json.data.some((g: { slug: string }) => g.slug === "cat-itinerary")).toBe(true);

    const done = await call("DELETE", "/api/control/games/cat-itinerary?withSessions=true");
    expect(done.status).toBe(200);
    expect(done.json.data).toMatchObject({ deleted: true, sessionsDeleted: 1 });

    const after = await call("GET", "/api/control/games");
    expect(after.json.data.some((g: { slug: string }) => g.slug === "cat-itinerary")).toBe(false);
    const sessions = await call("GET", "/api/control/sessions");
    expect(sessions.json.data.some((s: { name: string }) => s.name === "Sessione A")).toBe(false);
  });

  it("elimina senza conferma una caccia senza sessioni; 404 se non esiste", async () => {
    const ok = await call("DELETE", "/api/control/games/cat-classic");
    expect(ok.status).toBe(200);
    expect(ok.json.data.sessionsDeleted).toBe(0);
    expect((await call("DELETE", "/api/control/games/non-esiste")).status).toBe(404);
  });
});
