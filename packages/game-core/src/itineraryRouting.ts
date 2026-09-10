import { ItineraryStepContent } from "@spell/shared-types";

/**
 * Generazione dei percorsi per squadra (Il mistero della città), portata
 * dall'Apps Script originale (generaPercorsi/_filtraGruppi/_vincolaGuide/
 * _spaziGuide) a funzione pura testabile — nessun accesso a DB o foglio,
 * solo l'algoritmo. La persistenza (scrivere il percorso nel base_state
 * di ogni tavolo) è responsabilità del chiamante (apps/server).
 *
 * Logica (invariata rispetto all'originale):
 * - le tappe "normali" (non start/finale/buono) sono raggruppate per
 *   "blocco", se presente; i blocchi ruotano per COPPIA di squadre
 *   (coppia 0 vede i blocchi nell'ordine B0,B1,B2..., coppia 1 li vede
 *   B1,B2,B0... ecc.) — così due squadre della stessa coppia percorrono
 *   gli stessi blocchi nello stesso ordine (utile se condividono una
 *   guida), ma coppie diverse sono sfalsate;
 * - dentro ogni blocco, l'ordine delle tappe ruota per singola squadra
 *   (non per coppia): le due squadre della stessa coppia non vedono le
 *   tappe nello stesso identico ordine;
 * - le tappe senza blocco ruotano individualmente, come prima;
 * - il buono va a metà del percorso (arrotondato per difetto);
 * - dopo aver composto la sequenza grezza, due passate di aggiustamento:
 *   1) _vincolaGuide: le prime 2 e le ultime 2 posizioni del percorso
 *      "centrale" (tra start e finale) non devono essere di tipo "guida";
 *   2) _spaziGuide: due tappe "guida" non devono essere a meno di
 *      minGuideDistance posizioni l'una dall'altra.
 * - le tappe con "groups" non vuoto sono riservate a specifiche squadre,
 *   identificate dal loro NUMERO ORDINALE nella sessione (1-based, cioè
 *   index+1 — lo stesso ordine di creazione dei tavoli), non dall'id
 *   interno del motore: nel foglio originale il campo "gruppi" della
 *   tappa conteneva l'id numerico 1..N della squadra (in Apps Script gli
 *   id squadra ERANO piccoli interi 1..N), mentre in questo motore
 *   team.id è una stringa generata (es. "team_x7hq2z9k"), diversa a ogni
 *   sessione — una game definition statica non può contenerla in
 *   anticipo. Il numero ordinale è l'unico riferimento stabile che una
 *   game definition pubblicata può usare per dire "questa tappa è per la
 *   terza squadra creata" — le altre squadre non la vedono affatto nel
 *   proprio pool.
 */

export interface RouteGenerationTeam {
  id: string;
  /** Indice 0-based nell'ordine con cui le squadre vengono considerate: stesso ruolo dell'indice "i" nell'originale (determina rotazione blocchi/coppie e sfalsamento individuale). */
  index: number;
}

export { stepConstraintKind };

export interface RouteGenerationResult {
  teamId: string;
  /** Sequenza di "number" di tappa, nell'ordine in cui la squadra le affronta. */
  sequence: number[];
}

export interface GeoPoint {
  lat: number;
  lng: number;
}

/**
 * Distanza approssimata in metri tra due punti geografici (formula
 * dell'emisenoverso, raggio terrestre medio 6371 km) — precisione più che
 * sufficiente per un percorso a piedi in città, non serve un modello
 * geodetico più preciso. Pura, nessuna dipendenza esterna: usata sia dal
 * modulo "geoAnswer" (packages/game-core/src/modules/geoAnswer.ts, per
 * verificare la posizione inviata da una squadra) sia da
 * computeRouteDistanceMeters sotto (distanza prevista di un percorso).
 */
export function haversineMeters(a: GeoPoint, b: GeoPoint): number {
  const R = 6371000;
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);

  const sinDLat = Math.sin(dLat / 2);
  const sinDLng = Math.sin(dLng / 2);
  const h = sinDLat * sinDLat + Math.cos(lat1) * Math.cos(lat2) * sinDLng * sinDLng;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

export interface RouteDistanceResult {
  /** Distanza totale stimata, in metri, tra tappe consecutive del percorso che hanno entrambe lat/lng. */
  meters: number;
  /** "number" delle tappe del percorso senza lat/lng in config — escluse dal calcolo, non fanno fallire la funzione. */
  missingCoords: number[];
}

function stepCoords(step: ItineraryStepContent | undefined): GeoPoint | null {
  const config = step?.config as { lat?: unknown; lng?: unknown } | undefined;
  const lat = config?.lat;
  const lng = config?.lng;
  if (typeof lat !== "number" || typeof lng !== "number") return null;
  return { lat, lng };
}

/**
 * Distanza prevista di un percorso già generato/assegnato (spec: mostrata
 * alla regia per squadra, packages/game-core... usato da
 * apps/server/src/routes/control.ts). Somma le distanze tra tappe
 * consecutive nell'ordine di "route"; una tappa senza coordinate rompe la
 * catena in quel punto (il segmento prima/dopo di essa non viene
 * conteggiato) invece di far fallire l'intero calcolo — utile perché una
 * game definition può avere coordinate parziali durante l'authoring
 * (vedi editor.html, wave successiva).
 */
export function computeRouteDistanceMeters(route: number[], steps: ItineraryStepContent[]): RouteDistanceResult {
  const byNumber = new Map(steps.map((s) => [s.number, s]));
  const missingCoords: number[] = [];
  let meters = 0;
  let previous: GeoPoint | null = null;

  for (const num of route) {
    const step = byNumber.get(num);
    const point = stepCoords(step);
    if (!point) {
      missingCoords.push(num);
      previous = null; // catena interrotta: non collegare il segmento successivo a un punto sconosciuto
      continue;
    }
    if (previous) meters += haversineMeters(previous, point);
    previous = point;
  }

  return { meters, missingCoords };
}

function filtraGruppi(steps: ItineraryStepContent[], teamNumber: number): ItineraryStepContent[] {
  return steps.filter((s) => {
    const g = (s.groups ?? []).map((x) => String(x).trim()).filter(Boolean);
    if (g.length === 0) return true;
    return g.includes(String(teamNumber));
  });
}

/**
 * "Tipo" ai fini dei vincoli di routing (vincolaGuide/spaziGuide), NON lo
 * stesso concetto di ItineraryStepContent.type (quello è il modulo motore
 * che gestisce la tappa, es. "textMatch" — deve corrispondere a un modulo
 * registrato). Nell'originale Apps Script il foglio Clue_Quiz distingueva
 * testo/guida/qr/foto/start/finale/buono in UNA sola colonna "tipo": qui
 * quella distinzione, per le tappe testo/guida/qr, è rimasta nel campo
 * config.kind del modulo "textMatch" (vedi packages/game-core/src/modules/
 * textMatch.ts) — la tappa resta "una textMatch" agli occhi del motore,
 * ma "una guida" agli occhi del routing. Per start/finale/voucher/foto
 * config.kind non è previsto: si ricade sul modulo (type) stesso, che è
 * già univoco per quei casi.
 */
function stepConstraintKind(step: ItineraryStepContent): string {
  const kind = (step.config as { kind?: unknown } | undefined)?.kind;
  return typeof kind === "string" && kind ? kind : step.type;
}

function tipoOfFactory(steps: ItineraryStepContent[]) {
  const byNumber = new Map(steps.map((s) => [s.number, stepConstraintKind(s)]));
  return (num: number) => byNumber.get(num) ?? "";
}

/** Prime 2 e ultime 2 posizioni del tratto centrale non devono essere "guida". */
function vincolaGuide(seq: number[], steps: ItineraryStepContent[], nStart: number, nFinale: number): number[] {
  const mid = seq.slice(nStart, seq.length - nFinale);
  const nMid = mid.length;
  if (nMid < 3) return seq;
  const tipoOf = tipoOfFactory(steps);
  const MAX_ITER = nMid * 2;

  for (let iter = 0; iter < MAX_ITER; iter++) {
    let cambiato = false;

    for (let p = 0; p <= 1; p++) {
      if (p >= nMid) break;
      if (tipoOf(mid[p]) === "guida") {
        for (let q = 2; q < nMid; q++) {
          if (tipoOf(mid[q]) !== "guida") {
            [mid[p], mid[q]] = [mid[q], mid[p]];
            cambiato = true;
            break;
          }
        }
      }
    }

    for (let p2 = nMid - 1; p2 >= nMid - 2; p2--) {
      if (p2 < 0) break;
      if (tipoOf(mid[p2]) === "guida") {
        for (let q2 = nMid - 3; q2 >= 0; q2--) {
          if (tipoOf(mid[q2]) !== "guida") {
            [mid[p2], mid[q2]] = [mid[q2], mid[p2]];
            cambiato = true;
            break;
          }
        }
      }
    }

    if (!cambiato) break;
  }

  return seq.slice(0, nStart).concat(mid, seq.slice(seq.length - nFinale));
}

/**
 * Due tappe "guida" non devono stare a meno di minDist posizioni l'una
 * dall'altra. Le posizioni target dello scambio escludono le prime 2 e le
 * ultime 2 del tratto centrale (stessa zona protetta da vincolaGuide
 * sopra) e sono verificate contro TUTTE le guide correnti in mid, non
 * solo contro la coppia (p, q) che si sta sistemando — bug reale trovato
 * con i dati veri del "mistero della città" (pool da 22-24 tappe, 4
 * guide): un candidato scelto solo perché "abbastanza lontano da p"
 * poteva comunque atterrare a fianco di una TERZA guida già presente,
 * spostando la violazione invece di risolverla. generateItineraryRoutes
 * alterna questa funzione con vincolaGuide fino a un punto fisso, perché
 * le due imposizioni (bordi vs distanza) insistono sulla stessa zona.
 */
function spaziGuide(
  seq: number[],
  steps: ItineraryStepContent[],
  nStart: number,
  nFinale: number,
  minDist: number
): number[] {
  const mid = seq.slice(nStart, seq.length - nFinale);
  const nMid = mid.length;
  const tipoOf = tipoOfFactory(steps);
  const isGuida = (num: number) => tipoOf(num) === "guida";
  const isEdge = (idx: number) => idx < 2 || idx >= nMid - 2;

  const guidaPositions = () =>
    mid.map((num, idx) => ({ num, idx })).filter(({ num }) => isGuida(num)).map(({ idx }) => idx);

  /** true se spostare la guida da "from" a "to" non crea nessuna coppia troppo vicina. */
  const isSafeTarget = (to: number, from: number): boolean => {
    if (isEdge(to) || isGuida(mid[to])) return false;
    for (const g of guidaPositions()) {
      if (g === from) continue; // si sta liberando questa posizione
      if (Math.abs(to - g) < minDist) return false;
    }
    return true;
  };

  for (let iter = 0; iter < nMid * 2; iter++) {
    let cambiato = false;

    for (let p = 0; p < nMid - 1; p++) {
      if (!isGuida(mid[p])) continue;
      for (let q = p + 1; q <= Math.min(p + minDist, nMid - 1); q++) {
        if (!isGuida(mid[q])) continue;

        let swapPos = -1;
        for (let s = q + 1; s < nMid; s++) {
          if (isSafeTarget(s, q)) {
            swapPos = s;
            break;
          }
        }
        if (swapPos === -1) {
          for (let s2 = p - 1; s2 >= 0; s2--) {
            if (isSafeTarget(s2, q)) {
              swapPos = s2;
              break;
            }
          }
        }
        if (swapPos !== -1) {
          [mid[q], mid[swapPos]] = [mid[swapPos], mid[q]];
          cambiato = true;
        }
        break;
      }
      if (cambiato) break;
    }

    if (!cambiato) break;
  }

  return seq.slice(0, nStart).concat(mid, seq.slice(seq.length - nFinale));
}

export function generateItineraryRoutes(
  steps: ItineraryStepContent[],
  teams: RouteGenerationTeam[],
  options: { minGuideDistance?: number } = {}
): RouteGenerationResult[] {
  if (teams.length === 0) return [];

  const tappeStart = steps.filter((s) => s.type === "start");
  const tappeFinale = steps.filter((s) => s.type === "finale");
  const tappeBuono = steps.filter((s) => s.type === "voucher");
  const tappeNormali = steps.filter((s) => !["start", "finale", "voucher"].includes(s.type));

  const numStart = tappeStart.map((s) => s.number);
  const numFinale = tappeFinale.map((s) => s.number);
  const numBuono = tappeBuono.map((s) => s.number);

  const blocchiMap = new Map<string, ItineraryStepContent[]>();
  const tappeSenzaBlocco: ItineraryStepContent[] = [];
  for (const s of tappeNormali) {
    const b = (s.block ?? "").trim();
    if (b) {
      if (!blocchiMap.has(b)) blocchiMap.set(b, []);
      blocchiMap.get(b)!.push(s);
    } else {
      tappeSenzaBlocco.push(s);
    }
  }
  const blocchiKeys = [...blocchiMap.keys()].sort((a, b) => {
    const na = Number(a);
    const nb = Number(b);
    return Number.isNaN(na) || Number.isNaN(nb) ? a.localeCompare(b) : na - nb;
  });
  const nBlocchi = blocchiKeys.length;
  const minDistGuide = options.minGuideDistance ?? 2;

  return teams.map(({ id: teamId, index: i }) => {
    const pairIndex = Math.floor(i / 2);

    const allBloccoNums: number[] = [];
    for (let b = 0; b < nBlocchi; b++) {
      const bKey = blocchiKeys[(pairIndex + b) % nBlocchi];
      const bTappe = filtraGruppi(blocchiMap.get(bKey) ?? [], i + 1);
      const bNums = bTappe.map((s) => s.number);
      const nB = bNums.length;
      if (nB === 0) continue;
      for (let k = 0; k < nB; k++) allBloccoNums.push(bNums[(i + k) % nB]);
    }

    const rotNormali = filtraGruppi(tappeSenzaBlocco, i + 1);
    const rotNums = rotNormali.map((s) => s.number);
    const nR = rotNums.length;
    const rotRuotati: number[] = [];
    for (let j = 0; j < nR; j++) rotRuotati.push(rotNums[(i + j) % nR]);

    const pool = allBloccoNums.concat(rotRuotati);
    const nPool = pool.length;
    const posBuono = Math.floor(nPool * 0.5);

    let seq = numStart
      .concat(pool.slice(0, posBuono))
      .concat(numBuono)
      .concat(pool.slice(posBuono))
      .concat(numFinale);

    // vincolaGuide e spaziGuide impongono due vincoli diversi sulla stessa
    // zona (bordi vs distanza minima) e possono, sistemando l'uno, violare
    // l'altro (bug reale trovato con i dati veri del "mistero della
    // città": 4 guide su un pool di 22-24 tappe). Si alternano fino a un
    // punto fisso (nessuna modifica in un round), con un tetto basso di
    // round: con solo 4 guide e ampio margine questo converge in pochi
    // passaggi; se non convergesse (vincoli troppo stretti per i dati
    // forniti) si esce comunque con il miglior risultato ottenuto,
    // preferibile a un loop indefinito.
    for (let round = 0; round < 6; round++) {
      const before = seq.join(",");
      seq = vincolaGuide(seq, steps, numStart.length, numFinale.length);
      seq = spaziGuide(seq, steps, numStart.length, numFinale.length, minDistGuide);
      if (seq.join(",") === before) break;
    }

    return { teamId, sequence: seq };
  });
}
