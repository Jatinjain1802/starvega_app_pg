import pg from "pg";
import { config } from "../config.js";

const { Pool } = pg;
export const pool = new Pool({
  connectionString: config.DATABASE_URL,
  connectionTimeoutMillis: 5_000,
  idleTimeoutMillis: 30_000,
  options: "-c timezone=Asia/Kolkata -c statement_timeout=30000",
});
