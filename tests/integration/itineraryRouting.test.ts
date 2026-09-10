import { describe, it, expect } from "vitest";
import {
  generateItineraryRoutes,
  stepConstraintKind,
  haversineMeters,
  computeRouteDistanceMeters,
  type RouteGenerationTeam,
} from "../../packages/game-core/src/itineraryRouting";
import type { ItineraryStepContent } from "../../packages/shared-types/src/index";

// Set di tappe sintetico ma realistico: blocchi 1/2/3 con 3 tappe ciascuno
// (una delle quali "guida"), 2 tappe senza blocco, 1 start, 1 voucher,
// 1 finale — abbastanza per verificare tutti i vincoli dell'algoritmo
// senza dover caricare tutte le 35 tappe reali di Bologna.
function buildSteps(): ItineraryStepContent[] {
  const steps: ItineraryStepContent[] = [
    { id: "start", number: 1, type: "start", title: "Start", body: "", config: {}, points: 0 },
  ];
  let n = 2;
  for (const block of ["1", "2", "3"]) {
    steps.push({ id: `b${block}-testo`, number: n++, type: "textMatch", title: "t", body: "", config: { kind: "testo" }, points: 10, block });
    steps.push({ id: `b${block}-guida`, number: n++, type: "textMatch", title: "g", body: "", config: { kind: "guida" }, points: 10, block });
    steps.push({ id: `b${block}-foto`, number: n++, type: "photoApproval", title: "f", body: "", config: {}, points: 10, block });
  }
  steps.push({ id: "libera-1", number: n++, type: "textMatch", title: "libera1", body: "", config: {}, points: 10 });
  steps.push({ id: "libera-2", number: n++, type: "textMatch", title: "libera2", body: "", config: {}, points: 10 });
  steps.push({ id: "buono", number: n++, type: "voucher", title: "buono", body: "", config: {}, points: 0 });
  steps.push({ id: "finale", number: n++, type: "finale", title: "finale", body: "", config: {}, points: 0 });
  return steps;
}

// Stessa regola di produzione (itineraryRouting.ts:stepConstraintKind), non
// una riletta ad-hoc: altrimenti un domani il test potrebbe divergere
// silenziosamente dal comportamento reale che verifica.
function tipoOf(steps: ItineraryStepContent[], num: number): string {
  const step = steps.find((s) => s.number === num);
  return step ? stepConstraintKind(step) : "";
}

describe("generateItineraryRoutes", () => {
  const steps = buildSteps();
  const teams: RouteGenerationTeam[] = Array.from({ length: 8 }, (_, i) => ({ id: `team-${i}`, index: i }));
  const routes = generateItineraryRoutes(steps, teams, { minGuideDistance: 2 });

  it("genera un percorso per ogni squadra, con tutte le tappe (nessuna persa/duplicata)", () => {
    expect(routes.length).toBe(8);
    const expectedLength = steps.length; // ogni tappa "normale" compare una volta, + start/buono/finale
    for (const r of routes) {
      expect(r.sequence.length).toBe(expectedLength);
      // ogni tappa compare esattamente una volta (nessuna persa/duplicata dalla rotazione)
      const asSet = new Set(r.sequence);
      expect(asSet.size).toBe(expectedLength);
    }
  });

  it("ogni percorso inizia con start e finisce con finale", () => {
    const startNum = steps.find((s) => s.type === "start")!.number;
    const finaleNum = steps.find((s) => s.type === "finale")!.number;
    for (const r of routes) {
      expect(r.sequence[0]).toBe(startNum);
      expect(r.sequence[r.sequence.length - 1]).toBe(finaleNum);
    }
  });

  it('il buono cade circa a metà percorso (non subito dopo start né subito prima di finale)', () => {
    const buonoNum = steps.find((s) => s.type === "voucher")!.number;
    for (const r of routes) {
      const pos = r.sequence.indexOf(buonoNum);
      expect(pos).toBeGreaterThan(1);
      expect(pos).toBeLessThan(r.sequence.length - 2);
    }
  });

  it('le prime 2 e le ultime 2 posizioni del tratto centrale non sono di tipo "guida"', () => {
    for (const r of routes) {
      const mid = r.sequence.slice(1, r.sequence.length - 1); // tra start e finale
      const firstTwo = mid.slice(0, 2);
      const lastTwo = mid.slice(-2);
      for (const num of [...firstTwo, ...lastTwo]) {
        expect(tipoOf(steps, num)).not.toBe("guida");
      }
    }
  });

  it("due tappe guida non sono mai a meno di minGuideDistance posizioni l'una dall'altra", () => {
    for (const r of routes) {
      const guidaPositions = r.sequence
        .map((num, idx) => ({ num, idx }))
        .filter(({ num }) => tipoOf(steps, num) === "guida")
        .map(({ idx }) => idx);
      for (let a = 0; a < guidaPositions.length; a++) {
        for (let b = a + 1; b < guidaPositions.length; b++) {
          expect(Math.abs(guidaPositions[a] - guidaPositions[b])).toBeGreaterThanOrEqual(2);
        }
      }
    }
  });

  it("squadre della stessa coppia percorrono i blocchi nello stesso ordine, ma con tappe interne in ordine diverso", () => {
    // coppia 0 = team-0, team-1
    const blockOrderOf = (seq: number[]) =>
      seq
        .map((num) => steps.find((s) => s.number === num)?.block)
        .filter((b, idx, arr) => b && arr.indexOf(b) === idx); // primo blocco incontrato per ciascun blocco, in ordine

    const order0 = blockOrderOf(routes[0].sequence);
    const order1 = blockOrderOf(routes[1].sequence);
    expect(order0).toEqual(order1);

    // ma la coppia 1 (team-2, team-3) vede i blocchi in un ordine diverso da coppia 0
    const order2 = blockOrderOf(routes[2].sequence);
    expect(order2).not.toEqual(order0);
  });

  it("una tappa con 'groups' è vista solo dalle squadre il cui NUMERO ORDINALE (1-based) è elencato", () => {
    // "groups" fa riferimento al numero ordinale nella sessione (1 = prima
    // squadra creata, cioè index 0), non all'id interno del motore — vedi
    // il commento su stepConstraintKind/filtraGruppi in itineraryRouting.ts:
    // nei dati reali (Il mistero della città) "gruppi" contiene proprio
    // questi piccoli interi 1..N, mai un id generato.
    const scopedSteps: ItineraryStepContent[] = [
      ...steps,
      { id: "solo-squadra-1", number: 99, type: "textMatch", title: "riservata", body: "", config: {}, points: 5, groups: ["1"] },
    ];
    const scopedRoutes = generateItineraryRoutes(scopedSteps, teams, { minGuideDistance: 2 });
    expect(scopedRoutes.find((r) => r.teamId === "team-0")!.sequence).toContain(99); // team-0 ha index 0 -> numero ordinale 1
    expect(scopedRoutes.find((r) => r.teamId === "team-1")!.sequence).not.toContain(99);
  });

  it("con una sola squadra non lancia eccezioni e produce comunque un percorso valido", () => {
    const single = generateItineraryRoutes(steps, [{ id: "solo", index: 0 }], { minGuideDistance: 2 });
    expect(single.length).toBe(1);
    expect(single[0].sequence.length).toBe(steps.length);
  });
});

describe("haversineMeters / computeRouteDistanceMeters", () => {
  it("calcola la distanza tra due punti sullo stesso meridiano (caso verificabile a mano)", () => {
    // 0.001° di latitudine ≈ R * (0.001° in radianti) = 6371000 * 0.001*π/180
    // ≈ 111.195 m — con dLng = 0 la formula dell'emisenoverso si riduce
    // esattamente a questo (nessuna approssimazione aggiuntiva).
    const a = { lat: 44.4939, lng: 11.3427 };
    const b = { lat: 44.4949, lng: 11.3427 };
    expect(haversineMeters(a, b)).toBeCloseTo(111.2, 0);
  });

  it("è simmetrica e nulla per lo stesso punto", () => {
    const a = { lat: 44.4939, lng: 11.3427 };
    const b = { lat: 44.5049, lng: 11.36 };
    expect(haversineMeters(a, a)).toBe(0);
    expect(haversineMeters(a, b)).toBeCloseTo(haversineMeters(b, a), 6);
  });

  const tappeConCoordinate: ItineraryStepContent[] = [
    { id: "p1", number: 1, type: "start", title: "p1", body: "", config: { lat: 44.4939, lng: 11.3427 }, points: 0 },
    { id: "p2", number: 2, type: "textMatch", title: "p2", body: "", config: { lat: 44.4949, lng: 11.3427 }, points: 0 },
    { id: "p3", number: 3, type: "textMatch", title: "p3", body: "", config: {}, points: 0 }, // senza lat/lng
    { id: "p4", number: 4, type: "finale", title: "p4", body: "", config: { lat: 44.4959, lng: 11.3427 }, points: 0 },
  ];

  it("somma le distanze tra tappe consecutive nell'ordine del percorso", () => {
    const result = computeRouteDistanceMeters([1, 2], tappeConCoordinate);
    expect(result.meters).toBeCloseTo(111.2, 0);
    expect(result.missingCoords).toEqual([]);
  });

  it("una tappa senza coordinate viene esclusa e interrompe la catena, senza far fallire il calcolo", () => {
    const result = computeRouteDistanceMeters([1, 2, 3, 4], tappeConCoordinate);
    // Conta solo il segmento 1->2 (111.2m): il segmento con "p3" (senza
    // coordinate) non è calcolabile né prima né dopo di essa.
    expect(result.meters).toBeCloseTo(111.2, 0);
    expect(result.missingCoords).toEqual([3]);
  });

  it("un percorso vuoto o con un solo punto dà distanza zero", () => {
    expect(computeRouteDistanceMeters([], tappeConCoordinate).meters).toBe(0);
    expect(computeRouteDistanceMeters([1], tappeConCoordinate).meters).toBe(0);
  });
});
