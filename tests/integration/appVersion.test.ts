import { describe, it, expect, beforeAll, afterAll } from "vitest";
import path from "node:path";
import os from "node:os";
import type { Server } from "node:http";

// GET /api/version (richiesto dall'utente per la pagina Regia: "ci vedo a
// che aggiornamento siamo") — pubblico come /api/games, nessun dato
// sensibile: solo il commit/messaggio dell'ultimo deploy attivo.
const dbFile = path.join(os.tmpdir(), `spell-test-version-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
process.env.DATABASE_URL = `file:${dbFile}`;

const { createApp } = await import("../../apps/server/src/app");

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

describe("GET /api/version — pubblico, per la Regia", () => {
  it("risponde senza richiedere alcun token", async () => {
    const res = await fetch(`${base}/api/version`); // nessun header Authorization
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.data).toHaveProperty("commit");
    expect(body.data).toHaveProperty("commitShort");
    expect(body.data).toHaveProperty("startedAt");
  });

  it("in un repo git (come questo, in test) espone il commit HEAD e il suo prefisso corto", async () => {
    const res = await fetch(`${base}/api/version`);
    const body = await res.json();
    // Girando dentro il repo (nessuna env RAILWAY_*), il fallback locale
    // legge `git rev-parse HEAD`: qui verifichiamo solo la FORMA (40 hex),
    // non un valore fisso, che cambierebbe a ogni commit.
    if (body.data.commit) {
      expect(body.data.commit).toMatch(/^[0-9a-f]{40}$/);
      expect(body.data.commitShort).toBe(body.data.commit.slice(0, 7));
    }
  });
});
