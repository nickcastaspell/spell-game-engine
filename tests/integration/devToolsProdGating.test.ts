import { describe, it, expect, beforeAll, afterAll } from "vitest";
import path from "node:path";
import os from "node:os";
import type { Server } from "node:http";

// Il punto di questo file: con NODE_ENV=production le route /api/dev/*
// non devono esistere affatto (404 generico), non solo essere nascoste
// nella UI regia — vedi app.ts (mount condizionale di devRouter).
const previousNodeEnv = process.env.NODE_ENV;
process.env.NODE_ENV = "production";

const dbFile = path.join(
  os.tmpdir(),
  `spell-test-devtools-prod-${Date.now()}-${Math.random().toString(36).slice(2)}.db`
);
process.env.DATABASE_URL = `file:${dbFile}`;
process.env.CONTROL_TOKEN = "test-control-token";

const { createApp } = await import("../../apps/server/src/app");
const repo = await import("../../apps/server/src/lib/repo");

let server: Server;
let base: string;
const authHeaders = { Authorization: "Bearer test-control-token", "Content-Type": "application/json" };

beforeAll(async () => {
  const app = createApp();
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  base = `http://127.0.0.1:${port}`;
});

afterAll(() => {
  server.close();
  process.env.NODE_ENV = previousNodeEnv;
});

describe("strumenti dev assenti in produzione (NODE_ENV=production)", () => {
  it("GET /api/dev/sessions risponde 404, non 401 — la route non è montata", async () => {
    const res = await fetch(`${base}/api/dev/sessions`, { headers: authHeaders });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error.code).toBe("not_found");
  });

  it("POST /api/dev/sessions/:id/reset risponde 404 anche con un id qualsiasi", async () => {
    const res = await fetch(`${base}/api/dev/sessions/whatever/reset`, {
      method: "POST",
      headers: authHeaders,
    });
    expect(res.status).toBe(404);
  });

  it("DELETE /api/dev/sessions/:id risponde 404", async () => {
    const res = await fetch(`${base}/api/dev/sessions/whatever`, {
      method: "DELETE",
      headers: authHeaders,
    });
    expect(res.status).toBe(404);
  });
});

describe("GET /api/control/sessions funziona anche in produzione (bug reale: senza questo, chi crea una sessione e lascia la pagina non la ritrova più)", () => {
  it("elenca una sessione appena creata, pur con /api/dev/* assente", async () => {
    const game = repo.upsertGame("prod-gating-game", "Gioco per test produzione");
    const definition = {
      schemaVersion: "0.1",
      game: { id: "prod-gating-game", name: "Gioco per test produzione", defaultLocale: "it" },
      roles: ["control", "team"],
      settings: { teamsMin: 1, teamsMax: 5, oneDevicePerTeam: true, showLeaderboard: false },
      phases: [
        {
          id: "fase-1",
          title: "Fase 1",
          mode: "single_submission",
          activity: { id: "att-1", type: "classification", title: "Att 1", config: { itemsSource: "x", categories: ["a"] } },
          completion: { type: "manual" },
        },
      ],
      content: {},
      rules: {},
    };
    const gameVersion = repo.upsertGameVersion(game.id, definition.schemaVersion, JSON.stringify(definition));
    const session = repo.createSession(gameVersion.id, "Sessione da ritrovare");

    const res = await fetch(`${base}/api/control/sessions`, { headers: authHeaders });
    expect(res.status).toBe(200);
    const body = await res.json();
    const found = body.data.find((s: { id: string }) => s.id === session.id);
    expect(found).toBeDefined();
    expect(found.name).toBe("Sessione da ritrovare");
    expect(found.gameSlug).toBe("prod-gating-game");
  });

  it("richiede comunque il token regia (401 senza, non un elenco vuoto)", async () => {
    const res = await fetch(`${base}/api/control/sessions`);
    expect(res.status).toBe(401);
  });
});
