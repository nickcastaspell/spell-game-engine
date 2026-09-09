// "Ambiente di sviluppo" ai fini degli strumenti extra della dashboard
// regia (reset/duplica/elimina/riapri sessione, banner DEV — vedi
// routes/dev.ts). Interpretazione scelta: tutto ciò che NON è
// esplicitamente NODE_ENV=production è sviluppo, cosi' gli strumenti sono
// disponibili anche quando NODE_ENV non e' impostato affatto (il caso più
// comune quando si lavora in locale con `npm run dev`). In produzione va
// impostato NODE_ENV=production per far sparire davvero questi strumenti
// (route non montate, non solo nascoste in UI — vedi app.ts).
export function isDevEnvironment(): boolean {
  return process.env.NODE_ENV !== "production";
}
