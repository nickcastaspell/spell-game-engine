import { describe, it, expect, beforeAll, afterAll } from "vitest";
import path from "node:path";
import os from "node:os";
import type { Server } from "node:http";

// Stesso pattern di itineraryFlow.test.ts: DB temporaneo su file, server
// reale su porta effimera, richieste HTTP reali — copre l'intero percorso
// bozza -> pubblicazione (routes/authoring.ts, lib/repo.ts game_draft,
// lib/gameDefinitionValidation.ts), non solo le funzioni interne.
const dbFile = path.join(os.tmpdir(), `spell-test-authoring-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
process.env.DATABASE_URL = `file:${dbFile}`;
process.env.CONTROL_TOKEN = "test-control-token";

const { createApp } = await import("../../apps/server/src/app");

let server: Server;
let base: string;

async function post(pathname: string, body: unknown, token = "test-control-token") {
  const res = await fetch(`${base}${pathname}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() };
}

async function put(pathname: string, body: unknown, token = "test-control-token") {
  const res = await fetch(`${base}${pathname}`, {
    method: "PUT",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() };
}

async function get(pathname: string, token = "test-control-token") {
  const res = await fetch(`${base}${pathname}`, { headers: { authorization: `Bearer ${token}` } });
  return { status: res.status, json: await res.json() };
}

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

describe("editor città/tappe (Fase 3): bozze e pubblicazione", () => {
  it("richiede il token regia, come le altre rotte di controllo", async () => {
    const res = await post("/api/control/game-drafts", { slug: "x", name: "x" }, "token-sbagliato");
    expect(res.status).toBe(401);
  });

  it("crea una bozza vuota (scheletro itinerary) senza basedOn", async () => {
    const res = await post("/api/control/game-drafts", { slug: "citta-test", name: "Città di test" });
    expect(res.status).toBe(201);
    expect(res.json.data.slug).toBe("citta-test");
    expect(res.json.data.definition.phases[0].mode).toBe("itinerary");
    expect(res.json.data.definition.content.tappe).toEqual([]);
  });

  it("GET elenco e dettaglio bozza", async () => {
    const created = await post("/api/control/game-drafts", { slug: "citta-list", name: "Città lista" });
    const draftId = created.json.data.id;

    const list = await get("/api/control/game-drafts");
    expect(list.status).toBe(200);
    expect(list.json.data.some((d: { id: string }) => d.id === draftId)).toBe(true);

    const detail = await get(`/api/control/game-drafts/${draftId}`);
    expect(detail.status).toBe(200);
    expect(detail.json.data.name).toBe("Città lista");
  });

  it("PUT salva modifiche valide strutturalmente, anche con tappe semanticamente incomplete", async () => {
    const created = await post("/api/control/game-drafts", { slug: "citta-edit", name: "Città edit" });
    const draftId = created.json.data.id;
    const definition = created.json.data.definition;

    // Una tappa "textMatch" senza expectedAnswer è strutturalmente valida
    // (content è libero a livello Zod) ma semanticamente incompleta:
    // il PUT (solo validazione strutturale) deve accettarla comunque.
    definition.content.tappe.push({ id: "t1", number: 1, type: "textMatch", title: "Tappa 1", body: "", config: {}, points: 10 });

    const res = await put(`/api/control/game-drafts/${draftId}`, { definition });
    expect(res.status).toBe(200);
    expect(res.json.data.definition.content.tappe).toHaveLength(1);

    const reloaded = await get(`/api/control/game-drafts/${draftId}`);
    expect(reloaded.json.data.definition.content.tappe).toHaveLength(1);
  });

  it("PUT rifiuta una definizione strutturalmente non valida", async () => {
    const created = await post("/api/control/game-drafts", { slug: "citta-invalid", name: "Città invalida" });
    const draftId = created.json.data.id;
    const definition = created.json.data.definition;
    delete definition.game.name; // campo obbligatorio

    const res = await put(`/api/control/game-drafts/${draftId}`, { definition });
    expect(res.status).toBe(400);
    expect(res.json.error.code).toBe("invalid_draft");
  });

  it("PUT/GET/DELETE/publish su una bozza inesistente restituiscono 404", async () => {
    expect((await get("/api/control/game-drafts/draft_non_esiste")).status).toBe(404);
    expect((await put("/api/control/game-drafts/draft_non_esiste", { definition: {} })).status).toBe(404);
    expect((await post("/api/control/game-drafts/draft_non_esiste/publish", {})).status).toBe(404);
  });

  it("publish rifiuta una bozza senza tappa 'finale' (validazione semantica)", async () => {
    const created = await post("/api/control/game-drafts", { slug: "citta-senza-finale", name: "Senza finale" });
    const draftId = created.json.data.id;
    const definition = created.json.data.definition;
    definition.content.tappe.push({ id: "t1", number: 1, type: "start", title: "Inizio", body: "", config: {}, points: 0 });
    await put(`/api/control/game-drafts/${draftId}`, { definition });

    const res = await post(`/api/control/game-drafts/${draftId}/publish`, {});
    expect(res.status).toBe(400);
    expect(res.json.error.code).toBe("invalid_draft");
    expect(res.json.error.message).toContain("finale");
  });

  it("publish di una bozza completa la trasforma in un gioco selezionabile, la bozza resta modificabile", async () => {
    const created = await post("/api/control/game-drafts", { slug: "citta-completa", name: "Città completa" });
    const draftId = created.json.data.id;
    const definition = created.json.data.definition;
    definition.content.tappe.push(
      { id: "t1", number: 1, type: "start", title: "Inizio", body: "", config: { lat: 44.49, lng: 11.34 }, points: 0 },
      {
        id: "t2",
        number: 2,
        type: "geoAnswer",
        title: "Tappa geo",
        body: "",
        config: { lat: 44.494, lng: 11.343, toleranceMeters: 30 },
        points: 10,
      },
      { id: "t3", number: 3, type: "finale", title: "Fine", body: "", config: {}, points: 0 }
    );
    await put(`/api/control/game-drafts/${draftId}`, { definition });

    const publishRes = await post(`/api/control/game-drafts/${draftId}/publish`, {});
    expect(publishRes.status).toBe(200);
    expect(publishRes.json.data.slug).toBe("citta-completa");
    expect(publishRes.json.data.version).toBe("0.1");

    // Il gioco pubblicato è usabile come qualunque altro: si può creare una sessione.
    const sessionRes = await post("/api/control/sessions", { gameSlug: "citta-completa", name: "Sessione da editor" });
    expect(sessionRes.status).toBe(201);

    // La bozza è ancora lì e modificabile (non consumata dalla pubblicazione).
    const stillThere = await get(`/api/control/game-drafts/${draftId}`);
    expect(stillThere.status).toBe(200);
  });

  it("ripubblicare la stessa versione con contenuto diverso è un conflitto esplicito (409)", async () => {
    const created = await post("/api/control/game-drafts", { slug: "citta-conflitto", name: "Città conflitto" });
    const draftId = created.json.data.id;
    let definition = created.json.data.definition;
    definition.content.tappe.push({ id: "t1", number: 1, type: "finale", title: "Fine", body: "", config: {}, points: 0 });
    await put(`/api/control/game-drafts/${draftId}`, { definition });
    const first = await post(`/api/control/game-drafts/${draftId}/publish`, {});
    expect(first.status).toBe(200);

    // Cambia il contenuto senza incrementare schemaVersion: stesso "0.1" già pubblicato.
    const reloaded = await get(`/api/control/game-drafts/${draftId}`);
    definition = reloaded.json.data.definition;
    definition.content.tappe.push({ id: "t2", number: 2, type: "start", title: "Extra", body: "", config: {}, points: 0 });
    await put(`/api/control/game-drafts/${draftId}`, { definition });

    const second = await post(`/api/control/game-drafts/${draftId}/publish`, {});
    expect(second.status).toBe(409);
    expect(second.json.error.code).toBe("version_conflict");
  });

  it("basedOn clona un gioco già pubblicato, con game.id/name sovrascritti sul nuovo slug", async () => {
    // Pubblica prima un gioco "originale" da clonare.
    const original = await post("/api/control/game-drafts", { slug: "citta-originale", name: "Città originale" });
    const originalDefinition = original.json.data.definition;
    originalDefinition.content.tappe.push(
      { id: "o1", number: 1, type: "start", title: "Partenza originale", body: "", config: {}, points: 0 },
      { id: "o2", number: 2, type: "finale", title: "Arrivo originale", body: "", config: {}, points: 0 }
    );
    await put(`/api/control/game-drafts/${original.json.data.id}`, { definition: originalDefinition });
    await post(`/api/control/game-drafts/${original.json.data.id}/publish`, {});

    const cloned = await post("/api/control/game-drafts", {
      slug: "citta-clonata",
      name: "Città clonata",
      basedOn: "citta-originale",
    });
    expect(cloned.status).toBe(201);
    expect(cloned.json.data.definition.game.id).toBe("citta-clonata");
    expect(cloned.json.data.definition.game.name).toBe("Città clonata");
    expect(cloned.json.data.definition.content.tappe).toHaveLength(2);
    expect(cloned.json.data.definition.content.tappe[0].title).toBe("Partenza originale");
  });

  it("DELETE elimina una bozza", async () => {
    const created = await post("/api/control/game-drafts", { slug: "citta-da-eliminare", name: "Da eliminare" });
    const draftId = created.json.data.id;

    const res = await fetch(`${base}/api/control/game-drafts/${draftId}`, {
      method: "DELETE",
      headers: { authorization: "Bearer test-control-token" },
    });
    expect(res.status).toBe(200);

    const afterDelete = await get(`/api/control/game-drafts/${draftId}`);
    expect(afterDelete.status).toBe(404);
  });
});
