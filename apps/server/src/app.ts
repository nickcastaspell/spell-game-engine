import "./lib/db"; // side-effect: carica .env dalla root PRIMA di qualunque
// altro modulo (es. controlAuth.ts) che legge process.env al caricamento —
// altrimenti l'ordine di import può catturare i default hardcoded invece
// dei valori da .env (bug reale, vedi cronologia).
import express from "express";
import path from "node:path";
import { asyncRoute, requestIdMiddleware, sendErr, sendOk } from "./lib/response";
import { listGames } from "./lib/repo";
import { appVersion } from "./lib/version";
import { controlRouter } from "./routes/control";
import { authoringRouter } from "./routes/authoring";
import { teamRouter } from "./routes/team";
import { facilitatorRouter } from "./routes/facilitator";
import { devRouter } from "./routes/dev";
import { isDevEnvironment } from "./lib/devMode";

// App separata da index.ts (che fa solo il bootstrap/listen), così i test
// possono montarla su una porta effimera senza duplicare la configurazione.
export function createApp() {
  const app = express();
  // Limite alzato da 100kb (default Express) a 15mb: le tappe "photoApproval"
  // inviano la foto come base64 nel body JSON (team.html, submitPhoto) — una
  // normale foto da smartphone supera facilmente 100kb, il default avrebbe
  // fatto rifiutare ogni invio con un 413 (bug reale: "Unexpected token '<'"
  // lato client, perché senza il gestore errori sotto quel 413 arrivava come
  // pagina HTML di Express, non come JSON).
  app.use(express.json({ limit: "15mb" }));
  app.use(requestIdMiddleware);

  // GET /api/games — pubblico, nessun token: nome/slug dei giochi
  // pubblicati non sono dati sensibili, serve alla home (index.html) per
  // mostrare quali cacce ospita la piattaforma. Variante non autenticata
  // di GET /api/control/games (quella resta per il selettore "Crea
  // sessione" in Regia, che richiede comunque il token per il resto).
  app.get(
    "/api/games",
    asyncRoute(async (_req, res) => {
      sendOk(res, listGames().map((g) => ({ slug: g.slug, name: g.name })));
    })
  );

  // GET /api/version — pubblico, nessun dato sensibile: commit e messaggio
  // dell'ultimo deploy, per verificare a colpo d'occhio in Regia che
  // l'aggiornamento atteso sia davvero quello attivo (vedi cronologia: un
  // deploy Railway può restare "SKIPPED" senza errori visibili altrove).
  app.get(
    "/api/version",
    asyncRoute(async (_req, res) => {
      sendOk(res, appVersion);
    })
  );

  app.use("/api/control", controlRouter);
  app.use("/api/control", authoringRouter);
  app.use("/api/team", teamRouter);
  app.use("/api/facilitator", facilitatorRouter);

  // Strumenti dev (reset/duplica/elimina/riapri sessione, vedi routes/dev.ts):
  // montati SOLO fuori produzione. In produzione /api/dev/* non esiste come
  // route — richieste a quel prefisso finiscono nel 404 generico qui sotto,
  // non in un 403/permission-denied che rivelerebbe che la route esiste.
  if (isDevEnvironment()) {
    app.use("/api/dev", devRouter);
  }

  app.use(express.static(path.join(__dirname, "..", "..", "web", "public")));

  app.use((_req, res) => {
    sendErr(res, 404, "not_found", "Risorsa non trovata");
  });

  // Gestore d'errore generico: senza questo, un errore sollevato PRIMA di
  // arrivare a un route handler (es. express.json() su un body oltre il
  // limite, o malformato) passa al gestore d'errore DI DEFAULT di Express,
  // che risponde con una pagina HTML — il client (team.html) si aspetta
  // sempre JSON e fallisce con un errore di parsing invece di mostrare il
  // messaggio vero (bug reale: upload foto oltre 100kb, vedi il limit sopra).
  // asyncRoute già gestisce gli errori DENTRO ai route handler: questo
  // copre il resto della pipeline.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use((err: Error & { status?: number; statusCode?: number }, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const status = err.status ?? err.statusCode ?? 500;
    if (status >= 500) {
      // eslint-disable-next-line no-console
      console.error(err);
    }
    sendErr(res, status, "request_error", err.message || "Errore nella richiesta");
  });

  return app;
}
