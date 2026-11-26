import { Router } from "express";
import { z } from "zod";
import { authenticate } from "../auth.js";
import { pool } from "../db/pool.js";
import {
  asyncRoute,
  parsedPropertyId,
  propertyIdSchema,
  membership,
} from "../http.js";

const router = Router();

// Complaint visibility follows membership and public/private rules; likes are resident-only.
router.post(
  "/api/v1/properties/:propertyId/complaints",
  authenticate,
  asyncRoute(async (req, res) => {
    const id = parsedPropertyId(req, res);
    if (!id) return;
    const parsed = z
      .object({
        title: z.string().trim().min(1).max(160),
        description: z.string().trim().min(1).max(5000),
        visibility: z.enum(["COMMON", "PRIVATE"]),
        isSafety: z.boolean().default(false),
      })
      .safeParse(req.body);
    if (!parsed.success)
      return res
        .status(400)
        .json({ error: "Invalid complaint", details: parsed.error.flatten() });
    if (!(await membership(req.auth.userId, id, ["RESIDENT"])))
      return res
        .status(403)
        .json({ error: "Only residents can raise complaints" });
    const c = await pool.connect();
    try {
      await c.query("BEGIN");
      const row = await c.query(
        `INSERT INTO complaints(property_id,raised_by,title,description,visibility,is_safety) VALUES($1,$2,$3,$4,$5,$6) RETURNING *`,
        [
          id,
          req.auth.userId,
          parsed.data.title,
          parsed.data.description,
          parsed.data.visibility,
          parsed.data.isSafety,
        ]
      );
      await c.query(
        "INSERT INTO complaint_events(complaint_id,actor_id,action) VALUES($1,$2,'CREATED')",
        [row.rows[0].id, req.auth.userId]
      );
      const recipients = await c.query(
        "SELECT user_id FROM memberships WHERE property_id=$1 AND status='ACTIVE' AND role IN ('OWNER','MANAGER')",
        [id]
      );
      if (parsed.data.visibility === "COMMON") {
        const residents = await c.query(
          "SELECT user_id FROM memberships WHERE property_id=$1 AND status='ACTIVE' AND role='RESIDENT'",
          [id]
        );
        recipients.rows.push(...residents.rows);
      }
      for (const recipient of recipients.rows)
        await c.query(
          "INSERT INTO notifications(user_id,property_id,type,title,body,data) VALUES($1,$2,'COMPLAINT','New complaint',$3,$4)",
          [
            recipient.user_id,
            id,
            parsed.data.title,
            JSON.stringify({ complaintId: row.rows[0].id }),
          ]
        );
      await c.query("COMMIT");
      res.status(201).json({ complaint: row.rows[0] });
    } catch (e) {
      await c.query("ROLLBACK");
      throw e;
    } finally {
      c.release();
    }
  })
);

router.get(
  "/api/v1/properties/:propertyId/complaints",
  authenticate,
  asyncRoute(async (req, res) => {
    const id = parsedPropertyId(req, res);
    if (!id) return;
    const roles = ["OWNER", "MANAGER", "RESIDENT"];
    if (!(await membership(req.auth.userId, id, roles)))
      return res
        .status(403)
        .json({ error: "You are not a member of this property" });
    const isResident = await membership(req.auth.userId, id, ["RESIDENT"]);
    const result = await pool.query(
      `SELECT c.id,c.property_id AS "propertyId",c.raised_by AS "raisedBy",c.title,c.description,c.visibility,c.is_safety AS "isSafety",c.status,c.created_at AS "createdAt",c.solved_at AS "solvedAt",
      CASE WHEN NOT $3 OR c.raised_by=$2 THEN u.name ELSE NULL END AS "raisedByName",
      count(l.user_id)::int AS likes, COALESCE(bool_or(l.user_id=$2),false) AS "likedByMe"
      FROM complaints c JOIN users u ON u.id=c.raised_by LEFT JOIN complaint_likes l ON l.complaint_id=c.id
      WHERE c.property_id=$1 AND (c.visibility='COMMON' OR c.raised_by=$2 OR NOT $3) GROUP BY c.id,u.name ORDER BY c.is_safety DESC,likes DESC,c.created_at DESC`,
      [id, req.auth.userId, isResident]
    );
    res.json({ complaints: result.rows });
  })
);

router.post(
  "/api/v1/complaints/:complaintId/like",
  authenticate,
  asyncRoute(async (req, res) => {
    const cid = propertyIdSchema.safeParse(req.params.complaintId);
    if (!cid.success)
      return res.status(400).json({ error: "Invalid complaint id" });
    const c = await pool.connect();
    try {
      await c.query("BEGIN");
      const complaint = await c.query(
        "SELECT property_id FROM complaints WHERE id=$1 AND visibility='COMMON'",
        [cid.data]
      );
      if (!complaint.rowCount) {
        await c.query("ROLLBACK");
        return res.status(404).json({ error: "Common complaint not found" });
      }
      if (
        !(await membership(req.auth.userId, complaint.rows[0].property_id, [
          "RESIDENT",
        ]))
      ) {
        await c.query("ROLLBACK");
        return res
          .status(403)
          .json({ error: "Only residents can like complaints" });
      }
      await c.query(
        "INSERT INTO complaint_likes(complaint_id,user_id) VALUES($1,$2) ON CONFLICT DO NOTHING",
        [cid.data, req.auth.userId]
      );
      await c.query("COMMIT");
      res.json({ liked: true });
    } catch (e) {
      await c.query("ROLLBACK");
      throw e;
    } finally {
      c.release();
    }
  })
);

router.post(
  "/api/v1/complaints/:complaintId/solve",
  authenticate,
  asyncRoute(async (req, res) => {
    const cid = propertyIdSchema.safeParse(req.params.complaintId);
    if (!cid.success)
      return res.status(400).json({ error: "Invalid complaint id" });
    const c = await pool.connect();
    try {
      await c.query("BEGIN");
      const found = await c.query(
        "SELECT property_id,status FROM complaints WHERE id=$1 FOR UPDATE",
        [cid.data]
      );
      if (!found.rowCount) {
        await c.query("ROLLBACK");
        return res.status(404).json({ error: "Complaint not found" });
      }
      if (
        !(await membership(req.auth.userId, found.rows[0].property_id, [
          "OWNER",
          "MANAGER",
        ]))
      ) {
        await c.query("ROLLBACK");
        return res
          .status(403)
          .json({ error: "You do not manage this property" });
      }
      if (found.rows[0].status === "OPEN") {
        await c.query(
          "UPDATE complaints SET status='SOLVED',solved_at=now(),solved_by=$2,updated_at=now() WHERE id=$1",
          [cid.data, req.auth.userId]
        );
        await c.query(
          "INSERT INTO complaint_events(complaint_id,actor_id,action) VALUES($1,$2,'SOLVED')",
          [cid.data, req.auth.userId]
        );
        await c.query(
          "INSERT INTO notifications(user_id,property_id,type,title,body,data) SELECT DISTINCT m.user_id,$2,'COMPLAINT_UPDATE','Complaint solved','A complaint you can view was marked solved',$3 FROM memberships m JOIN complaints c ON c.id=$1 WHERE m.property_id=$2 AND m.status='ACTIVE' AND (m.role IN ('OWNER','MANAGER') OR c.visibility='COMMON' OR c.raised_by=m.user_id)",
          [
            cid.data,
            found.rows[0].property_id,
            JSON.stringify({ complaintId: cid.data }),
          ]
        );
      }
      await c.query("COMMIT");
      res.json({ status: "SOLVED" });
    } catch (e) {
      await c.query("ROLLBACK");
      throw e;
    } finally {
      c.release();
    }
  })
);

router.post(
  "/api/v1/complaints/:complaintId/reopen",
  authenticate,
  asyncRoute(async (req, res) => {
    const cid = propertyIdSchema.safeParse(req.params.complaintId);
    if (!cid.success)
      return res.status(400).json({ error: "Invalid complaint id" });
    const c = await pool.connect();
    try {
      await c.query("BEGIN");
      const row = await c.query(
        "SELECT property_id,raised_by,status FROM complaints WHERE id=$1 FOR UPDATE",
        [cid.data]
      );
      if (!row.rowCount) {
        await c.query("ROLLBACK");
        return res.status(404).json({ error: "Complaint not found" });
      }
      if (
        !(await membership(req.auth.userId, row.rows[0].property_id, [
          "OWNER",
          "MANAGER",
        ])) &&
        row.rows[0].raised_by !== req.auth.userId
      ) {
        await c.query("ROLLBACK");
        return res
          .status(403)
          .json({ error: "Only the reporter or property staff can reopen" });
      }
      if (row.rows[0].status === "SOLVED") {
        await c.query(
          "UPDATE complaints SET status='OPEN',solved_at=NULL,solved_by=NULL,updated_at=now() WHERE id=$1",
          [cid.data]
        );
        await c.query(
          "INSERT INTO complaint_events(complaint_id,actor_id,action) VALUES($1,$2,'REOPENED')",
          [cid.data, req.auth.userId]
        );
        await c.query(
          "INSERT INTO notifications(user_id,property_id,type,title,body,data) SELECT DISTINCT m.user_id,$2,'COMPLAINT_UPDATE','Complaint reopened','A complaint you can view was reopened',$3 FROM memberships m JOIN complaints c ON c.id=$1 WHERE m.property_id=$2 AND m.status='ACTIVE' AND (m.role IN ('OWNER','MANAGER') OR c.visibility='COMMON' OR c.raised_by=m.user_id)",
          [
            cid.data,
            row.rows[0].property_id,
            JSON.stringify({ complaintId: cid.data }),
          ]
        );
      }
      await c.query("COMMIT");
      res.json({ status: "OPEN" });
    } catch (e) {
      await c.query("ROLLBACK");
      throw e;
    } finally {
      c.release();
    }
  })
);

router.get(
  "/api/v1/complaints/:complaintId/history",
  authenticate,
  asyncRoute(async (req, res) => {
    const cid = propertyIdSchema.safeParse(req.params.complaintId);
    if (!cid.success)
      return res.status(400).json({ error: "Invalid complaint id" });
    const row = await pool.query(
      "SELECT property_id,raised_by,visibility FROM complaints WHERE id=$1",
      [cid.data]
    );
    if (!row.rowCount)
      return res.status(404).json({ error: "Complaint not found" });
    const role = await membership(req.auth.userId, row.rows[0].property_id, [
      "OWNER",
      "MANAGER",
      "RESIDENT",
    ]);
    if (
      !role ||
      (row.rows[0].visibility === "PRIVATE" &&
        row.rows[0].raised_by !== req.auth.userId &&
        !(await membership(req.auth.userId, row.rows[0].property_id, [
          "OWNER",
          "MANAGER",
        ])))
    )
      return res.status(403).json({ error: "You cannot view this complaint" });
    const events = await pool.query(
      'SELECT e.action,e.created_at AS "createdAt",u.name AS "actorName" FROM complaint_events e JOIN users u ON u.id=e.actor_id WHERE e.complaint_id=$1 ORDER BY e.created_at',
      [cid.data]
    );
    res.json({ history: events.rows });
  })
);

export default router;
