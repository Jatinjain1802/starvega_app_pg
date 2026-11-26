import { Router } from "express";
import { z } from "zod";
import { authenticate } from "../auth.js";
import { pool } from "../db/pool.js";
import {
  asyncRoute,
  parsedPropertyId,
  membership,
  propertyIdSchema,
} from "../http.js";

const router = Router();

// Property setup and role scoped overview.
router.post(
  "/api/v1/properties",
  authenticate,
  asyncRoute(async (req, res) => {
    const parsed = z
      .object({
        name: z.string().trim().min(1).max(120),
        address: z.string().trim().min(1).max(500),
      })
      .safeParse(req.body);
    if (!parsed.success)
      return res
        .status(400)
        .json({ error: "Invalid PG details", details: parsed.error.flatten() });
    const isOwner = await pool.query(
      "SELECT 1 FROM memberships WHERE user_id=$1 AND role='OWNER' AND status='ACTIVE' LIMIT 1",
      [req.auth.userId]
    );
    if (!isOwner.rowCount)
      return res
        .status(403)
        .json({ error: "Only an owner can add another PG" });
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const property = await client.query(
        "INSERT INTO properties(name,address) VALUES($1,$2) RETURNING id,name,address",
        [parsed.data.name, parsed.data.address]
      );
      await client.query(
        "INSERT INTO memberships(user_id,property_id,role) VALUES($1,$2,'OWNER')",
        [req.auth.userId, property.rows[0].id]
      );
      await client.query("COMMIT");
      res.status(201).json({ property: property.rows[0] });
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  })
);

router.get(
  "/api/v1/properties",
  authenticate,
  asyncRoute(async (req, res) => {
    const result = await pool.query(
      `SELECT p.id, p.name, p.address, m.role FROM memberships m JOIN properties p ON p.id=m.property_id
       WHERE m.user_id=$1 AND m.status='ACTIVE' ORDER BY p.name`,
      [req.auth.userId]
    );
    res.json({ properties: result.rows });
  })
);

router.patch(
  "/api/v1/properties/:propertyId",
  authenticate,
  asyncRoute(async (req, res) => {
    const id = parsedPropertyId(req, res);
    if (!id) return;
    const parsed = z
      .object({
        name: z.string().trim().min(1).max(120).optional(),
        address: z.string().trim().min(1).max(500).optional(),
      })
      .refine((v) => Object.keys(v).length > 0)
      .safeParse(req.body);
    if (!parsed.success)
      return res
        .status(400)
        .json({
          error: "Provide a valid property name or address",
          details: parsed.error.flatten(),
        });
    if (!(await membership(req.auth.userId, id, ["OWNER"])))
      return res
        .status(403)
        .json({ error: "Only an owner can update PG details" });
    const row = await pool.query(
      "UPDATE properties SET name=COALESCE($1,name),address=COALESCE($2,address) WHERE id=$3 RETURNING id,name,address",
      [parsed.data.name ?? null, parsed.data.address ?? null, id]
    );
    res.json({ property: row.rows[0] });
  })
);

router.get(
  "/api/v1/properties/:propertyId/members",
  authenticate,
  asyncRoute(async (req, res) => {
    const id = parsedPropertyId(req, res);
    if (!id) return;
    if (!(await membership(req.auth.userId, id, ["OWNER", "MANAGER"])))
      return res.status(403).json({ error: "You do not manage this property" });
    const rows = await pool.query(
      `SELECT m.id AS "membershipId",m.user_id AS "userId",u.name,u.phone,m.role,m.status,m.monthly_rent_cents AS "monthlyRentCents",m.bed_id AS "bedId",r.name AS "roomName",b.name AS "bedName"
      FROM memberships m JOIN users u ON u.id=m.user_id LEFT JOIN beds b ON b.id=m.bed_id LEFT JOIN rooms r ON r.id=b.room_id WHERE m.property_id=$1 ORDER BY m.role,u.name`,
      [id]
    );
    res.json({ members: rows.rows });
  })
);

router.get(
  "/api/v1/properties/:propertyId/dashboard",
  authenticate,
  asyncRoute(async (req, res) => {
    const id = parsedPropertyId(req, res);
    if (!id) return;
    const allowed = await membership(req.auth.userId, id, ["OWNER", "MANAGER"]);
    if (!allowed)
      return res.status(403).json({ error: "You do not manage this property" });
    const isOwner = await membership(req.auth.userId, id, ["OWNER"]);
    const result = await pool.query(
      `SELECT p.id, p.name, p.address,
        (SELECT count(*)::int FROM rooms r WHERE r.property_id=p.id) AS "totalRooms",
        (SELECT count(*)::int FROM beds b WHERE b.property_id=p.id) AS "totalBeds",
        (SELECT count(*)::int FROM memberships m WHERE m.property_id=p.id AND m.role='RESIDENT' AND m.status='ACTIVE') AS "residents",
        (SELECT count(*)::int FROM memberships m WHERE m.property_id=p.id AND m.role='RESIDENT' AND m.status='ACTIVE' AND m.bed_id IS NOT NULL) AS "occupiedBeds",
        ((SELECT count(*) FROM beds b WHERE b.property_id=p.id) - (SELECT count(*) FROM memberships m WHERE m.property_id=p.id AND m.role='RESIDENT' AND m.status='ACTIVE' AND m.bed_id IS NOT NULL))::int AS "emptyBeds",
        (SELECT COALESCE(sum(GREATEST(d.amount_cents - COALESCE(x.paid,0),0)),0)::int FROM rent_dues d LEFT JOIN
          (SELECT rent_due_id, sum(amount_cents)::int paid FROM payments WHERE status='SUCCEEDED' GROUP BY rent_due_id) x ON x.rent_due_id=d.id
         WHERE d.property_id=p.id AND d.month=date_trunc('month',CURRENT_DATE)::date) AS "monthlyDueCents",
        (SELECT COALESCE(sum(pay.amount_cents),0)::int FROM payments pay JOIN rent_dues d ON d.id=pay.rent_due_id
         WHERE d.property_id=p.id AND pay.status='SUCCEEDED' AND date_trunc('month',pay.paid_at)=date_trunc('month',CURRENT_DATE)) AS "monthlyRevenueCents",
        (SELECT COALESCE(sum(amount_cents),0)::int FROM expenses e WHERE e.property_id=p.id AND date_trunc('month',e.created_at)=date_trunc('month',CURRENT_DATE)) AS "monthlyExpensesCents"
        ,(SELECT COALESCE(sum(pay.amount_cents),0)::int FROM payments pay JOIN rent_dues d ON d.id=pay.rent_due_id WHERE d.property_id=p.id AND pay.status='SUCCEEDED') AS "totalRevenueCents"
        ,(SELECT COALESCE(sum(e.amount_cents),0)::int FROM expenses e WHERE e.property_id=p.id) AS "totalExpensesCents"
       FROM properties p WHERE p.id=$1`,
      [id]
    );
    const dashboard = result.rows[0];
    if (!isOwner) {
      delete dashboard.monthlyRevenueCents;
      delete dashboard.totalRevenueCents;
    }
    res.json({ dashboard });
  })
);

router.patch(
  "/api/v1/properties/:propertyId/members/:memberId",
  authenticate,
  asyncRoute(async (req, res) => {
    const id = parsedPropertyId(req, res);
    if (!id) return;
    const memberId = propertyIdSchema.safeParse(req.params.memberId),
      parsed = z
        .object({ status: z.enum(["ACTIVE", "INACTIVE"]) })
        .safeParse(req.body);
    if (!memberId.success || !parsed.success)
      return res.status(400).json({ error: "Invalid membership update" });
    if (!(await membership(req.auth.userId, id, ["OWNER"])))
      return res
        .status(403)
        .json({ error: "Only an owner can change property access" });
    const row = await pool.query(
      "UPDATE memberships SET status=$1 WHERE id=$2 AND property_id=$3 AND role IN ('MANAGER','RESIDENT') RETURNING id,user_id AS \"userId\",role,status",
      [parsed.data.status, memberId.data, id]
    );
    if (!row.rowCount)
      return res.status(404).json({ error: "Membership not found" });
    if (row.rows[0].status === "INACTIVE" && row.rows[0].role === "RESIDENT")
      await pool.query("UPDATE memberships SET bed_id=NULL WHERE id=$1", [
        memberId.data,
      ]);
    if (row.rows[0].role === "MANAGER")
      await pool.query(
        "INSERT INTO notifications(user_id,property_id,type,title,body,data) SELECT user_id,$1,'MANAGER_UPDATED','PG manager updated','The PG manager assignment changed',$2 FROM memberships WHERE property_id=$1 AND role='RESIDENT' AND status='ACTIVE'",
        [
          id,
          JSON.stringify({
            membershipId: memberId.data,
            status: row.rows[0].status,
          }),
        ]
      );
    res.json({ membership: row.rows[0] });
  })
);

router.patch(
  "/api/v1/properties/:propertyId/residents/:residentId/rent",
  authenticate,
  asyncRoute(async (req, res) => {
    const id = parsedPropertyId(req, res);
    if (!id) return;
    const residentId = propertyIdSchema.safeParse(req.params.residentId),
      parsed = z
        .object({
          monthlyRentCents: z.number().int().positive().max(2147483647),
        })
        .safeParse(req.body);
    if (!residentId.success || !parsed.success)
      return res
        .status(400)
        .json({
          error: "Provide a valid resident id and positive monthly rent",
        });
    if (!(await membership(req.auth.userId, id, ["OWNER"])))
      return res
        .status(403)
        .json({ error: "Only an owner can change rent assignments" });
    const row = await pool.query(
      "UPDATE memberships SET monthly_rent_cents=$1 WHERE user_id=$2 AND property_id=$3 AND role='RESIDENT' AND status='ACTIVE' RETURNING id,user_id AS \"residentId\",monthly_rent_cents AS \"monthlyRentCents\"",
      [parsed.data.monthlyRentCents, residentId.data, id]
    );
    if (!row.rowCount)
      return res.status(404).json({ error: "Active resident not found" });
    await pool.query(
      "INSERT INTO notifications(user_id,property_id,type,title,body,data) VALUES($1,$2,'RENT_UPDATED','Rent amount updated','Your monthly rent assignment was updated. New rent dues use this amount.',$3)",
      [
        residentId.data,
        id,
        JSON.stringify({ monthlyRentCents: parsed.data.monthlyRentCents }),
      ]
    );
    res.json({ resident: row.rows[0] });
  })
);

router.post(
  "/api/v1/properties/:propertyId/rooms",
  authenticate,
  asyncRoute(async (req, res) => {
    const id = parsedPropertyId(req, res);
    if (!id) return;
    const parsed = z
      .object({
        name: z.string().trim().min(1).max(80),
        bedCount: z.number().int().min(1).max(100),
      })
      .safeParse(req.body);
    if (!parsed.success)
      return res
        .status(400)
        .json({
          error: "Invalid room details",
          details: parsed.error.flatten(),
        });
    if (!(await membership(req.auth.userId, id, ["OWNER"])))
      return res.status(403).json({ error: "Only an owner can set up rooms" });
    const c = await pool.connect();
    try {
      await c.query("BEGIN");
      const room = await c.query(
        "INSERT INTO rooms(property_id,name) VALUES($1,$2) RETURNING id,name",
        [id, parsed.data.name]
      );
      for (let n = 1; n <= parsed.data.bedCount; n++)
        await c.query(
          "INSERT INTO beds(property_id,room_id,name) VALUES($1,$2,$3)",
          [id, room.rows[0].id, String(n)]
        );
      await c.query("COMMIT");
      res
        .status(201)
        .json({ room: { ...room.rows[0], bedCount: parsed.data.bedCount } });
    } catch (e) {
      await c.query("ROLLBACK");
      throw e;
    } finally {
      c.release();
    }
  })
);

router.get(
  "/api/v1/properties/:propertyId/rooms",
  authenticate,
  asyncRoute(async (req, res) => {
    const id = parsedPropertyId(req, res);
    if (!id) return;
    if (!(await membership(req.auth.userId, id, ["OWNER", "MANAGER"])))
      return res.status(403).json({ error: "You do not manage this property" });
    const result = await pool.query(
      `SELECT r.id,r.name,COALESCE(json_agg(json_build_object('id',b.id,'name',b.name,'residentId',m.user_id,'residentName',u.name)) FILTER(WHERE b.id IS NOT NULL),'[]') beds
      FROM rooms r LEFT JOIN beds b ON b.room_id=r.id LEFT JOIN memberships m ON m.bed_id=b.id AND m.status='ACTIVE' LEFT JOIN users u ON u.id=m.user_id
      WHERE r.property_id=$1 GROUP BY r.id ORDER BY r.name`,
      [id]
    );
    res.json({ rooms: result.rows });
  })
);

router.post(
  "/api/v1/properties/:propertyId/rooms/:roomId/beds",
  authenticate,
  asyncRoute(async (req, res) => {
    const propertyId = parsedPropertyId(req, res);
    if (!propertyId) return;
    const roomId = propertyIdSchema.safeParse(req.params.roomId),
      parsed = z
        .object({ name: z.string().trim().min(1).max(40) })
        .safeParse(req.body);
    if (!roomId.success || !parsed.success)
      return res.status(400).json({ error: "Invalid room or bed details" });
    if (!(await membership(req.auth.userId, propertyId, ["OWNER"])))
      return res.status(403).json({ error: "Only an owner can add beds" });
    const result = await pool.query(
      'INSERT INTO beds(property_id,room_id,name) SELECT $1,id,$3 FROM rooms WHERE id=$2 AND property_id=$1 RETURNING id,room_id AS "roomId",name',
      [propertyId, roomId.data, parsed.data.name]
    );
    if (!result.rowCount)
      return res.status(404).json({ error: "Room not found" });
    res.status(201).json({ bed: result.rows[0] });
  })
);

router.put(
  "/api/v1/properties/:propertyId/residents/:residentId/bed",
  authenticate,
  asyncRoute(async (req, res) => {
    const id = parsedPropertyId(req, res);
    if (!id) return;
    const rid = propertyIdSchema.safeParse(req.params.residentId),
      parsed = z
        .object({ bedId: propertyIdSchema.nullable() })
        .safeParse(req.body);
    if (!rid.success || !parsed.success)
      return res.status(400).json({ error: "Invalid resident or bed details" });
    if (!(await membership(req.auth.userId, id, ["OWNER"])))
      return res.status(403).json({ error: "Only an owner can assign beds" });
    const resident = await pool.query(
      "SELECT id FROM memberships WHERE user_id=$1 AND property_id=$2 AND role='RESIDENT' AND status='ACTIVE'",
      [rid.data, id]
    );
    if (!resident.rowCount)
      return res.status(404).json({ error: "Active resident not found" });
    if (parsed.data.bedId) {
      const bed = await pool.query(
        "SELECT 1 FROM beds WHERE id=$1 AND property_id=$2",
        [parsed.data.bedId, id]
      );
      if (!bed.rowCount)
        return res
          .status(400)
          .json({ error: "Bed does not belong to this property" });
    }
    await pool.query(
      "UPDATE memberships SET bed_id=$1 WHERE user_id=$2 AND property_id=$3 AND role='RESIDENT' AND status='ACTIVE'",
      [parsed.data.bedId, rid.data, id]
    );
    res.json({ ok: true });
  })
);

router.get(
  "/api/v1/properties/:propertyId/manager-contact",
  authenticate,
  asyncRoute(async (req, res) => {
    const id = parsedPropertyId(req, res);
    if (!id) return;
    if (
      !(await membership(req.auth.userId, id, ["OWNER", "MANAGER", "RESIDENT"]))
    )
      return res
        .status(403)
        .json({ error: "You are not a member of this property" });
    const result = await pool.query(
      "SELECT u.id,u.name,u.phone FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.property_id=$1 AND m.role='MANAGER' AND m.status='ACTIVE' ORDER BY m.created_at LIMIT 1",
      [id]
    );
    res.json({ manager: result.rows[0] ?? null });
  })
);

export default router;
