// Confronto strutturale indipendente dall'ordine delle chiavi: usato per
// decidere se una idempotencyKey ripetuta porta davvero lo stesso payload
// (spec §13) e se una game_version viene "ripubblicata" con contenuto
// identico oppure modificato (spec §7 "immutabile dopo la pubblicazione").

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    return Object.keys(obj)
      .sort()
      .reduce<Record<string, unknown>>((acc, k) => {
        acc[k] = sortKeysDeep(obj[k]);
        return acc;
      }, {});
  }
  return value;
}

export function canonicalStringify(value: unknown): string {
  return JSON.stringify(sortKeysDeep(value));
}

export function deepEqualJson(a: unknown, b: unknown): boolean {
  return canonicalStringify(a) === canonicalStringify(b);
}
