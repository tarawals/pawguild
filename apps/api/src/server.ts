import { buildApp } from "./app";
import { loadConfig } from "./config";
import { createDb } from "./db";

const config = loadConfig();
const db = createDb(config.DATABASE_URL);
const app = await buildApp({ db, config, logger: true });
await app.listen({ port: config.PORT, host: config.HOST });

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, async () => {
    await app.close();
    await db.destroy();
    process.exit(0);
  });
}
