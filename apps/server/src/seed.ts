import fs from "node:fs";
import path from "node:path";
import { upsertGame, upsertGameVersion } from "./lib/repo";
import { validateGameDefinition, validateGameDefinitionSemantics, GameDefinitionValidationError } from "./lib/gameDefinitionValidation";
import { moduleRegistry } from "./modules-registry";

// Carica game-definitions/*.json come Game + GameVersion pubblicata.
// Uso: npm run seed
function main() {
  const defsDir = path.join(__dirname, "..", "..", "..", "game-definitions");
  const files = fs.readdirSync(defsDir).filter((f) => f.endsWith(".json"));

  for (const file of files) {
    const raw = fs.readFileSync(path.join(defsDir, file), "utf-8");
    const parsed = JSON.parse(raw);

    let def;
    try {
      def = validateGameDefinition(parsed); // strutturale (Zod)
      validateGameDefinitionSemantics(def, moduleRegistry); // semantica (v5.1)
    } catch (e) {
      if (e instanceof GameDefinitionValidationError) {
        console.error(`seed: ${file} NON valido:`);
        for (const issue of e.issues) console.error(`  - ${issue}`);
        process.exitCode = 1;
        continue;
      }
      throw e;
    }

    const slug = def.game.id;
    const version = def.schemaVersion;

    const game = upsertGame(slug, def.game.name);
    upsertGameVersion(game.id, version, raw);

    // eslint-disable-next-line no-console
    console.log(`seed: ${slug}@${version} caricato e validato da ${file}`);
  }
}

main();
