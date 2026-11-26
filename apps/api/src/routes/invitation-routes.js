import { randomBytes, createHash } from "node:crypto";
import { Router } from "express";
import { z } from "zod";
import { authenticate, requireMembership } from "../auth.js";
import { pool } from "../db/pool.js";
import { invitationSchema, propertyIdSchema } from "../validation.js";

const router = Router();

router.post(
  "/api/v1/properties/:propertyId/invitations",
  authenticate,
  async (req, res, next) => {
    const propertyId = propertyIdSchema.safeParse(req.params.propertyId);
    if (!propertyId.success) {
      res.status(400).json({ error: "Invalid property id" });
      return;
    }
    const parsed = invitationSchema.safeParse(req.body);
    if (!parsed.success) {
      res
        .status(400)
        .json({
          error: "Invalid invitation details",
          details: parsed.error.flatten(),
        });
      return;
    }

    try {
      const ownerOrManager = await requireMembership(
        req.auth.userId,
        propertyId.data,
        ["OWNER", "MANAGER"]
      );
      if (!ownerOrManager) {
        res.status(403).json({ error: "You do not manage this property" });
        return;
      }
      const owner = await requireMembership(req.auth.userId, propertyId.data, [
        "OWNER",
      ]);
      const manager = await requireMembership(
        req.auth.userId,
        propertyId.data,
        ["MANAGER"]
      );
      if (!owner && manager && parsed.data.role !== "RESIDENT") {
        res.status(403).json({ error: "Managers can invite residents only" });
        return;
      }
      if (parsed.data.bedId) {
        const bed = await pool.query(
          "SELECT 1 FROM beds WHERE id=$1 AND property_id=$2",
          [parsed.data.bedId, propertyId.data]
        );
        if (!bed.rowCount) {
          res
            .status(400)
            .json({ error: "Bed does not belong to this property" });
          return;
        }
        const occupied = await pool.query(
          "SELECT 1 FROM memberships WHERE bed_id=$1 AND status='ACTIVE'",
          [parsed.data.bedId]
        );
        if (occupied.rowCount) {
          res
            .status(409)
            .json({ error: "Bed is already assigned to an active resident" });
          return;
        }
      }

      const token = randomBytes(32).toString("hex");
      const tokenHash = createHash("sha256").update(token).digest("hex");
      await pool.query(
        `INSERT INTO invitations (property_id, phone, role, monthly_rent_cents, bed_id, token_hash, expires_at, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, now() + interval '7 days', $7)`,
        [
          propertyId.data,
          parsed.data.phone,
          parsed.data.role,
          parsed.data.monthlyRentCents ?? null,
          parsed.data.bedId ?? null,
          tokenHash,
          req.auth.userId,
        ]
      );
      res.status(201).json({ token, expiresInDays: 7 });
    } catch (error) {
      next(error);
    }
  }
);

export default router;
