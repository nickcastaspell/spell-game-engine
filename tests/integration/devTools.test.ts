import { describe, it, expect, beforeAll, afterAll } from "vitest";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import type { Server } from "node:http";

// Forziamo esplicitamente l'ambiente "non production" per questo file,
// indipendentemente da come viene lanciato vitest altrove (spec: gli
// strumenti dev devono esistere quando NODE_ENV non è "production").
process.env.NODE_ENV = "development";

const dbFile = path.join(os.tmpdir(), `spell-test-devtools-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
process.env.DATABASE_URL = `file:${dbFile}`;
process.env.CONTROL_TOKEN = "test-control-token";

const { createApp } = await import("../../apps/server/src/app");
const repo = await import("../../apps/server/src/lib/repo");
const { db } = await import("../../apps/server/src/lib/db");
import "../../apps/server/src/modules-registry";

const defPath = path.join(__dirname, "..", "..", "game-definitions", "less-is-more.v0.1.json");
const definitionRaw = fs.readFileSync(defPath, "utf-8");
const definition = JSON.parse(definitionRaw);

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

/** Crea una sessione con `count` tavoli, pronta per essere fatta avanzare via HTTP. */
async function makeSessionWithTeams(name: string, count: number) {
  const sessionRes = await fetch(`${base}/api/control/sessions`, {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify({ gameSlug: "less-is-more", name }),
  });
  const session = (await sessionRes.json()).data;

  const teamsRes = await fetch(`${base}/api/control/sessions/${session.id}/teams`, {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify({ count }),
  });
  const teams = (await teamsRes.json()).data;
  return { sessionId: session.id as string, teams: teams as Array<{ id: string; accessCode: string }> };
}

async function setStatus(sessionId: string, status: string) {
  const res = await fetch(`${base}/api/control/sessions/${sessionId}/status`, {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify({ status }),
  });
  return res;
}

async function loginTeam(accessCode: string) {
  const res = await fetch(`${base}/api/team/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ accessCode }),
  });
  return (await res.json()).data.token as string;
}

async function submitClassification(token: string) {
  const assignments = { c1: "A", c2: "B", c3: "A", c4: "C", c5: "B", c6: "D" };
  await fetch(`${base}/api/team/submissions`, {
    method: "POST",
    headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
    body: JSON.stringify({
      activityId: "classify-collaborators",
      idempotencyKey: `key-${Math.random().toString(36).slice(2)}`,
      payload: { assignments },
    }),
  });
}

describe("archivio sessioni dev (GET /api/dev/sessions)", () => {
  it("elenca le sessioni con gioco, stato e numero tavoli", async () => {
    const { sessionId } = await makeSessionWithTeams("archivio-demo", 2);

    const res = await fetch(`${base}/api/dev/sessions`, { headers: authHeaders });
    expect(res.status).toBe(200);
    const body = await res.json();
    const found = body.data.find((s: { id: string }) => s.id === sessionId);
    expect(found).toBeTruthy();
    expect(found.gameName).toBe("Less is More");
    expect(found.status).toBe("DRAFT");
    expect(found.teamCount).toBe(2);
  });
});

describe("reset sessione (POST /api/dev/sessions/:id/reset)", () => {
  it("svuota submission/eventi, ripristina il base_state e riporta la sessione a DRAFT", async () => {
    const { sessionId, teams } = await makeSessionWithTeams("reset-demo", 2);

    // stato base non vuoto su un tavolo, per verificare che il reset
    // ripristini QUELLO e non "{}" (v5.1 §3, riusato qui).
    repo.setBaseState(teams[0].id, JSON.stringify({ availableHours: 15 }));

    await setStatus(sessionId, "LOBBY");
    await setStatus(sessionId, "RUNNING");
    await fetch(`${base}/api/control/sessions/${sessionId}/phase`, {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ action: "open", phaseId: "conoscere" }),
    });

    const token = await loginTeam(teams[0].accessCode);
    await submitClassification(token);

    // pre-condizioni: c'è una submission accettata, un punteggio, eventi
    const preSubs = repo.listAcceptedSubmissionsForTeam(sessionId, teams[0].id);
    expect(preSubs.length).toBe(1);
    const preState = repo.getTeamState(teams[0].id)!;
    expect(JSON.parse(preState.state_json).score).toBeGreaterThan(0);

    const resetRes = await fetch(`${base}/api/dev/sessions/${sessionId}/reset`, {
      method: "POST",
      headers: authHeaders,
    });
    expect(resetRes.status).toBe(200);
    const resetBody = await resetRes.json();
    expect(resetBody.data.status).toBe("DRAFT");
    expect(resetBody.data.currentPhaseId).toBeNull();

    // submission ed eventi spariti
    expect(repo.listAcceptedSubmissionsForTeam(sessionId, teams[0].id).length).toBe(0);
    const scoreCount = db
      .prepare("SELECT COUNT(*) as c FROM score_event WHERE session_id = ?")
      .get(sessionId) as { c: number };
    expect(scoreCount.c).toBe(0);
    const effectCount = db
      .prepare("SELECT COUNT(*) as c FROM effect_event WHERE session_id = ?")
      .get(sessionId) as { c: number };
    expect(effectCount.c).toBe(0);

    // team_state ripristinato al base_state, non a "{}"
    const postState = repo.getTeamState(teams[0].id)!;
    expect(JSON.parse(postState.state_json)).toEqual({ availableHours: 15 });
    expect(postState.version).toBe(0);

    // l'audit trail precedente è stato svuotato: resta solo il marker del reset
    const auditRows = db
      .prepare("SELECT action FROM audit_event WHERE session_id = ?")
      .all(sessionId) as { action: string }[];
    expect(auditRows.length).toBe(1);
    expect(auditRows[0].action).toBe("dev.session_reset");

    // i tavoli (e i loro codici) NON sono stati toccati: stesso accessCode di prima
    const teamStill = repo.getTeam(teams[0].id)!;
    expect(teamStill.access_code).toBe(teams[0].accessCode);
  });
});

describe("duplica sessione (POST /api/dev/sessions/:id/duplicate)", () => {
  it("crea una nuova sessione DRAFT con stessi tavoli/config ma senza submission/punteggi/audit", async () => {
    const { sessionId, teams } = await makeSessionWithTeams("duplica-demo", 2);
    repo.setBaseState(teams[0].id, JSON.stringify({ availableHours: 8 }));

    await setStatus(sessionId, "LOBBY");
    await setStatus(sessionId, "RUNNING");
    await fetch(`${base}/api/control/sessions/${sessionId}/phase`, {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ action: "open", phaseId: "conoscere" }),
    });
    const token = await loginTeam(teams[0].accessCode);
    await submitClassification(token);

    const dupRes = await fetch(`${base}/api/dev/sessions/${sessionId}/duplicate`, {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({}),
    });
    expect(dupRes.status).toBe(201);
    const copy = (await dupRes.json()).data;
    expect(copy.id).not.toBe(sessionId);
    expect(copy.status).toBe("DRAFT");
    expect(copy.name).toBe("duplica-demo (copy)");

    const newTeams = repo.listTeams(copy.id);
    expect(newTeams.length).toBe(2);
    // nuovi codici di accesso, non riusati da quelli originali
    const originalCodes = new Set(teams.map((t) => t.accessCode));
    for (const t of newTeams) {
      expect(originalCodes.has(t.access_code)).toBe(false);
    }
    // configurazione (base_state) portata sul tavolo corrispondente
    const newTeamWithBase = newTeams.find((t) => t.name === "Tavolo 1")!;
    const newState = repo.getTeamState(newTeamWithBase.id)!;
    expect(JSON.parse(newState.base_state_json)).toEqual({ availableHours: 8 });
    expect(JSON.parse(newState.state_json)).toEqual({ availableHours: 8 });

    // nessuna submission/punteggio/audit sulla copia
    for (const t of newTeams) {
      expect(repo.listAcceptedSubmissionsForTeam(copy.id, t.id).length).toBe(0);
    }
    const auditCount = db
      .prepare("SELECT COUNT(*) as c FROM audit_event WHERE session_id = ? AND action != 'dev.session_duplicated'")
      .get(copy.id) as { c: number };
    expect(auditCount.c).toBe(0);
  });
});

describe("elimina sessione — solo dev (DELETE /api/dev/sessions/:id)", () => {
  it("cancella sessione, tavoli, token ed eventi collegati", async () => {
    const { sessionId, teams } = await makeSessionWithTeams("elimina-demo", 2);
    await setStatus(sessionId, "LOBBY");
    await setStatus(sessionId, "RUNNING");
    await fetch(`${base}/api/control/sessions/${sessionId}/phase`, {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ action: "open", phaseId: "conoscere" }),
    });
    const token = await loginTeam(teams[0].accessCode);
    await submitClassification(token);

    const delRes = await fetch(`${base}/api/dev/sessions/${sessionId}`, {
      method: "DELETE",
      headers: authHeaders,
    });
    expect(delRes.status).toBe(200);

    expect(repo.getSession(sessionId)).toBeUndefined();
    expect(repo.listTeams(sessionId).length).toBe(0);

    const deviceCount = db
      .prepare("SELECT COUNT(*) as c FROM device_session WHERE team_id = ?")
      .get(teams[0].id) as { c: number };
    expect(deviceCount.c).toBe(0);

    const subCount = db.prepare("SELECT COUNT(*) as c FROM submission WHERE session_id = ?").get(sessionId) as {
      c: number;
    };
    expect(subCount.c).toBe(0);
  });
});

describe("riapri sessione — solo dev (POST /api/dev/sessions/:id/reopen)", () => {
  it("riporta una sessione COMPLETED a DRAFT, bypassando il lifecycle ufficiale", async () => {
    const { sessionId } = await makeSessionWithTeams("riapri-demo", 2);
    await setStatus(sessionId, "LOBBY");
    await setStatus(sessionId, "RUNNING");
    const completedRes = await setStatus(sessionId, "COMPLETED");
    expect(completedRes.status).toBe(200);

    const reopenRes = await fetch(`${base}/api/dev/sessions/${sessionId}/reopen`, {
      method: "POST",
      headers: authHeaders,
    });
    expect(reopenRes.status).toBe(200);
    const body = await reopenRes.json();
    expect(body.data.status).toBe("DRAFT");
    expect(body.data.currentPhaseId).toBeNull();
  });

  it("rifiuta la riapertura se la sessione non è COMPLETED", async () => {
    const { sessionId } = await makeSessionWithTeams("riapri-rifiutato-demo", 2);

    const reopenRes = await fetch(`${base}/api/dev/sessions/${sessionId}/reopen`, {
      method: "POST",
      headers: authHeaders,
    });
    expect(reopenRes.status).toBe(409);
    const body = await reopenRes.json();
    expect(body.error.code).toBe("dev_reopen_requires_completed");
  });
});
