/**
 * Simulazione con tavoli virtuali (spec §19.10, criteri §16).
 * Avvia il server su una porta effimera, crea una sessione con 20 tavoli,
 * li fa entrare, apre la fase, e invia submission concorrenti da tutti,
 * verificando che il flusso regga senza perdite o doppioni.
 *
 * Uso: npm run simulate
 */
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import crypto from "node:crypto";

const dbFile = path.join(os.tmpdir(), `spell-simulate-${Date.now()}.db`);
process.env.DATABASE_URL = `file:${dbFile}`;
process.env.CONTROL_TOKEN = "sim-token";

const TEAM_COUNT = 20;

async function main() {
  const { createApp } = await import("../../apps/server/src/app");
  const repo = await import("../../apps/server/src/lib/repo");

  const defPath = path.join(__dirname, "..", "..", "game-definitions", "less-is-more.v0.1.json");
  const definitionRaw = fs.readFileSync(defPath, "utf-8");
  const definition = JSON.parse(definitionRaw);
  repo.upsertGame(definition.game.id, definition.game.name);
  repo.upsertGameVersion(
    repo.getGameBySlug(definition.game.id)!.id,
    definition.schemaVersion,
    definitionRaw
  );

  const app = createApp();
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  const base = `http://127.0.0.1:${port}`;
  const controlAuth = { Authorization: "Bearer sim-token", "Content-Type": "application/json" };

  const log = (msg: string) => console.log(`[simulate] ${msg}`);

  try {
    const sessionRes = await fetch(`${base}/api/control/sessions`, {
      method: "POST",
      headers: controlAuth,
      body: JSON.stringify({ gameSlug: "less-is-more", name: "Simulazione 20 tavoli" }),
    });
    const session = (await sessionRes.json()).data;
    log(`sessione creata: ${session.id}`);

    const teamsRes = await fetch(`${base}/api/control/sessions/${session.id}/teams`, {
      method: "POST",
      headers: controlAuth,
      body: JSON.stringify({ count: TEAM_COUNT }),
    });
    const teams = (await teamsRes.json()).data;
    assert(teams.length === TEAM_COUNT, `attesi ${TEAM_COUNT} tavoli, trovati ${teams.length}`);
    log(`${teams.length} tavoli generati`);

    await fetch(`${base}/api/control/sessions/${session.id}/status`, {
      method: "POST",
      headers: controlAuth,
      body: JSON.stringify({ status: "LOBBY" }),
    });
    await fetch(`${base}/api/control/sessions/${session.id}/status`, {
      method: "POST",
      headers: controlAuth,
      body: JSON.stringify({ status: "RUNNING" }),
    });
    await fetch(`${base}/api/control/sessions/${session.id}/phase`, {
      method: "POST",
      headers: controlAuth,
      body: JSON.stringify({ action: "open", phaseId: "conoscere" }),
    });
    log("sessione RUNNING, fase 'conoscere' aperta");

    // Login concorrente di tutti i tavoli.
    const logins = await Promise.all(
      teams.map((t: { accessCode: string }) =>
        fetch(`${base}/api/team/login`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ accessCode: t.accessCode }),
        }).then((r) => r.json())
      )
    );
    assert(
      logins.every((l) => l.ok),
      "tutti i login dovrebbero avere successo"
    );
    log("tutti i tavoli connessi");

    // Submission concorrenti (ogni tavolo invia in parallelo, come in aula).
    const submissions = await Promise.all(
      logins.map((l) =>
        fetch(`${base}/api/team/submissions`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${l.data.token}` },
          body: JSON.stringify({
            activityId: "classify-collaborators",
            idempotencyKey: crypto.randomUUID(),
            payload: {
              assignments: { c1: "A", c2: "B", c3: "A", c4: "C", c5: "B", c6: "D" },
            },
          }),
        }).then((r) => r.json())
      )
    );
    assert(
      submissions.every((s) => s.ok),
      "tutte le submission dovrebbero essere accettate"
    );
    log("tutte le submission accettate");

    // Un secondo tentativo con NUOVA idempotencyKey deve essere rifiutato
    // (un solo invio attivo, criterio §16), non silenziosamente duplicato.
    const dup = await fetch(`${base}/api/team/submissions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${logins[0].data.token}` },
      body: JSON.stringify({
        activityId: "classify-collaborators",
        idempotencyKey: crypto.randomUUID(),
        payload: { assignments: { c1: "A", c2: "B", c3: "A", c4: "C", c5: "B", c6: "D" } },
      }),
    });
    assert(dup.status === 409, "una seconda submission diversa deve essere rifiutata con 409");
    log("duplicato correttamente rifiutato (409)");

    const dashboardRes = await fetch(`${base}/api/control/sessions/${session.id}/dashboard`, {
      headers: controlAuth,
    });
    const dashboard = (await dashboardRes.json()).data;
    assert(dashboard.submittedCount === TEAM_COUNT, `submittedCount atteso ${TEAM_COUNT}, trovato ${dashboard.submittedCount}`);
    assert(dashboard.allSubmitted === true, "allSubmitted dovrebbe essere true");
    assert(
      dashboard.teams.every((t: { score: number }) => t.score === 60),
      "ogni tavolo dovrebbe avere punteggio 60 (6 corrette * 10 punti)"
    );
    log(`dashboard coerente: ${dashboard.submittedCount}/${dashboard.totalTeams} invii, punteggio 60 per tutti`);

    log("SIMULAZIONE COMPLETATA — tutti i controlli superati");
  } finally {
    server.close();
  }
}

function assert(cond: boolean, msg: string) {
  if (!cond) {
    console.error(`[simulate] FALLITO: ${msg}`);
    process.exitCode = 1;
    throw new Error(msg);
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
