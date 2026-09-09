import {
  ModuleRegistry,
  classificationModule,
  textMatchModule,
  photoApprovalModule,
  startModule,
  voucherModule,
  finaleModule,
} from "@spell/game-core";

// Punto unico in cui l'applicazione dichiara quali moduli di attività
// sono disponibili. game-core non ne sa nulla a priori (spec §4, §10).
export const moduleRegistry = new ModuleRegistry();
moduleRegistry.register(classificationModule);
// Moduli usati dalle tappe di fasi "itinerary" (Il mistero della città).
moduleRegistry.register(textMatchModule);
moduleRegistry.register(photoApprovalModule);
moduleRegistry.register(startModule);
moduleRegistry.register(voucherModule);
moduleRegistry.register(finaleModule);
