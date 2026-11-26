import { Router } from "express";
import { z } from "zod";
import { authenticate, requireMembership } from "../auth.js";
import { pool } from "../db/pool.js";
import { dueDateSchema, monthSchema, monthStart } from "../rent.js";
import { propertyIdSchema } from "../http.js";

const router = Router();

router.get("/api/v1/rent-dues/me", authenticate, async (req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT d.id, d.property_id AS "propertyId", p.name AS "propertyName",
                to_char(d.month, 'YYYY-MM') AS month, d.amount_cents AS "amountCents",
                d.due_date AS "dueDate",
                COALESCE(SUM(pay.amount_cents) FILTER (WHERE pay.status = 'SUCCEEDED'), 0)::int AS "paidCents"
         FROM rent_dues d
         JOIN properties p ON p.id = d.property_id
         LEFT JOIN payments pay ON pay.rent_due_id = d.id
         WHERE d.resident_id = $1
         GROUP BY d.id, p.name
         ORDER BY d.month DESC`,
      [req.auth.userId]
    );
    res.json({ rentDues: result.rows });
  } catch (error) {
    next(error);
  }
});

router.get(
  "/api/v1/properties/:propertyId/rent-dues",
  authenticate,
  async (req, res, next) => {
    const propertyId = propertyIdSchema.safeParse(req.params.propertyId);
    if (!propertyId.success) {
      res.status(400).json({ error: "Invalid property id" });
      return;
    }
    const monthResult = monthSchema.safeParse(req.query.month);
    if (!monthResult.success) {
      res.status(400).json({ error: "Month must use YYYY-MM format" });
      return;
    }

    try {
      const allowed = await requireMembership(
        req.auth.userId,
        propertyId.data,
        ["OWNER", "MANAGER"]
      );
      if (!allowed) {
        res.status(403).json({ error: "You do not manage this property" });
        return;
      }
      const result = await pool.query(
        `SELECT d.id, d.resident_id AS "residentId", u.name AS "residentName",
                u.phone AS "residentPhone", to_char(d.month, 'YYYY-MM') AS month,
                d.amount_cents AS "amountCents", d.due_date AS "dueDate",
                COALESCE(SUM(pay.amount_cents) FILTER (WHERE pay.status = 'SUCCEEDED'), 0)::int AS "paidCents"
         FROM rent_dues d
         JOIN users u ON u.id = d.resident_id
         LEFT JOIN payments pay ON pay.rent_due_id = d.id
         WHERE d.property_id = $1 AND d.month = $2
         GROUP BY d.id, u.name, u.phone
         ORDER BY u.name`,
        [propertyId.data, monthStart(monthResult.data)]
      );
      res.json({ rentDues: result.rows });
    } catch (error) {
      next(error);
    }
  }
);

router.post(
  "/api/v1/properties/:propertyId/rent-dues/generate",
  authenticate,
  async (req, res, next) => {
    const propertyId = propertyIdSchema.safeParse(req.params.propertyId);
    if (!propertyId.success) {
      res.status(400).json({ error: "Invalid property id" });
      return;
    }
    const parsed = z
      .object({ month: monthSchema, dueDate: dueDateSchema })
      .safeParse(req.body);
    if (!parsed.success) {
      res
        .status(400)
        .json({
          error: "Provide a YYYY-MM month and valid dueDate",
          details: parsed.error.flatten(),
        });
      return;
    }

    try {
      const allowed = await requireMembership(
        req.auth.userId,
        propertyId.data,
        ["OWNER", "MANAGER"]
      );
      if (!allowed) {
        res.status(403).json({ error: "You do not manage this property" });
        return;
      }
      const result = await pool.query(
        `WITH added AS (
         INSERT INTO rent_dues (property_id, resident_id, month, amount_cents, due_date)
         SELECT m.property_id, m.user_id, $2::date, m.monthly_rent_cents, $3::date
         FROM memberships m
         WHERE m.property_id = $1 AND m.role = 'RESIDENT' AND m.status = 'ACTIVE'
           AND m.monthly_rent_cents IS NOT NULL
         ON CONFLICT (resident_id, property_id, month) DO NOTHING
         RETURNING id, resident_id, property_id, month, amount_cents
         ), notices AS (
           INSERT INTO notifications(user_id,property_id,type,title,body,data)
           SELECT resident_id,property_id,'RENT_DUE','Rent due created','Your rent for '||to_char(month,'FMMonth YYYY')||' is ready',jsonb_build_object('rentDueId',id)
           FROM added RETURNING id
         ) SELECT id,resident_id AS "residentId",amount_cents AS "amountCents" FROM added`,
        [propertyId.data, monthStart(parsed.data.month), parsed.data.dueDate]
      );
      res
        .status(201)
        .json({ created: result.rowCount ?? 0, rentDues: result.rows });
    } catch (error) {
      next(error);
    }
  }
);

export default router;
