import jwt from "jsonwebtoken";
import { config } from "./config.js";
import { pool } from "./db/pool.js";

export function authenticate(req, res, next) {
  const authorization = req.header("authorization");
  const token = authorization?.startsWith("Bearer ")
    ? authorization.slice(7)
    : undefined;
  if (!token) {
    res.status(401).json({ error: "Authentication required" });
    return;
  }

  try {
    const payload = jwt.verify(token, config.JWT_SECRET);
    if (typeof payload === "string" || typeof payload.sub !== "string") {
      res.status(401).json({ error: "Invalid authentication token" });
      return;
    }
    req.auth = { userId: payload.sub };
    next();
  } catch {
    res.status(401).json({ error: "Invalid or expired authentication token" });
  }
}

export async function requireMembership(userId, propertyId, roles) {
  const result = await pool.query(
    `SELECT 1 FROM memberships
     WHERE user_id = $1 AND property_id = $2 AND role = ANY($3::membership_role[])
       AND status = 'ACTIVE'`,
    [userId, propertyId, roles]
  );
  return (result.rowCount ?? 0) > 0;
}

export function issueToken(userId) {
  return jwt.sign({}, config.JWT_SECRET, {
    subject: userId,
    expiresIn: config.JWT_EXPIRES_IN,
  });
}
