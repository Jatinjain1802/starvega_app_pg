import { Router } from "express";
import { authenticate } from "../auth.js";
import { pool } from "../db/pool.js";
import { asyncRoute, propertyIdSchema } from "../http.js";

const router = Router();

router.get(
  "/api/v1/notifications",
  authenticate,
  asyncRoute(async (req, res) => {
    const rows = await pool.query(
      'SELECT id,property_id AS "propertyId",type,title,body,data,read_at AS "readAt",created_at AS "createdAt" FROM notifications WHERE user_id=$1 ORDER BY created_at DESC LIMIT 100',
      [req.auth.userId]
    );
    res.json({ notifications: rows.rows });
  })
);
router.post(
  "/api/v1/notifications/:notificationId/read",
  authenticate,
  asyncRoute(async (req, res) => {
    const id = propertyIdSchema.safeParse(req.params.notificationId);
    if (!id.success)
      return res.status(400).json({ error: "Invalid notification id" });
    const row = await pool.query(
      'UPDATE notifications SET read_at=COALESCE(read_at,now()) WHERE id=$1 AND user_id=$2 RETURNING id,read_at AS "readAt"',
      [id.data, req.auth.userId]
    );
    if (!row.rowCount)
      return res.status(404).json({ error: "Notification not found" });
    res.json({ notification: row.rows[0] });
  })
);

export default router;
