import path from "node:path";
import { LocalDiskPhotoStorage, PhotoStorage } from "./photoStorage";

// Stessa logica di REPO_ROOT in db.ts: ancorata alla posizione di questo
// file, non a process.cwd(), per lo stesso motivo (npm run seed gira dalla
// root, npm start/dev girano dentro apps/server).
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");

const uploadsDirRaw = process.env.UPLOADS_DIR ?? path.join(REPO_ROOT, "data", "uploads");
export const uploadsDir = path.isAbsolute(uploadsDirRaw) ? uploadsDirRaw : path.resolve(REPO_ROOT, uploadsDirRaw);

export const photoStorage: PhotoStorage = new LocalDiskPhotoStorage(uploadsDir);
