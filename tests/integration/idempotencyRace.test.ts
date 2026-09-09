import { describe, it, expect, beforeAll, afterAll } from "vitest";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import crypto from "node:crypto";
import type { Server } from "node:http";

// v5.1 §1-2: la race condition sull'idempotenza e il riuso della chiave
// dopo una riapertura si verificano solo sul confine HTTP reale (il
// codice applicativo è interamente sincrono — vedi nota nel test di
// concorrenza sotto), quindi qui si usa un server vero su porta effimera,
// non chiamate dirette alle funzioni.

const dbFile = path.join(os.tmpdir(), `spell-test-race-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
process.env.DATABASE_URL = `file:${dbFile}`;
process.env.CONTROL_TOKEN = "test-control-token";

const { createApp } = await import("../../apps/server/src/app");
const repo = await import("../../apps/server/src/lib/repo");

const defPath = path.join(__dirname, "..", "..", "game-definitions", "less-is-more.v0.1.json");
const definitionRaw = fs.readFileSync(defPath, "utf-8");
const definition = JSON.parse(definitionRaw);

let server: Server;
let base: string;
const authHeaders = { Authorization: "Bearer test-control-token", "Content-Type": "application/json" };

async function setUpRunningSessionWithOneTeam(name: string) {
  const sessionRes = await fetch(`${base}/api/control/sessions`, {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify({ gameSlug: "less-is-more", name }),
  });
  const session = (await sessionRes.json()).data;
  const teamsRes = await fetch(`${base}/api/control/sessions/${session.id}/teams`, {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify({ count: 10 }),
  });
  const teams = (await teamsRes.json()).data;
  await fetch(`${base}/api/control/sessions/${session.id}/status`, {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify({ status: "LOBBY" }),
  });
  await fetch(`${base}/api/control/sessions/${session.id}/status`, {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify({ status: "RUNNING" }),
  });
  await fetch(`${base}/api/control/sessions/${session.id}/phase`, {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify({ action: "open", phaseId: "conoscere" }),
  });
  const loginRes = await fetch(`${base}/api/team/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ accessCode: teams[0].accessCode }),
  });
  const login = (await loginRes.json()).data;
  return { sessionId: session.id, teamId: teams[0].id, token: login.token };
}

const payloadA = { assignments: { c1: "A", c2: "B", c3: "A", c4: "C", c5: "B", c6: "D" } };
const payloadB = { assignments: { c1: "D", c2: "D", c3: "D", c4: "D", c5: "D", c6: "D" } };

beforeAll(async () => {
  repo.upsertGame(definition.game.id, definition.game.name);
  repo.upsertGameVersion(
    repo.getGameBySlug(definition.game.id)!.id,
    definition.schemaVersion,
    definitionRaw
  );

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

describe("v5.1 §1 — race condition sulla idempotencyKey", () => {
  it("due submission concorrenti con la stessa chiave ma payload diversi: una sola accettata, l'altra 409", async () => {
    const { token } = await setUpRunningSessionWithOneTeam("race test");
    const key = crypto.randomUUID();

    const submit = (payload: unknown) =>
      fetch(`${base}/api/team/submissions`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ activityId: "classify-collaborators", idempotencyKey: key, payload }),
      });

    // NOTA: l'intera pipeline (submitTeamActivity) è sincrona (nessun
    // `await` interno reale) — Node non la interrompe mai a metà, quindi
    // anche con due richieste HTTP avviate "in parallelo" la seconda non
    // può mai vedere il database nello stato intermedio in cui si basa il
    // ramo di race (cattura del vincolo UNIQUE in submissionPipeline.ts).
    // Il test verifica comunque la garanzia OSSERVABILE richiesta — è
    // corretta per costruzione indipendentemente da quale dei due rami
    // (il controllo iniziale o quello di race) la applica, perché in
    // v5.1 chiamano entrambi la stessa funzione (resolveIdempotentReplay).
    const [r1, r2] = await Promise.allSettled([submit(payloadA), submit(payloadB)]);

    const responses = [r1, r2].map((r) => (r.status === "fulfilled" ? r.value : null));
    const statuses = await Promise.all(responses.map((r) => r?.status ?? 0));

    const successCount = statuses.filter((s) => s === 200 || s === 201).length;
    const conflictCount = statuses.filter((s) => s === 409).length;

    expect(successCount).toBe(1);
    expect(conflictCount).toBe(1);
  });

  it("due submission concorrenti con la stessa chiave e LO STESSO payload: entrambe accettate come replay dello stesso invio", async () => {
    const { token } = await setUpRunningSessionWithOneTeam("race test same payload");
    const key = crypto.randomUUID();

    const submit = () =>
      fetch(`${base}/api/team/submissions`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ activityId: "classify-collaborators", idempotencyKey: key, payload: payloadA }),
      });

    const [r1, r2] = await Promise.all([submit(), submit()]);
    expect([200, 201]).toContain(r1.status);
    expect([200, 201]).toContain(r2.status);

    const b1 = await r1.json();
    const b2 = await r2.json();
    expect(b1.data.submissionId).toBe(b2.data.submissionId);
  });
});

describe("v5.1 §2 — riuso della idempotencyKey dopo una riapertura", () => {
  it("submission accettata -> riapertura -> reinvio con la vecchia chiave -> 409 submission_reopened", async () => {
    const { sessionId, teamId, token } = await setUpRunningSessionWithOneTeam("reopen key reuse test");
    const key = crypto.randomUUID();

    const first = await fetch(`${base}/api/team/submissions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ activityId: "classify-collaborators", idempotencyKey: key, payload: payloadA }),
    });
    expect(first.status).toBe(201);

    await fetch(`${base}/api/control/sessions/${sessionId}/phase`, {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ action: "reopen_team", phaseId: "conoscere", teamId }),
    });

    const reuse = await fetch(`${base}/api/team/submissions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ activityId: "classify-collaborators", idempotencyKey: key, payload: payloadA }),
    });
    expect(reuse.status).toBe(409);
    const body = await reuse.json();
    expect(body.error.code).toBe("submission_reopened");

    // La chiave NUOVA invece funziona normalmente.
    const retry = await fetch(`${base}/api/team/submissions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        activityId: "classify-collaborators",
        idempotencyKey: crypto.randomUUID(),
        payload: payloadA,
      }),
    });
    expect(retry.status).toBe(201);
  });
});
