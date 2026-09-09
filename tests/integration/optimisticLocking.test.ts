import { describe, it, expect, beforeAll } from "vitest";
import path from "node:path";
import os from "node:os";

// v5.1 §4: la scrittura di team_state durante il rebuild (riapertura)
// deve rispettare la stessa optimistic locking usata altrove (spec §13),
// non sostituire lo stato "alla cieca". Qui si verifica direttamente il
// meccanismo condiviso (updateTeamStateWithVersionCheck), usato sia dal
// flusso di submission normale sia da reopenTeamSubmission: una versione
// scaduta deve fallire, non sovrascrivere silenziosamente.

const dbFile = path.join(os.tmpdir(), `spell-test-lock-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
process.env.DATABASE_URL = `file:${dbFile}`;

const repo = await import("../../apps/server/src/lib/repo");

let sessionId: string;
let teamId: string;

beforeAll(async () => {
  const path2 = await import("node:path");
  const fs = await import("node:fs");
  const defPath = path2.join(__dirname, "..", "..", "game-definitions", "less-is-more.v0.1.json");
  const definitionRaw = fs.readFileSync(defPath, "utf-8");
  const definition = JSON.parse(definitionRaw);
  const game = repo.upsertGame(definition.game.id, definition.game.name);
  const gameVersion = repo.upsertGameVersion(game.id, definition.schemaVersion, definitionRaw);
  const session = repo.createSession(gameVersion.id, "sessione lock test");
  sessionId = session.id;
  const team = repo.createTeam(sessionId, "Tavolo lock", "CODELOCK");
  teamId = team.id;
  repo.ensureTeamState(teamId);
});

describe("optimistic locking su team_state (spec §13, v5.1 §4)", () => {
  it("una scrittura con la versione corrente ha successo e incrementa la versione", () => {
    const row = repo.getTeamState(teamId)!;
    expect(row.version).toBe(0);

    const ok = repo.updateTeamStateWithVersionCheck(teamId, 0, JSON.stringify({ score: 10 }));
    expect(ok).toBe(true);

    const updated = repo.getTeamState(teamId)!;
    expect(updated.version).toBe(1);
    expect(JSON.parse(updated.state_json).score).toBe(10);
  });

  it("una scrittura con una versione scaduta fallisce e NON modifica lo stato", () => {
    const before = repo.getTeamState(teamId)!;
    expect(before.version).toBe(1); // dal test precedente

    // Simula una scrittura concorrente che ha già vinto: qualcuno prova
    // ad aggiornare con la versione 0, ma la versione reale è già 1.
    const stale = repo.updateTeamStateWithVersionCheck(teamId, 0, JSON.stringify({ score: 999 }));
    expect(stale).toBe(false);

    const after = repo.getTeamState(teamId)!;
    expect(after.version).toBe(1); // invariata
    expect(JSON.parse(after.state_json).score).toBe(10); // il valore "999" non è mai stato scritto
  });

  it("reopenTeamSubmission passa davvero dalla stessa optimistic locking (verifica di cablaggio)", async () => {
    // NOTA IMPORTANTE: reopenTeamSubmission gira interamente dentro una
    // transazione sincrona (nessun `await` reale tra la lettura e la
    // scrittura della versione) — esattamente come per la race
    // sull'idempotenza (vedi idempotencyRace.test.ts), non c'è modo di
    // far avvenire una scrittura concorrente GENUINA a metà della sua
    // esecuzione senza strumentare il codice sorgente apposta per il
    // test, cosa che non vale la pena fare qui. Quello che SI PUÒ e SI
    // DEVE verificare onestamente: che reopenTeamSubmission chiami
    // davvero updateTeamStateWithVersionCheck (non una scrittura diretta
    // che la bypassa) — lo dimostriamo controllando che la versione di
    // team_state incrementi di 1 ad ogni riapertura, esattamente come
    // farebbe una qualunque altra scrittura passata dalla stessa funzione
    // (già testata in isolamento sopra).
    const { submitTeamActivity, reopenTeamSubmission } = await import(
      "../../apps/server/src/lib/submissionPipeline"
    );
    await import("../../apps/server/src/modules-registry");

    repo.updateSessionStatus(sessionId, "LOBBY");
    repo.updateSessionStatus(sessionId, "RUNNING");
    repo.updateSessionPhase(sessionId, "conoscere", "OPEN");

    await submitTeamActivity({
      sessionId,
      teamId,
      activityId: "classify-collaborators",
      payload: { assignments: { c1: "A", c2: "B", c3: "A", c4: "C", c5: "B", c6: "D" } },
      idempotencyKey: "lock-key-1",
    });

    const versionBeforeReopen = repo.getTeamState(teamId)!.version;
    await reopenTeamSubmission(sessionId, teamId, "classify-collaborators");
    const versionAfterReopen = repo.getTeamState(teamId)!.version;

    expect(versionAfterReopen).toBe(versionBeforeReopen + 1);
  });
});
