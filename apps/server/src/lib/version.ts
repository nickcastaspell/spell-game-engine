import { execSync } from "node:child_process";

// Serve alla regia per verificare a colpo d'occhio che il deploy attivo
// sia quello aspettato (vedi cronologia: un deploy Railway può restare
// "SKIPPED" per via dei Watch Paths, senza errori visibili altrove). In
// produzione (Railway) RAILWAY_GIT_COMMIT_SHA/MESSAGE sono già nell'ambiente
// di runtime — nessuna dipendenza da git installato nel container. In
// locale (npm run dev, nessuna di queste env var) si cade sul comando git
// vero, che qui gira UNA SOLA VOLTA all'avvio del processo, non ad ogni
// richiesta.
function readLocalGitInfo(): { commit: string; message: string } | null {
  try {
    const commit = execSync("git rev-parse HEAD", { encoding: "utf-8" }).trim();
    const message = execSync("git log -1 --format=%s", { encoding: "utf-8" }).trim();
    return { commit, message };
  } catch {
    return null; // niente .git a disposizione (es. immagine di produzione senza git installato)
  }
}

export interface AppVersion {
  commit: string | null;
  commitShort: string | null;
  message: string | null;
  startedAt: string;
}

const startedAt = new Date().toISOString();

const railwayCommit = process.env.RAILWAY_GIT_COMMIT_SHA;
const local = railwayCommit ? null : readLocalGitInfo();

const commit = railwayCommit ?? local?.commit ?? null;
const message = process.env.RAILWAY_GIT_COMMIT_MESSAGE ?? local?.message ?? null;

export const appVersion: AppVersion = {
  commit,
  commitShort: commit ? commit.slice(0, 7) : null,
  message,
  startedAt,
};
