import { describe, it, expect, beforeAll, afterAll } from "vitest";
import path from "node:path";
import os from "node:os";
import type { Server } from "node:http";

// Stesso pattern di auth.test.ts: DB temporaneo su file (non nella cartella
// di lavoro montata via FUSE, dove SQLite non prende i lock), server reale
// su porta effimera, richieste con fetch nativo — copre l'intero percorso
// REST (routes/team.ts, routes/control.ts, routes/facilitator.ts,
// itineraryPipeline.ts) invece delle sole funzioni interne, cosa che
// itineraryRouting.test.ts (solo l'algoritmo puro) non copre.
const dbFile = path.join(os.tmpdir(), `spell-test-itinerary-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
process.env.DATABASE_URL = `file:${dbFile}`;
process.env.CONTROL_TOKEN = "test-control-token";

const { createApp } = await import("../../apps/server/src/app");
const repo = await import("../../apps/server/src/lib/repo");

// Game definition sintetica (non i dati reali di Bologna, vedi task
// "il-mistero-della-citta.v0.1.json" a parte): un percorso breve ma con
// tutti i tipi di tappa reali (start, textMatch testo, textMatch guida,
// photoApproval, voucher, finale), per esercitare l'intera pipeline
// itinerary end-to-end.
const definition = {
  schemaVersion: "0.1",
  game: { id: "itinerary-fixture", name: "Fixture itinerario", defaultLocale: "it" },
  roles: ["control", "team", "facilitator"],
  settings: { teamsMin: 1, teamsMax: 10, oneDevicePerTeam: true, showLeaderboard: false },
  phases: [
    {
      id: "percorso",
      title: "Percorso",
      mode: "itinerary",
      itinerary: {
        stepsSource: "tappe",
        routing: { minGuideDistance: 1 },
        maxPhotoAttempts: 2,
        hintPenalty: 5,
      },
      completion: { type: "each_team_at_own_pace" },
    },
  ],
  content: {
    tappe: [
      { id: "t-start", number: 1, type: "start", title: "Start", body: "", config: { lat: 44.493, lng: 11.342 }, points: 0 },
      {
        id: "t-quiz",
        number: 2,
        type: "textMatch",
        title: "Quiz",
        body: "In che città siamo?",
        config: { expectedAnswer: "Bologna", kind: "testo", lat: 44.4935, lng: 11.3425 },
        points: 10,
        hint: "È una città dell'Emilia-Romagna",
      },
      {
        id: "t-guida",
        number: 3,
        type: "textMatch",
        title: "Guida",
        body: "Chiedi alla guida il nome della torre",
        config: { expectedAnswer: "Asinelli", kind: "guida", lat: 44.4938, lng: 11.343 },
        points: 5,
      },
      {
        id: "t-foto",
        number: 4,
        type: "photoApproval",
        title: "Foto di gruppo",
        body: "",
        config: { lat: 44.4942, lng: 11.3432 },
        points: 20,
      },
      {
        id: "t-buono",
        number: 5,
        type: "voucher",
        title: "Buono bar",
        body: "",
        config: { lat: 44.4945, lng: 11.3429 },
        points: 0,
      },
      {
        id: "t-geo",
        number: 6,
        type: "geoAnswer",
        title: "Piazza Maggiore",
        body: "Raggiungete il centro di Piazza Maggiore e inviate la vostra posizione",
        // Coordinate reali (Piazza Maggiore, Bologna); tolleranza volutamente
        // stretta per poter testare anche il caso "fuori tolleranza" con un
        // punto a poche decine di metri di distanza.
        config: { lat: 44.4939, lng: 11.3427, toleranceMeters: 30 },
        points: 15,
      },
      {
        id: "t-finale",
        number: 7,
        type: "finale",
        title: "Arrivo",
        body: "",
        config: { lat: 44.495, lng: 11.3435 },
        points: 0,
      },
    ],
  },
  rules: {},
};
const definitionRaw = JSON.stringify(definition);

// Risposta attesa per le tappe textMatch, con case diverso da quello in
// config per verificare che la normalizzazione (minuscole/accenti) funzioni.
const expectedAnswerByStepId: Record<string, string> = {
  "t-quiz": "Bologna",
  "t-guida": "asinelli",
};

// Stesse coordinate di config.lat/lng della tappa "t-geo" sopra: una
// submission con questo payload è sempre "esattamente corretta" (distanza
// 0), usata dagli helper generici per superare la tappa senza dover
// conoscere il dettaglio del test corrente.
const geoAnswerByStepId: Record<string, { lat: number; lng: number }> = {
  "t-geo": { lat: 44.4939, lng: 11.3427 },
};

let server: Server;
let base: string;
let sessionId: string;
let teamAId: string;
let teamBId: string;

async function post(pathname: string, body: unknown, token: string) {
  const res = await fetch(`${base}${pathname}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() };
}

async function get(pathname: string, token: string) {
  const res = await fetch(`${base}${pathname}`, { headers: { authorization: `Bearer ${token}` } });
  return { status: res.status, json: await res.json() };
}

async function put(pathname: string, body: unknown, token: string) {
  const res = await fetch(`${base}${pathname}`, {
    method: "PUT",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() };
}

/**
 * Invia la tappa corrente con un payload "banale ma corretto", per farla
 * avanzare senza dover conoscere in anticipo la config del modulo: usata
 * dagli helper qui sotto per superare tappe che non sono l'oggetto del
 * test corrente. Le tappe "foto" incontrate qui vengono approvate subito
 * (bypassando l'HTTP del facilitatore: quel flusso ha un proprio test
 * dedicato più sotto) — altrimenti bloccherebbero l'avanzamento per
 * sempre, dato che l'esito di una foto è differito a una decisione
 * dell'operatore.
 */
async function resolveStepGenerically(
  token: string,
  step: { id: string; view: { type: string } },
  idemPrefix: string
): Promise<void> {
  if (step.view.type === "start" || step.view.type === "voucher" || step.view.type === "finale") {
    await post("/api/team/itinerary/submit", { stepId: step.id, payload: {}, idempotencyKey: `${idemPrefix}-${step.id}` }, token);
    return;
  }
  if (step.view.type === "textMatch") {
    const answer = expectedAnswerByStepId[step.id];
    await post(
      "/api/team/itinerary/submit",
      { stepId: step.id, payload: { answer }, idempotencyKey: `${idemPrefix}-${step.id}` },
      token
    );
    return;
  }
  if (step.view.type === "geoAnswer") {
    const position = geoAnswerByStepId[step.id];
    await post(
      "/api/team/itinerary/submit",
      { stepId: step.id, payload: position, idempotencyKey: `${idemPrefix}-${step.id}` },
      token
    );
    return;
  }
  if (step.view.type === "photoApproval") {
    await post(
      "/api/team/itinerary/submit",
      { stepId: step.id, payload: { photoBase64: "data:image/jpeg;base64,QUFBQQ==" }, idempotencyKey: `${idemPrefix}-${step.id}` },
      token
    );
    const { decideItineraryPhoto } = await import("../../apps/server/src/lib/itineraryPipeline");
    const pending = repo.listPendingPhotos(sessionId).filter((p) => p.step_id === step.id && p.status === "pending");
    const latest = pending[pending.length - 1];
    decideItineraryPhoto({ photoId: latest.id, decision: "approved", actorType: "test-setup", actorId: "auto" });
    return;
  }
  throw new Error(`resolveStepGenerically: tipo di tappa non gestito "${step.view.type}"`);
}

/**
 * Fa avanzare la squadra (risolvendo genericamente ogni tappa intermedia,
 * vedi sopra) finché la tappa CORRENTE non è quella richiesta, e la
 * restituisce senza inviarla — il chiamante decide cosa testare su di
 * essa. Necessario perché l'ordine delle tappe senza "block" ruota per
 * squadra (vedi itineraryRouting.ts): un test non può assumere che una
 * data tappa sia la prima/seconda/ecc. per una squadra qualunque.
 */
async function advanceUntilStepId(
  token: string,
  targetStepId: string,
  idemPrefix: string
): Promise<{ id: string; view: { type: string }; hasHint: boolean }> {
  for (let guard = 0; guard < 20; guard++) {
    const status = await get("/api/team/itinerary/status", token);
    if (status.json.data.completed) {
      throw new Error(`advanceUntilStepId: percorso completato prima di raggiungere "${targetStepId}"`);
    }
    const step = status.json.data.step;
    if (step.id === targetStepId) return step;
    await resolveStepGenerically(token, step, `${idemPrefix}-g${guard}`);
  }
  throw new Error(`advanceUntilStepId: limite iterazioni superato cercando "${targetStepId}"`);
}

beforeAll(async () => {
  const game = repo.upsertGame(definition.game.id, definition.game.name);
  const gameVersion = repo.upsertGameVersion(game.id, definition.schemaVersion, definitionRaw);
  const session = repo.createSession(gameVersion.id, "Sessione itinerario test");
  sessionId = session.id;

  const teamA = repo.createTeam(sessionId, "Tavolo A", "ITINAAA");
  const teamB = repo.createTeam(sessionId, "Tavolo B", "ITINBBB");
  teamAId = teamA.id;
  teamBId = teamB.id;
  repo.ensureTeamState(teamAId);
  repo.ensureTeamState(teamBId);

  repo.updateSessionStatus(sessionId, "LOBBY");
  repo.updateSessionStatus(sessionId, "RUNNING");
  repo.updateSessionPhase(sessionId, "percorso", "OPEN");

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

describe("itinerario end-to-end (REST)", () => {
  it("regia genera i percorsi per tutte le squadre della sessione", async () => {
    const res = await post(
      `/api/control/sessions/${sessionId}/itinerary/generate-routes`,
      { phaseId: "percorso" },
      "test-control-token"
    );
    expect(res.status).toBe(200);
    expect(res.json.data.teams).toHaveLength(2);
    for (const t of res.json.data.teams) {
      expect(t.stepsCount).toBe(7); // start + quiz + guida + foto + buono + geo + finale
    }
  });

  it("un tavolo porta a termine l'intero percorso rispondendo correttamente, con punteggio corretto", async () => {
    const login = await post("/api/team/login", { accessCode: "ITINAAA" }, "");
    expect(login.status).toBe(200);
    const token = login.json.data.token as string;

    let guard = 0;
    while (guard++ < 20) {
      const status = await get("/api/team/itinerary/status", token);
      expect(status.status).toBe(200);
      if (status.json.data.completed) break;
      await resolveStepGenerically(token, status.json.data.step, `flowA-run-${guard}`);
    }

    const finalStatus = await get("/api/team/itinerary/status", token);
    expect(finalStatus.json.data.completed).toBe(true);

    // 10 (quiz) + 5 (guida) + 20 (foto, approvata dall'helper) + 15 (geo, coordinate esatte) = 50, il buono non dà punti.
    const teamState = repo.getTeamState(teamAId)!;
    const parsedState = JSON.parse(teamState.state_json);
    expect(parsedState.score).toBe(50);

    const voucher = repo.findVoucherForStep(sessionId, teamAId, "t-buono");
    expect(voucher).toBeDefined();
    expect(voucher!.token.startsWith("BUO-")).toBe(true);
  });

  it("una risposta sbagliata non avanza né assegna punti, e può essere riprovata", async () => {
    const login = await post("/api/team/login", { accessCode: "ITINBBB" }, "");
    const token = login.json.data.token as string;

    const step = await advanceUntilStepId(token, "t-quiz", "flowB-setup");
    // "score prima" e non un fisso 0: la strada per arrivare a "t-quiz" può
    // aver attraversato altre tappe a punteggio (l'ordine non è fisso, vedi
    // advanceUntilStepId) — quello che conta per questo test è che una
    // risposta SBAGLIATA non cambi il punteggio rispetto a subito prima.
    const scoreBeforeAttempts = JSON.parse(repo.getTeamState(teamBId)!.state_json).score ?? 0;

    const wrongAttempt = await post(
      "/api/team/itinerary/submit",
      { stepId: step.id, payload: { answer: "risposta-sbagliata" }, idempotencyKey: "flowB-wrong-attempt-1" },
      token
    );
    expect(wrongAttempt.status).toBe(201); // la submission è accettata (è un tentativo valido), solo non corretta

    const statusAfterWrong = await get("/api/team/itinerary/status", token);
    expect(statusAfterWrong.json.data.step.id).toBe("t-quiz"); // non è avanzato

    const scoreAfterWrong = JSON.parse(repo.getTeamState(teamBId)!.state_json).score ?? 0;
    expect(scoreAfterWrong).toBe(scoreBeforeAttempts);

    const rightAttempt = await post(
      "/api/team/itinerary/submit",
      { stepId: step.id, payload: { answer: expectedAnswerByStepId["t-quiz"] }, idempotencyKey: "flowB-right-attempt-1" },
      token
    );
    expect(rightAttempt.status).toBe(201);

    const statusAfterRight = await get("/api/team/itinerary/status", token);
    expect(statusAfterRight.json.data.step.id).not.toBe("t-quiz");

    const scoreAfterRight = JSON.parse(repo.getTeamState(teamBId)!.state_json).score ?? 0;
    expect(scoreAfterRight).toBe(scoreBeforeAttempts + 10);
  });

  it("geoAnswer: una posizione entro la tolleranza avanza e assegna punti, fuori tolleranza no", async () => {
    const teamG = repo.createTeam(sessionId, "Tavolo G", "ITINGGG");
    repo.ensureTeamState(teamG.id);
    const { generateAndAssignRoutes } = await import("../../apps/server/src/lib/itineraryPipeline");
    generateAndAssignRoutes(sessionId, "percorso");

    const login = await post("/api/team/login", { accessCode: "ITINGGG" }, "");
    const token = login.json.data.token as string;

    const step = await advanceUntilStepId(token, "t-geo", "flowE-setup");
    const scoreBefore = JSON.parse(repo.getTeamState(teamG.id)!.state_json).score ?? 0;

    // ~67m a nord del punto atteso (config.lat/lng, tolleranza 30m): fuori tolleranza.
    const tooFar = await post(
      "/api/team/itinerary/submit",
      { stepId: step.id, payload: { lat: 44.4939 + 0.0006, lng: 11.3427 }, idempotencyKey: "flowE-far-1" },
      token
    );
    expect(tooFar.status).toBe(201); // tentativo accettato, solo non corretto
    const statusAfterFar = await get("/api/team/itinerary/status", token);
    expect(statusAfterFar.json.data.step.id).toBe("t-geo"); // non avanzato
    expect(JSON.parse(repo.getTeamState(teamG.id)!.state_json).score ?? 0).toBe(scoreBefore);

    // ~17m a nord del punto atteso: entro la tolleranza di 30m.
    const closeEnough = await post(
      "/api/team/itinerary/submit",
      { stepId: step.id, payload: { lat: 44.4939 + 0.00015, lng: 11.3427 }, idempotencyKey: "flowE-close-1" },
      token
    );
    expect(closeEnough.status).toBe(201);
    const statusAfterClose = await get("/api/team/itinerary/status", token);
    expect(statusAfterClose.json.data.step.id).not.toBe("t-geo");
    expect(JSON.parse(repo.getTeamState(teamG.id)!.state_json).score ?? 0).toBe(scoreBefore + 15);
  });

  it("il suggerimento penalizza il punteggio solo la prima volta per tappa", async () => {
    const teamC = repo.createTeam(sessionId, "Tavolo C", "ITINCCC");
    repo.ensureTeamState(teamC.id);
    const { generateAndAssignRoutes } = await import("../../apps/server/src/lib/itineraryPipeline");
    generateAndAssignRoutes(sessionId, "percorso");

    const login = await post("/api/team/login", { accessCode: "ITINCCC" }, "");
    const token = login.json.data.token as string;

    const step = await advanceUntilStepId(token, "t-quiz", "flowC-setup");
    expect(step.hasHint).toBe(true);

    const scoreBefore = JSON.parse(repo.getTeamState(teamC.id)!.state_json).score ?? 0;

    const hint1 = await post("/api/team/itinerary/hint", {}, token);
    expect(hint1.status).toBe(200);
    expect(hint1.json.data.alreadyUsed).toBe(false);
    expect(hint1.json.data.pointsDeducted).toBe(5);

    const hint2 = await post("/api/team/itinerary/hint", {}, token);
    expect(hint2.status).toBe(200);
    expect(hint2.json.data.alreadyUsed).toBe(true);
    expect(hint2.json.data.pointsDeducted).toBe(0);

    const scoreAfter = JSON.parse(repo.getTeamState(teamC.id)!.state_json).score ?? 0;
    expect(scoreAfter).toBe(Math.max(0, scoreBefore - 5));

    const statusAfterHint = await get("/api/team/itinerary/status", token);
    expect(statusAfterHint.json.data.step.hasHint).toBe(false);

    // La risposta corretta ora funziona normalmente, penalità già scontata una volta sola.
    const submit = await post(
      "/api/team/itinerary/submit",
      { stepId: "t-quiz", payload: { answer: expectedAnswerByStepId["t-quiz"] }, idempotencyKey: "flowC-quiz-answer-1" },
      token
    );
    expect(submit.status).toBe(201);
    const scoreAfterAnswer = JSON.parse(repo.getTeamState(teamC.id)!.state_json).score ?? 0;
    expect(scoreAfterAnswer).toBe(scoreAfter + 10);
  });

  it("foto: la regia crea facilitatori scoped, che vedono/decidono solo le foto delle proprie squadre", async () => {
    const teamD = repo.createTeam(sessionId, "Tavolo D", "ITINDDD");
    repo.ensureTeamState(teamD.id);
    const { generateAndAssignRoutes } = await import("../../apps/server/src/lib/itineraryPipeline");
    generateAndAssignRoutes(sessionId, "percorso");

    const login = await post("/api/team/login", { accessCode: "ITINDDD" }, "");
    const token = login.json.data.token as string;

    const step = await advanceUntilStepId(token, "t-foto", "flowD-setup");
    expect(step.view.type).toBe("photoApproval");

    const submitPhoto = await post(
      "/api/team/itinerary/submit",
      { stepId: "t-foto", payload: { photoBase64: "data:image/jpeg;base64,QUFBQQ==" }, idempotencyKey: "flowD-photo-attempt-1" },
      token
    );
    expect(submitPhoto.status).toBe(201);

    // Ancora fermo sulla stessa tappa: l'esito è differito.
    const statusAfterPhoto = await get("/api/team/itinerary/status", token);
    expect(statusAfterPhoto.json.data.step.id).toBe("t-foto");

    // Facilitatore scoped SOLO sul tavolo B: non deve vedere la foto di D.
    const facB = await post(
      `/api/control/sessions/${sessionId}/facilitators`,
      { name: "Elena", teamIds: [teamBId] },
      "test-control-token"
    );
    expect(facB.status).toBe(201);
    const tokenFacB = facB.json.data.token as string;

    const pendingForB = await get("/api/facilitator/photos/pending", tokenFacB);
    expect(pendingForB.json.data.find((p: { teamId: string }) => p.teamId === teamD.id)).toBeUndefined();

    // Facilitatore scoped sul tavolo D: la vede.
    const facD = await post(
      `/api/control/sessions/${sessionId}/facilitators`,
      { name: "Mauro", teamIds: [teamD.id] },
      "test-control-token"
    );
    const tokenFacD = facD.json.data.token as string;

    const pendingForD = await get("/api/facilitator/photos/pending", tokenFacD);
    expect(pendingForD.json.data).toHaveLength(1);
    const photoId = pendingForD.json.data[0].id;
    expect(pendingForD.json.data[0].teamId).toBe(teamD.id);

    // Il facilitatore B (non scoped su D) non può decidere questa foto.
    const forbiddenDecision = await post(`/api/facilitator/photos/${photoId}/decide`, { decision: "approved" }, tokenFacB);
    expect(forbiddenDecision.status).toBe(403);

    const scoreBefore = JSON.parse(repo.getTeamState(teamD.id)!.state_json).score ?? 0;

    const approve = await post(`/api/facilitator/photos/${photoId}/decide`, { decision: "approved" }, tokenFacD);
    expect(approve.status).toBe(200);
    expect(approve.json.data.advanced).toBe(true);

    // Una seconda decisione sulla stessa foto è rifiutata (già decisa).
    const doubleDecision = await post(`/api/facilitator/photos/${photoId}/decide`, { decision: "approved" }, tokenFacD);
    expect(doubleDecision.status).toBe(409);

    const scoreAfter = JSON.parse(repo.getTeamState(teamD.id)!.state_json).score ?? 0;
    expect(scoreAfter).toBe(scoreBefore + 20);

    const statusAfterApproval = await get("/api/team/itinerary/status", token);
    expect(statusAfterApproval.json.data.step.id).not.toBe("t-foto");
  });

  it("la tappa finale completa il percorso e non può essere reinviata dopo il completamento", async () => {
    const teamE = repo.createTeam(sessionId, "Tavolo E", "ITINEEE");
    repo.ensureTeamState(teamE.id);
    const { generateAndAssignRoutes } = await import("../../apps/server/src/lib/itineraryPipeline");
    generateAndAssignRoutes(sessionId, "percorso");

    const login = await post("/api/team/login", { accessCode: "ITINEEE" }, "");
    const token = login.json.data.token as string;

    const step = await advanceUntilStepId(token, "t-finale", "flowE-setup");

    const submitFinale = await post(
      "/api/team/itinerary/submit",
      { stepId: step.id, payload: {}, idempotencyKey: "flowE-finale-attempt-1" },
      token
    );
    expect(submitFinale.status).toBe(201);

    const statusAfterFinale = await get("/api/team/itinerary/status", token);
    expect(statusAfterFinale.json.data.completed).toBe(true);
    expect(statusAfterFinale.json.data.step).toBeNull();

    const resubmit = await post(
      "/api/team/itinerary/submit",
      { stepId: "t-finale", payload: {}, idempotencyKey: "flowE-finale-attempt-2" },
      token
    );
    expect(resubmit.status).toBe(409);
  });

  it("il limite tentativi foto blocca ulteriori invii oltre maxPhotoAttempts", async () => {
    const teamF = repo.createTeam(sessionId, "Tavolo F", "ITINFFF");
    repo.ensureTeamState(teamF.id);
    const { generateAndAssignRoutes, decideItineraryPhoto } = await import("../../apps/server/src/lib/itineraryPipeline");
    generateAndAssignRoutes(sessionId, "percorso");

    const login = await post("/api/team/login", { accessCode: "ITINFFF" }, "");
    const token = login.json.data.token as string;

    const step = await advanceUntilStepId(token, "t-foto", "flowF-setup");

    // maxPhotoAttempts è 2 nella fixture: due invii vanno bene, il terzo no.
    const attempt1 = await post(
      "/api/team/itinerary/submit",
      { stepId: step.id, payload: { photoBase64: "data:image/jpeg;base64,QUFBQQ==" }, idempotencyKey: "flowF-photo-attempt-1" },
      token
    );
    expect(attempt1.status).toBe(201);

    // Un operatore rigetta il primo tentativo, per permettere un secondo invio.
    const pendingAfter1 = repo.listPendingPhotos(sessionId, [teamF.id]);
    expect(pendingAfter1).toHaveLength(1);
    decideItineraryPhoto({ photoId: pendingAfter1[0].id, decision: "rejected", actorType: "control", actorId: "regia" });

    const attempt2 = await post(
      "/api/team/itinerary/submit",
      { stepId: step.id, payload: { photoBase64: "data:image/jpeg;base64,QUJDRA==" }, idempotencyKey: "flowF-photo-attempt-2" },
      token
    );
    expect(attempt2.status).toBe(201);

    const attempt3 = await post(
      "/api/team/itinerary/submit",
      { stepId: step.id, payload: { photoBase64: "data:image/jpeg;base64,WFlaWFla" }, idempotencyKey: "flowF-photo-attempt-3" },
      token
    );
    expect(attempt3.status).toBe(409);
  });

  describe("regia: dettaglio e override manuale del percorso squadra (Fase 4)", () => {
    it("GET .../route restituisce sequenza, dettaglio tappe e distanza prevista", async () => {
      const teamH = repo.createTeam(sessionId, "Tavolo H", "ITINHHH");
      repo.ensureTeamState(teamH.id);
      const { generateAndAssignRoutes } = await import("../../apps/server/src/lib/itineraryPipeline");
      generateAndAssignRoutes(sessionId, "percorso");

      const res = await get(
        `/api/control/sessions/${sessionId}/itinerary/teams/${teamH.id}/route?phaseId=percorso`,
        "test-control-token"
      );
      expect(res.status).toBe(200);
      expect(res.json.data.sequence).toHaveLength(7);
      expect(new Set(res.json.data.sequence)).toEqual(new Set([1, 2, 3, 4, 5, 6, 7]));
      expect(res.json.data.position).toBe(1);
      expect(res.json.data.missingCoords).toEqual([]); // tutte le tappe della fixture hanno lat/lng ora
      expect(res.json.data.distanceMeters).toBeGreaterThan(0);
      expect(res.json.data.steps).toHaveLength(7);
      expect(res.json.data.steps[0].number).toBe(res.json.data.sequence[0]);
    });

    it("PUT .../route accetta un riordino completo se la squadra non ha ancora iniziato", async () => {
      const teamI = repo.createTeam(sessionId, "Tavolo I", "ITINIII");
      repo.ensureTeamState(teamI.id);
      const { generateAndAssignRoutes } = await import("../../apps/server/src/lib/itineraryPipeline");
      generateAndAssignRoutes(sessionId, "percorso");

      const before = await get(
        `/api/control/sessions/${sessionId}/itinerary/teams/${teamI.id}/route?phaseId=percorso`,
        "test-control-token"
      );
      const reversed = [...before.json.data.sequence].reverse();

      const res = await put(
        `/api/control/sessions/${sessionId}/itinerary/teams/${teamI.id}/route`,
        { phaseId: "percorso", sequence: reversed },
        "test-control-token"
      );
      expect(res.status).toBe(200);
      expect(res.json.data.sequence).toEqual(reversed);

      // Il tavolo la vede subito (state_json.route, non solo base_state_json).
      const login = await post("/api/team/login", { accessCode: "ITINIII" }, "");
      const token = login.json.data.token as string;
      const status = await get("/api/team/itinerary/status", token);
      const firstStepNumber = reversed[0];
      const stepFromDefinition = definition.content.tappe.find((t) => t.number === firstStepNumber)!;
      expect(status.json.data.step.title).toBe(stepFromDefinition.title);
    });

    it("PUT .../route rifiuta un percorso con tappe mancanti/duplicate", async () => {
      const teamJ = repo.createTeam(sessionId, "Tavolo J", "ITINJJJ");
      repo.ensureTeamState(teamJ.id);
      const { generateAndAssignRoutes } = await import("../../apps/server/src/lib/itineraryPipeline");
      generateAndAssignRoutes(sessionId, "percorso");

      const duplicated = await put(
        `/api/control/sessions/${sessionId}/itinerary/teams/${teamJ.id}/route`,
        { phaseId: "percorso", sequence: [1, 1, 2, 3, 4, 5, 6] },
        "test-control-token"
      );
      expect(duplicated.status).toBe(400);

      const incomplete = await put(
        `/api/control/sessions/${sessionId}/itinerary/teams/${teamJ.id}/route`,
        { phaseId: "percorso", sequence: [1, 2, 3] },
        "test-control-token"
      );
      expect(incomplete.status).toBe(400);
    });

    it("PUT .../route rifiuta un riordino che cambia l'ordine delle tappe già completate", async () => {
      const teamK = repo.createTeam(sessionId, "Tavolo K", "ITINKKK");
      repo.ensureTeamState(teamK.id);
      const { generateAndAssignRoutes } = await import("../../apps/server/src/lib/itineraryPipeline");
      generateAndAssignRoutes(sessionId, "percorso");

      const login = await post("/api/team/login", { accessCode: "ITINKKK" }, "");
      const token = login.json.data.token as string;

      // "start" avanza da solo solo quando qualcuno la invia (è team.html a
      // farlo in automatico, non il semplice GET status): qui la inviamo
      // esplicitamente per far avanzare la squadra di una tappa.
      const before = await get(
        `/api/control/sessions/${sessionId}/itinerary/teams/${teamK.id}/route?phaseId=percorso`,
        "test-control-token"
      );
      const firstStepId = definition.content.tappe.find((t) => t.number === before.json.data.sequence[0])!.id;
      await post(
        "/api/team/itinerary/submit",
        { stepId: firstStepId, payload: {}, idempotencyKey: "flowK-start-1" },
        token
      );

      const afterStart = await get(
        `/api/control/sessions/${sessionId}/itinerary/teams/${teamK.id}/route?phaseId=percorso`,
        "test-control-token"
      );
      expect(afterStart.json.data.position).toBe(2); // già avanzata oltre la prima tappa

      const sequence = afterStart.json.data.sequence as number[];
      // Scambia la prima tappa (già completata) con l'ultima: il prefisso già
      // fatto cambierebbe, deve essere rifiutato.
      const swapped = [sequence[sequence.length - 1], ...sequence.slice(1, -1), sequence[0]];
      const rejected = await put(
        `/api/control/sessions/${sessionId}/itinerary/teams/${teamK.id}/route`,
        { phaseId: "percorso", sequence: swapped },
        "test-control-token"
      );
      expect(rejected.status).toBe(409);
      expect(rejected.json.error.code).toBe("route_prefix_mismatch");

      // Riordinare solo le tappe ANCORA DAVANTI (tutte tranne la prima) è invece permesso.
      const onlyFutureReordered = [sequence[0], ...sequence.slice(1).reverse()];
      const accepted = await put(
        `/api/control/sessions/${sessionId}/itinerary/teams/${teamK.id}/route`,
        { phaseId: "percorso", sequence: onlyFutureReordered },
        "test-control-token"
      );
      expect(accepted.status).toBe(200);
      expect(accepted.json.data.sequence).toEqual(onlyFutureReordered);
    });
  });
});
