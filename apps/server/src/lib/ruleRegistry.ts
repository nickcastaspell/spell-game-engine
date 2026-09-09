// Registro dei nomi di regola conosciuti dal server. Una game definition
// può dichiarare una regola per nome (es. "classificationScoring":
// "lessIsMore.classification.v1"); se il nome non corrisponde a nulla di
// registrato, la pubblicazione viene rifiutata invece di scoprirlo solo a
// runtime (o mai, dato che oggi il valore non è comunque usato — vedi
// nota sotto).
//
// NOTA (debito tecnico, v5.1 non lo risolve): il modulo `classification`
// calcola ancora il punteggio al suo interno (expectedCategory,
// pointsPerCorrect) invece di delegare a una RuleStrategy esterna
// selezionata da questo nome. Registrare il nome qui valida solo che la
// game definition sia internamente coerente, non implica che la regola
// dichiarata sia davvero quella eseguita. Vedi packages/game-core/src/ruleStrategy.ts.
export const KNOWN_RULES = new Set<string>(["lessIsMore.classification.v1"]);
