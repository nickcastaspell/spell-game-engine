import { SessionStatus } from "@spell/shared-types";

/**
 * Transizioni di stato consentite per la sessione (spec §5).
 * DRAFT → LOBBY → RUNNING ⇄ PAUSED → COMPLETED
 * COMPLETED → ARCHIVED
 */
const ALLOWED_TRANSITIONS: Record<SessionStatus, SessionStatus[]> = {
  DRAFT: ["LOBBY"],
  LOBBY: ["RUNNING"],
  RUNNING: ["PAUSED", "COMPLETED"],
  PAUSED: ["RUNNING"],
  COMPLETED: ["ARCHIVED"],
  ARCHIVED: [],
};

export class InvalidTransitionError extends Error {
  constructor(from: SessionStatus, to: SessionStatus) {
    super(`Transizione non consentita: ${from} -> ${to}`);
    this.name = "InvalidTransitionError";
  }
}

export function assertTransition(from: SessionStatus, to: SessionStatus): void {
  if (!ALLOWED_TRANSITIONS[from]?.includes(to)) {
    throw new InvalidTransitionError(from, to);
  }
}

export function canAcceptSubmissions(sessionStatus: SessionStatus): boolean {
  return sessionStatus === "RUNNING";
}
