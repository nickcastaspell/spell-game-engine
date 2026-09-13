import { describe, it, expect, beforeAll, afterAll } from "vitest";
import path from "node:path";
import os from "node:os";
import type { Server } from "node:http";

// GET /api/games (Fase 5, landing multi-gioco): a differenza di
// GET /api/control/games, questo endpoint è PUBBLICO — nessun token,
// usato da index.html per mostrare quali cacce ospita la piattaforma.
const dbFile = path.join(os.tmpdir(), `spell-test-public-games-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
process.env.DATABASE_URL = `file:${dbFile}`;
process.env.CONTROL_TOKEN = "test-control-token";

const { createApp } = await import("../../apps/server/src/app");
const repo = await import("../../apps/server/src/lib/repo");

let server: Server;
let base: string;

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
});

describe("GET /api/games — pubblico, per la home multi-gioco", () => {
  it("elenca i giochi pubblicati senza richiedere alcun token", async () => {
    repo.upsertGame("public-games-test", "Gioco pubblico di test");

    const res = await fetch(`${base}/api/games`); // nessun header Authorization
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toContainEqual({ slug: "public-games-test", name: "Gioco pubblico di test" });
  });

  it("non espone campi sensibili (solo slug/name)", async () => {
    const res = await fetch(`${base}/api/games`);
    const body = await res.json();
    for (const g of body.data) {
      expect(Object.keys(g).sort()).toEqual(["name", "slug"]);
    }
  });
});
