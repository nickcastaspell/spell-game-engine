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
