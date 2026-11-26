import { Router } from "express";
import { z } from "zod";
import { authenticate } from "../auth.js";
import { pool } from "../db/pool.js";
import { asyncRoute, parsedPropertyId, membership } from "../http.js";

const router = Router();

router.post(
  "/api/v1/properties/:propertyId/announcements",
  authenticate,
  asyncRoute(async (req, res) => {
    const id = parsedPropertyId(req, res);
    if (!id) return;
    const parsed = z
      .object({
        title: z.string().trim().min(1).max(160),
        body: z.string().trim().min(1).max(5000),
      })
      .safeParse(req.body);
    if (!parsed.success)
      return res
        .status(400)
        .json({
          error: "Invalid announcement",
          details: parsed.error.flatten(),
        });
    if (!(await membership(req.auth.userId, id, ["OWNER", "MANAGER"])))
      return res.status(403).json({ error: "You do not manage this property" });
    const c = await pool.connect();
    try {
      await c.query("BEGIN");
      const row = await c.query(
        "INSERT INTO announcements(property_id,posted_by,title,body) VALUES($1,$2,$3,$4) RETURNING *",
        [id, req.auth.userId, parsed.data.title, parsed.data.body]
      );
      await c.query(
        "INSERT INTO notifications(user_id,property_id,type,title,body,data) SELECT user_id,$1,'ANNOUNCEMENT',$2,$3,$4 FROM memberships WHERE property_id=$1 AND status='ACTIVE' AND role='RESIDENT'",
        [
          id,
          parsed.data.title,
          parsed.data.body,
          JSON.stringify({ announcementId: row.rows[0].id }),
        ]
      );
      await c.query("COMMIT");
      res.status(201).json({ announcement: row.rows[0] });
    } catch (e) {
      await c.query("ROLLBACK");
      throw e;
    } finally {
      c.release();
    }
  })
);
router.get(
  "/api/v1/properties/:propertyId/announcements",
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
    const rows = await pool.query(
      'SELECT a.id,a.title,a.body,a.created_at AS "createdAt",u.name AS "postedBy" FROM announcements a JOIN users u ON u.id=a.posted_by WHERE a.property_id=$1 ORDER BY a.created_at DESC',
      [id]
    );
    res.json({ announcements: rows.rows });
  })
);

export default router;
