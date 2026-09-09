// Tipi condivisi tra core, moduli di gioco e server.
// Nessun riferimento a un gioco specifico: appartiene alla piattaforma (spec §4).

export type SessionStatus =
  | "DRAFT"
  | "LOBBY"
  | "RUNNING"
  | "PAUSED"
  | "COMPLETED"
  | "ARCHIVED";

export type PhaseStatus = "CLOSED" | "OPEN";

export type TeamConnectionStatus = "PENDING" | "CONNECTED" | "DISCONNECTED";

export interface ApiResponse<T> {
  ok: boolean;
  data: T | null;
  error: { code: string; message: string } | null;
  requestId: string;
}

// --- Definizione di gioco (spec §9) ---

export interface GameDefinition {
  schemaVersion: string;
  game: {
    id: string;
    name: string;
    defaultLocale: string;
  };
  roles: string[];
  settings: {
    teamsMin: number;
    teamsMax: number;
    oneDevicePerTeam: boolean;
    showLeaderboard: boolean;
  };
  phases: PhaseDefinition[];
  content: Record<string, unknown>;
  rules: Record<string, string>;
}

export interface ActivityDefinition {
  id: string;
  type: string; // corrisponde a un modulo registrato in game-core
  title: string;
  config: Record<string, unknown>;
}

// "itinerary" (aggiunto per "Il mistero della città"): a differenza di
// single_submission/multi_round, che sono UNA attività sincronizzata dalla
// regia (apri fase -> tutte le squadre rispondono -> chiudi fase), una fase
// itinerary contiene un POOL di tappe (in content[stepsSource]) e ogni
// squadra avanza al proprio ritmo lungo una propria sequenza di tappe
// (assegnata da un'azione di generazione percorsi, non dalla regia in
// tempo reale). Non sostituisce single_submission: Less is More continua a
// usarlo esattamente come prima, invariato.
export interface ItineraryPhaseDefinition {
  /** Chiave in content[] con l'elenco delle tappe (es. "tappe"), stessa convenzione di config.itemsSource negli altri moduli. */
  stepsSource: string;
  routing: {
    /** Distanza minima, in posizioni, tra due tappe di tipo "guida" nel percorso generato di una squadra (spec originale: min_distanza_guide). */
    minGuideDistance?: number;
  };
  /** Tentativi massimi per tappa di tipo "foto" prima che il modulo rifiuti nuovi invii (default 3, spec originale: max_tentativi_foto). */
  maxPhotoAttempts?: number;
  /** Punti detratti alla prima richiesta di suggerimento per tappa (default 5, spec originale: punti_suggerimento). */
  hintPenalty?: number;
}

/** Una singola tappa nel pool referenziato da ItineraryPhaseDefinition.stepsSource. */
export interface ItineraryStepContent {
  id: string;
  /** Numero usato per riferirsi alla tappa dentro le sequenze generate per squadra (team_state.base_state_json). */
  number: number;
  /** Corrisponde a un modulo registrato in game-core (es. "start", "textMatch", "photoApproval", "voucher", "finale"). */
  type: string;
  title: string;
  body: string;
  config: Record<string, unknown>;
  points: number;
  hint?: string;
  /** Se presente, tappa riservata a queste squadre (per team id); vuoto/assente = tappa per tutte. */
  groups?: string[];
  /** Raggruppamento usato dalla generazione percorsi per far ruotare le tappe a blocchi tra coppie di squadre. */
  block?: string;
}

export interface PhaseDefinition {
  id: string;
  title: string;
  mode: "single_submission" | "multi_round" | "itinerary";
  /** Richiesta per mode "single_submission"/"multi_round". */
  activity?: ActivityDefinition;
  /** Richiesta per mode "itinerary". */
  itinerary?: ItineraryPhaseDefinition;
  completion: {
    type: "all_teams_submitted" | "manual" | "each_team_at_own_pace";
  };
}

// --- Contratto dei moduli (spec §10) ---

export interface ValidationResult {
  valid: boolean;
  errors?: string[];
}

export interface Effect {
  type:
    | "score.add"
    | "team_state.patch"
    | "submission.accept"
    | "submission.reject"
    | "phase.team_complete"
    | "message.emit"
    | "audit.log"
    // Solo per moduli usati dentro fasi "itinerary" (Il mistero della
    // città): segnala che la squadra deve avanzare alla tappa successiva
    // del proprio percorso. Payload vuoto — "come" avanzare (calcolo della
    // nuova posizione dal route della squadra) è responsabilità
    // dell'orchestrazione itinerary (lib/itineraryPipeline.ts), non del
    // modulo: separa "questa risposta è corretta" (il modulo lo sa) da
    // "come funziona il routing" (l'orchestrazione lo sa). Non gestito da
    // applyEffectToState (resta un no-op generico lì, spec §effects.ts):
    // l'avanzamento vero si registra come un team_state.patch separato,
    // cosi' il rebuild dagli effect_event resta corretto senza bisogno di
    // conoscere il routing.
    | "itinerary.advance";
  payload: Record<string, unknown>;
}

export interface ModuleContext {
  sessionId: string;
  teamId: string;
  phaseId: string;
  activityId: string;
  activityConfig: Record<string, unknown>;
  content: Record<string, unknown>;
  teamState: Record<string, unknown>;
}

export interface GameModule {
  type: string;
  /** Valida lo schema di configurazione dell'attività (statico, in fase di caricamento game_version). */
  validateConfig(config: Record<string, unknown>): ValidationResult;
  /** Rappresentazione dell'attività lato tavolo: cosa serve al client per renderla, nessuna logica di stato. */
  playerView(ctx: ModuleContext): Record<string, unknown>;
  /** Valida il payload inviato dal tavolo. */
  validateSubmission(
    ctx: ModuleContext,
    payload: Record<string, unknown>
  ): ValidationResult;
  /** Calcola gli effetti a partire da una submission valida. */
  applyRules(
    ctx: ModuleContext,
    payload: Record<string, unknown>
  ): Effect[];
  /** Cosa vede/può fare la regia per questa attività. */
  controlView(ctx: ModuleContext): Record<string, unknown>;
}
