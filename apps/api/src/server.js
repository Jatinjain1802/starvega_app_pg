import { app } from "./app.js";
import { config } from "./config.js";
import { startRentScheduler } from "./rent-scheduler.js";
import { pool } from "./db/pool.js";

const stopRentScheduler = startRentScheduler();

const server = app.listen(config.PORT, () => {
  console.info(`Starvega API listening on port ${config.PORT}`);
});

function shutdown() {
  stopRentScheduler();
  server.close(async () => {
    console.info("HTTP server closed");
    await pool.end();
    process.exit(0);
  });
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
