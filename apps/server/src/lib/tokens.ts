import { customAlphabet, nanoid } from "nanoid";
import { createHash } from "node:crypto";

// Codici tavolo brevi, leggibili, senza caratteri ambigui.
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const generateAccessCode = customAlphabet(ALPHABET, 6);

export function newAccessCode(): string {
  return generateAccessCode();
}

export function newDeviceToken(): string {
  return nanoid(32);
}

// Token buono (Il mistero della città): stesso alfabeto/stile dei codici
// tavolo (leggibile, senza caratteri ambigui), prefisso "BUO-" come
// nell'originale, per essere riconoscibile a colpo d'occhio dal barista.
const generateVoucherSuffix = customAlphabet(ALPHABET, 8);
export function newVoucherToken(): string {
  return "BUO-" + generateVoucherSuffix();
}

// Token facilitatore/operatore: stesso stile.
const generateFacilitatorToken = customAlphabet(ALPHABET, 10);
export function newFacilitatorToken(): string {
  return "FAC-" + generateFacilitatorToken();
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
