import { describe, it, expect, beforeAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// DATABASE_URL va impostata PRIMA di importare qualunque modulo server
// (lib/db.ts apre la connessione al caricamento). Usiamo un file in
// os.tmpdir() perché, in ambienti con la cartella di lavoro montata via
// FUSE/rete, SQLite non riesce a prendere i lock necessari (vedi README).
const dbFile = path.join(os.tmpdir(), `spell-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
process.env.DATABASE_URL = `file:${dbFile}`;
process.env.CONTROL_TOKEN = "test-token";

const repo = await import("../../apps/server/src/lib/repo");
const { submitTeamActivity, reopenTeamSubmission } = await import("../../apps/server/src/lib/submissionPipeline");
import "../../apps/server/src/modules-registry"; // registra il modulo classification

const defPath = path.join(__dirname, "..", "..", "game-definitions", "less-is-more.v0.1.json");
const definitionRaw = fs.readFileSync(defPath, "utf-8");
const definition = JSON.parse(definitionRaw);

let sessionId: string;
let teamAId: string;
let teamBId: string;
let teamCId: string;
let teamDId: string;

beforeAll(() => {
  const game = repo.upsertGame(definition.game.id, definition.game.name);
  const gameVersion = repo.upsertGameVersion(game.id, definition.schemaVersion, definitionRaw);
  const session = repo.createSession(gameVersion.id, "Sessione di test");
  sessionId = session.id;

  const teamA = repo.createTeam(sessionId, "Tavolo A", "CODEAAA");
  const teamB = repo.createTeam(sessionId, "Tavolo B", "CODEBBB");
  const teamC = repo.createTeam(sessionId, "Tavolo C", "CODECCC");
  const teamD = repo.createTeam(sessionId, "Tavolo D", "CODEDDD");
  teamAId = teamA.id;
  teamBId = teamB.id;
  teamCId = teamC.id;
  teamDId = teamD.id;
  repo.ensureTeamState(teamAId);
  repo.ensureTeamState(teamBId);
  repo.ensureTeamState(teamCId);
  repo.ensureTeamState(teamDId);

  repo.updateSessionStatus(sessionId, "LOBBY");
  repo.updateSessionStatus(sessionId, "RUNNING");
  repo.updateSessionPhase(sessionId, "conoscere", "OPEN");
});

const validPayload = {
  assignments: { c1: "A", c2: "B", c3: "A", c4: "C", c5: "B", c6: "D" },
};

describe("submitTeamActivity — regole di base", () => {
  it("accetta una submission valida e calcola il punteggio corretto", async () => {
    const result = await submitTeamActivity({
      sessionId,
      teamId: teamAId,
      activityId: "classify-collaborators",
      payload: validPayload,
      idempotencyKey: "key-teamA-1",
    });
    expect(result.status).toBe("accepted");
    expect(result.replay).toBe(false);

    const state = repo.getTeamState(teamAId)!;
    const parsed = JSON.parse(state.state_json);
    expect(parsed.score).toBe(60); // 6 corrette * 10 punti (tutte le expectedCategory del fixture combaciano)
  });

  it("rifiuta una submission incompleta senza modificare lo stato (criterio §16)", async () => {
    const stateBefore = repo.getTeamState(teamBId)!;
    await expect(
      submitTeamActivity({
        sessionId,
        teamId: teamBId,
        activityId: "classify-collaborators",
        payload: { assignments: { c1: "A" } }, // mancano elementi
        idempotencyKey: "key-teamB-incomplete",
      })
    ).rejects.toThrow();
    const stateAfter = repo.getTeamState(teamBId)!;
    expect(stateAfter.state_json).toBe(stateBefore.state_json);
    expect(stateAfter.version).toBe(stateBefore.version);
  });
});

describe("idempotenza", () => {
  it("una idempotencyKey ripetuta non produce due effetti", async () => {
    const first = await submitTeamActivity({
      sessionId,
      teamId: teamBId,
      activityId: "classify-collaborators",
      payload: validPayload,
      idempotencyKey: "key-teamB-1",
    });
    const second = await submitTeamActivity({
      sessionId,
      teamId: teamBId,
      activityId: "classify-collaborators",
      payload: validPayload,
      idempotencyKey: "key-teamB-1",
    });
    expect(second.submissionId).toBe(first.submissionId);
    expect(second.replay).toBe(true);

    const submissions = repo.listAcceptedSubmissionsForTeam(sessionId, teamBId);
    expect(submissions.filter((s) => s.idempotency_key === "key-teamB-1")).toHaveLength(1);
  });

  it("la stessa idempotencyKey con un payload DIVERSO viene rifiutata, non trattata come replay", async () => {
    // "key-teamB-1" è già stata usata nel test precedente con validPayload.
    await expect(
      submitTeamActivity({
        sessionId,
        teamId: teamBId,
        activityId: "classify-collaborators",
        payload: { assignments: { c1: "D", c2: "D", c3: "D", c4: "D", c5: "D", c6: "D" } },
        idempotencyKey: "key-teamB-1",
      })
    ).rejects.toThrow(/payload diverso/);
  });

  it("un secondo invio con chiave diversa per la stessa attività viene rifiutato (un solo invio attivo)", async () => {
    await expect(
      submitTeamActivity({
        sessionId,
        teamId: teamBId,
        activityId: "classify-collaborators",
        payload: validPayload,
        idempotencyKey: "key-teamB-2",
      })
    ).rejects.toThrow(/già presente/);
  });
});

describe("riapertura regia (criterio §16)", () => {
  it("dopo la riapertura, il tavolo può inviare di nuovo", async () => {
    const reopened = await reopenTeamSubmission(sessionId, teamBId, "classify-collaborators");
    expect(reopened).toBe(1);

    const result = await submitTeamActivity({
      sessionId,
      teamId: teamBId,
      activityId: "classify-collaborators",
      payload: validPayload,
      idempotencyKey: "key-teamB-after-reopen",
    });
    expect(result.status).toBe("accepted");
  });

  it("il punteggio NON si accumula tra invio originale e invio dopo la riapertura (bug corretto)", async () => {
    const first = await submitTeamActivity({
      sessionId,
      teamId: teamCId,
      activityId: "classify-collaborators",
      payload: validPayload, // tutte corrette -> 60 punti
      idempotencyKey: "key-teamC-1",
    });
    expect(first.status).toBe("accepted");
    expect(JSON.parse(repo.getTeamState(teamCId)!.state_json).score).toBe(60);

    await reopenTeamSubmission(sessionId, teamCId, "classify-collaborators");

    // Dopo la riapertura, senza ancora un nuovo invio, lo stato ricostruito
    // dalle sole submission accettate non deve più contenere né il
    // punteggio né gli assignment della submission riaperta.
    const afterReopen = JSON.parse(repo.getTeamState(teamCId)!.state_json);
    expect(afterReopen.score ?? 0).toBe(0);
    expect(afterReopen.classifications).toBeUndefined();

    // Solo 2 assegnazioni corrette su 6 -> 20 punti attesi, non 60+20=80.
    const secondPayload = {
      assignments: { c1: "A", c2: "B", c3: "B", c4: "D", c5: "A", c6: "A" },
    };
    const second = await submitTeamActivity({
      sessionId,
      teamId: teamCId,
      activityId: "classify-collaborators",
      payload: secondPayload,
      idempotencyKey: "key-teamC-2",
    });
    expect(second.status).toBe("accepted");
    const finalState = JSON.parse(repo.getTeamState(teamCId)!.state_json);
    expect(finalState.score).toBe(20);

    // Il punteggio deve restare spiegabile sommando i score_event (criterio
    // §16): 60 (primo invio) - 60 (compensazione alla riapertura) + 20
    // (nuovo invio) = 20, uguale allo stato corrente.
    const { db: rawDb } = await import("../../apps/server/src/lib/db");
    const rows = rawDb
      .prepare("SELECT amount FROM score_event WHERE team_id = ? ORDER BY rowid ASC")
      .all(teamCId) as { amount: number }[];
    const totalFromEvents = rows.reduce((sum, r) => sum + r.amount, 0);
    expect(totalFromEvents).toBe(20);
    expect(rows.map((r) => r.amount)).toEqual([60, -60, 20]);
  });
});

describe("stato base del tavolo (v5.1 §3)", () => {
  it("il rebuild alla riapertura preserva lo stato base, non riparte da {}", async () => {
    // Simula una fase futura che assegna risorse iniziali non prodotte da
    // nessuna submission (es. ore disponibili di un round).
    repo.setBaseState(teamDId, JSON.stringify({ availableHours: 20 }));

    const beforeSubmit = JSON.parse(repo.getTeamState(teamDId)!.state_json);
    expect(beforeSubmit.availableHours).toBe(20);

    await submitTeamActivity({
      sessionId,
      teamId: teamDId,
      activityId: "classify-collaborators",
      payload: validPayload,
      idempotencyKey: "key-teamD-1",
    });

    const afterSubmit = JSON.parse(repo.getTeamState(teamDId)!.state_json);
    expect(afterSubmit.availableHours).toBe(20); // invariato dalla submission
    expect(afterSubmit.score).toBe(60);
    expect(afterSubmit.classifications).toBeDefined();

    await reopenTeamSubmission(sessionId, teamDId, "classify-collaborators");

    const afterReopen = JSON.parse(repo.getTeamState(teamDId)!.state_json);
    expect(afterReopen.classifications).toBeUndefined(); // la submission riaperta non conta più
    expect(afterReopen.score ?? 0).toBe(0);
    expect(afterReopen.availableHours).toBe(20); // la base NON sparisce col rebuild
  });
});

describe("ripresa dopo riavvio (criterio §16)", () => {
  it("i dati restano leggibili riaprendo una nuova connessione allo stesso file sqlite", async () => {
    const { db: freshDb } = await import("../../apps/server/src/lib/db");
    const row = freshDb.prepare("SELECT * FROM team_state WHERE team_id = ?").get(teamAId) as { state_json: string };
    const parsed = JSON.parse(row.state_json);
    expect(parsed.score).toBe(60);
  });
});
