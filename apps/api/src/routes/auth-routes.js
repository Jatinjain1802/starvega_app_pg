import { createHash } from "node:crypto";
import bcrypt from "bcryptjs";
import { Router } from "express";
import { z } from "zod";
import { authenticate, issueToken } from "../auth.js";
import { pool } from "../db/pool.js";
import {
  acceptInvitationSchema,
  ownerRegistrationSchema,
  phoneSchema,
} from "../validation.js";

const router = Router();

router.post("/api/v1/auth/register-owner", async (req, res, next) => {
  const parsed = ownerRegistrationSchema.safeParse(req.body);
  if (!parsed.success) {
    res
      .status(400)
      .json({
        error: "Invalid registration details",
        details: parsed.error.flatten(),
      });
    return;
  }

  const client = await pool.connect();
  try {
    const { name, phone, password, propertyName, address } = parsed.data;
    const passwordHash = await bcrypt.hash(password, 12);
    await client.query("BEGIN");
    const user = await client.query(
      "INSERT INTO users (name, phone, password_hash) VALUES ($1, $2, $3) RETURNING id, name, phone",
      [name, phone, passwordHash]
    );
    const property = await client.query(
      "INSERT INTO properties (name, address) VALUES ($1, $2) RETURNING id, name, address",
      [propertyName, address]
    );
    await client.query(
      `INSERT INTO memberships (user_id, property_id, role)
         VALUES ($1, $2, 'OWNER')`,
      [user.rows[0].id, property.rows[0].id]
    );
    await client.query("COMMIT");
    res.status(201).json({
      token: issueToken(user.rows[0].id),
      user: user.rows[0],
      property: property.rows[0],
    });
  } catch (error) {
    await client.query("ROLLBACK");
    next(error);
  } finally {
    client.release();
  }
});

router.post("/api/v1/auth/login", async (req, res, next) => {
  const parsed = z
    .object({ phone: phoneSchema, password: z.string().min(1).max(72) })
    .safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid login details" });
    return;
  }

  try {
    const result = await pool.query(
      "SELECT id, name, phone, password_hash FROM users WHERE phone = $1",
      [parsed.data.phone]
    );
    const user = result.rows[0];
    if (
      !user ||
      !(await bcrypt.compare(parsed.data.password, user.password_hash))
    ) {
      res.status(401).json({ error: "Phone number or password is incorrect" });
      return;
    }
    res.json({
      token: issueToken(user.id),
      user: { id: user.id, name: user.name, phone: user.phone },
    });
  } catch (error) {
    next(error);
  }
});

router.post("/api/v1/auth/accept-invitation", async (req, res, next) => {
  const parsed = acceptInvitationSchema.safeParse(req.body);
  if (!parsed.success) {
    res
      .status(400)
      .json({
        error: "Invalid invitation details",
        details: parsed.error.flatten(),
      });
    return;
  }

  const client = await pool.connect();
  try {
    const tokenHash = createHash("sha256")
      .update(parsed.data.token)
      .digest("hex");
    await client.query("BEGIN");
    const invitationResult = await client.query(
      `SELECT id, property_id, phone, role, monthly_rent_cents, bed_id
         FROM invitations
         WHERE token_hash = $1 AND accepted_at IS NULL AND expires_at > now()
         FOR UPDATE`,
      [tokenHash]
    );
    const invitation = invitationResult.rows[0];
    if (!invitation) {
      await client.query("ROLLBACK");
      res.status(400).json({ error: "Invitation is invalid or expired" });
      return;
    }

    const existing = await client.query(
      "SELECT id, password_hash FROM users WHERE phone = $1 FOR UPDATE",
      [invitation.phone]
    );
    let userId;
    if (existing.rowCount) {
      const passwordMatches = await bcrypt.compare(
        parsed.data.password,
        existing.rows[0].password_hash
      );
      if (!passwordMatches) {
        await client.query("ROLLBACK");
        res
          .status(401)
          .json({
            error:
              "Use the existing account password to accept this invitation",
          });
        return;
      }
      userId = existing.rows[0].id;
    } else {
      const hash = await bcrypt.hash(parsed.data.password, 12);
      const user = await client.query(
        "INSERT INTO users (name, phone, password_hash) VALUES ($1, $2, $3) RETURNING id",
        [parsed.data.name, invitation.phone, hash]
      );
      userId = user.rows[0].id;
    }

    await client.query(
      `INSERT INTO memberships (user_id, property_id, role, monthly_rent_cents, bed_id)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (user_id, property_id, role) DO UPDATE
           SET status = 'ACTIVE', monthly_rent_cents = EXCLUDED.monthly_rent_cents, bed_id = EXCLUDED.bed_id`,
      [
        userId,
        invitation.property_id,
        invitation.role,
        invitation.monthly_rent_cents,
        invitation.bed_id,
      ]
    );
    await client.query(
      "UPDATE invitations SET accepted_at = now() WHERE id = $1",
      [invitation.id]
    );
    await client.query("COMMIT");
    res.status(201).json({ token: issueToken(userId) });
  } catch (error) {
    await client.query("ROLLBACK");
    next(error);
  } finally {
    client.release();
  }
});

router.get("/api/v1/auth/me", authenticate, async (req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT u.id, u.name, u.phone,
                COALESCE(json_agg(json_build_object(
                  'propertyId', p.id, 'propertyName', p.name, 'role', m.role,
                  'monthlyRentCents', m.monthly_rent_cents
                )) FILTER (WHERE m.id IS NOT NULL), '[]') AS memberships
         FROM users u
         LEFT JOIN memberships m ON m.user_id = u.id AND m.status = 'ACTIVE'
         LEFT JOIN properties p ON p.id = m.property_id
         WHERE u.id = $1
         GROUP BY u.id`,
      [req.auth.userId]
    );
    if (!result.rowCount) {
      res.status(404).json({ error: "User account not found" });
      return;
    }
    res.json(result.rows[0]);
  } catch (error) {
    next(error);
  }
});

export default router;
