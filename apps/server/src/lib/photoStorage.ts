import fs from "node:fs";
import path from "node:path";
import { nanoid } from "nanoid";

// Interfaccia di storage per le foto delle tappe "photoApproval" (Il
// mistero della città). L'utente ha usato finora Google Drive (sistema
// Apps Script originale) ed è una direzione ragionevole per un deploy
// reale in futuro — ma richiede credenziali OAuth/service account e
// configurazione dedicata, complessità non necessaria per questo MVP.
// Questa interfaccia esiste apposta perché quel cambio, se e quando
// servirà davvero, resti un nuovo modulo che la implementa (vedi
// LocalDiskPhotoStorage sotto), non una riscrittura del resto del codice
// che la usa (routes/itinerary.ts): chi chiama .save()/.urlFor() non sa
// né deve sapere se dietro c'è il filesystem locale o un servizio esterno.
export interface PhotoStorage {
  save(params: { sessionId: string; base64: string }): { filePath: string; url: string };
  /** Percorso assoluto sul filesystem locale per un file già salvato (usato per servirlo via static route). */
  absolutePath(filePath: string): string;
}

const ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

export class LocalDiskPhotoStorage implements PhotoStorage {
  constructor(private readonly baseDir: string) {
    fs.mkdirSync(this.baseDir, { recursive: true });
  }

  save(params: { sessionId: string; base64: string }): { filePath: string; url: string } {
    const dataPart = params.base64.includes(",") ? params.base64.split(",")[1] : params.base64;
    const buffer = Buffer.from(dataPart, "base64");

    const sessionDir = path.join(this.baseDir, params.sessionId);
    fs.mkdirSync(sessionDir, { recursive: true });

    // Nome file casuale (non prevedibile da squadra/tappa/tentativo), come
    // i codici tavolo e i token: chi non ha il riferimento esatto dal
    // pannello foto non può indovinare l'URL di una foto altrui.
    const fileName = `${nanoid(16)}.jpg`;
    const fullPath = path.join(sessionDir, fileName);
    fs.writeFileSync(fullPath, buffer);

    const filePath = path.join(params.sessionId, fileName);
    return { filePath, url: `/uploads/${filePath}` };
  }

  absolutePath(filePath: string): string {
    return path.join(this.baseDir, filePath);
  }
}
