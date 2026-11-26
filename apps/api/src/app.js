import express from "express";
import cors from "cors";
import helmet from "helmet";
import { pool } from "./db/pool.js";
import { asyncRoute } from "./http.js";
import { registerRoutes } from "./routes/index.js";

const app = express();
app.disable("x-powered-by");
app.use(helmet());
app.use(cors());
app.use(
  express.json({
    limit: "8mb",
    verify: (req, _res, buffer) => {
      req.rawBody = Buffer.from(buffer);
    },
  })
);

app.get("/health", (_req, res) => res.json({ status: "ok" }));
app.get(
  "/ready",
  asyncRoute(async (_req, res) => {
    await pool.query("SELECT 1");
    res.json({ status: "ready" });
  })
);

registerRoutes(app);

app.use((_req, res) => res.status(404).json({ error: "API route not found" }));
app.use((error, _req, res, _next) => {
  if (error && error.type === "entity.too.large") {
    res.status(413).json({ error: "Request body is too large" });
    return;
  }
  if (error instanceof SyntaxError && "body" in error) {
    res.status(400).json({ error: "Request body must be valid JSON" });
    return;
  }
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "23505"
  ) {
    res
      .status(409)
      .json({ error: "A record with those details already exists" });
    return;
  }
  console.error("Request failed", error);
  res.status(500).json({ error: "An unexpected server error occurred" });
});

export { app };
