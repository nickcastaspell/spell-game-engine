import "./lib/db"; // side-effect: carica .env dalla root PRIMA di qualunque
// altro modulo (es. controlAuth.ts) che legge process.env al caricamento —
// altrimenti l'ordine di import può catturare i default hardcoded invece
// dei valori da .env (bug reale, vedi cronologia).
import express from "express";
import path from "node:path";
import { asyncRoute, requestIdMiddleware, sendErr, sendOk } from "./lib/response";
import { listGames } from "./lib/repo";
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
  app.use(express.json());
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

  return app;
}
