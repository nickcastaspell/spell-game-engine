import { describe, it, expect, beforeAll, afterAll } from "vitest";
import path from "node:path";
import os from "node:os";
import type { Server } from "node:http";

// Bug reale segnalato dall'utente (con screenshot): caricare una foto su
// una tappa "photoApproval" falliva con "Unexpected token '<', <!DOCTYPE"
// lato client — il body JSON (photoBase64 di una foto reale) superava il
// limite di default di express.json() (100kb) e, senza un gestore d'errore
// dedicato, il 413 di Express arrivava come pagina HTML invece che JSON.
// Fix in app.ts: limite alzato a 15mb + gestore d'errore generico che
// garantisce sempre una risposta JSON (sendErr), qualunque sia l'errore.
const dbFile = path.join(os.tmpdir(), `spell-test-bodylimit-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
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

describe("limite del body JSON (fix upload foto)", () => {
  it("accetta un body oltre il vecchio default di 100kb (es. una foto base64 reale)", async () => {
    const filler = "a".repeat(500_000); // ~500kb, ben oltre i 100kb di default
    const res = await fetch(`${base}/api/team/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ accessCode: "NONEXISTENT", filler }),
    });
    const body = await res.json(); // non deve lanciare (JSON valido, non HTML)
    expect(res.status).toBe(404); // arrivato al route handler: codice non trovato, non un errore di body-parsing
    expect(body.error?.code).toBe("invalid_code");
  });

  it("un body oltre il limite (15mb) torna comunque JSON, non una pagina HTML", async () => {
    const filler = "a".repeat(16 * 1024 * 1024); // 16MB, oltre il limite di 15mb
    const res = await fetch(`${base}/api/team/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ accessCode: "X", filler }),
    });
    expect(res.status).toBe(413);
    const contentType = res.headers.get("content-type") ?? "";
    expect(contentType).toContain("application/json");
    const body = await res.json(); // non deve lanciare "Unexpected token '<'"
    expect(body.ok).toBe(false);
    expect(body.error).toBeTruthy();
  });
});
