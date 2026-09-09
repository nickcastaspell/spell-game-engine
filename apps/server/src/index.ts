import { createApp } from "./app";

const app = createApp();
const port = Number(process.env.PORT ?? 3000);
app.listen(port, () => {
  // eslint-disable-next-line no-console
  console.log(`spell-game-engine server in ascolto su :${port}`);
});
