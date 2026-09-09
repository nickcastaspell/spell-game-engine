import { GameModule } from "@spell/shared-types";

/**
 * Registro dei moduli di attività disponibili nel motore.
 * game-core non conosce i contenuti di nessun gioco specifico:
 * i moduli vengono registrati dall'applicazione che li usa
 * (vedi apps/server/src/modules-registry.ts).
 */
export class ModuleRegistry {
  private modules = new Map<string, GameModule>();

  register(mod: GameModule): void {
    if (this.modules.has(mod.type)) {
      throw new Error(`Modulo già registrato: ${mod.type}`);
    }
    this.modules.set(mod.type, mod);
  }

  get(type: string): GameModule {
    const mod = this.modules.get(type);
    if (!mod) {
      throw new Error(`Modulo non registrato: ${type}`);
    }
    return mod;
  }

  has(type: string): boolean {
    return this.modules.has(type);
  }
}
