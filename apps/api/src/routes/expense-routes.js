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

router.post(
  "/api/v1/properties/:propertyId/expenses",
  authenticate,
  asyncRoute(async (req, res) => {
    const id = parsedPropertyId(req, res);
    if (!id) return;
    const parsed = z
      .object({
        title: z.string().trim().min(1).max(160),
        category: z.string().trim().min(1).max(80),
        amountCents: z.number().int().positive().max(2147483647),
        items: z
          .array(
            z.object({
              name: z.string().trim().min(1).max(160),
              quantity: z.number().positive().optional(),
              amountCents: z.number().int().nonnegative().optional(),
            })
          )
          .max(200)
          .default([]),
        receiptUrl: z.string().url().max(2048).optional(),
        notes: z.string().max(2000).optional(),
      })
      .safeParse(req.body);
    if (!parsed.success)
      return res
        .status(400)
        .json({ error: "Invalid expense", details: parsed.error.flatten() });
    if (!(await membership(req.auth.userId, id, ["OWNER", "MANAGER"])))
      return res.status(403).json({ error: "You do not manage this property" });
    const d = parsed.data;
    const c = await pool.connect();
    try {
      await c.query("BEGIN");
      const row = await c.query(
        'INSERT INTO expenses(property_id,added_by,title,category,amount_cents,items,receipt_url,notes) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id,title,category,amount_cents AS "amountCents",items,receipt_url AS "receiptUrl",notes,created_at AS "createdAt"',
        [
          id,
          req.auth.userId,
          d.title,
          d.category,
          d.amountCents,
          JSON.stringify(d.items),
          d.receiptUrl ?? null,
          d.notes ?? null,
        ]
      );
      await c.query(
        "INSERT INTO notifications(user_id,property_id,type,title,body,data) SELECT user_id,$1,'EXPENSE_ADDED','New PG expense',$2,$3 FROM memberships WHERE property_id=$1 AND role='OWNER' AND status='ACTIVE' AND user_id<>$4",
        [
          id,
          d.title,
          JSON.stringify({ expenseId: row.rows[0].id }),
          req.auth.userId,
        ]
      );
      await c.query("COMMIT");
      res.status(201).json({ expense: row.rows[0] });
    } catch (e) {
      await c.query("ROLLBACK");
      throw e;
    } finally {
      c.release();
    }
  })
);
router.get(
  "/api/v1/properties/:propertyId/expenses",
  authenticate,
  asyncRoute(async (req, res) => {
    const id = parsedPropertyId(req, res);
    if (!id) return;
    if (!(await membership(req.auth.userId, id, ["OWNER", "MANAGER"])))
      return res
        .status(403)
        .json({
          error: "Expenses are available to owner and assigned managers only",
        });
    const rows = await pool.query(
      `SELECT e.id,e.title,e.category,e.amount_cents AS "amountCents",e.items,CASE WHEN er.expense_id IS NOT NULL THEN '/api/v1/expenses/'||e.id||'/receipt' ELSE e.receipt_url END AS "receiptUrl",e.notes,e.created_at AS "createdAt",u.id AS "addedById",u.name AS "addedByName" FROM expenses e JOIN users u ON u.id=e.added_by LEFT JOIN expense_receipts er ON er.expense_id=e.id WHERE e.property_id=$1 ORDER BY e.created_at DESC`,
      [id]
    );
    res.json({ expenses: rows.rows });
  })
);

router.put(
  "/api/v1/expenses/:expenseId/receipt",
  authenticate,
  asyncRoute(async (req, res) => {
    const expenseId = propertyIdSchema.safeParse(req.params.expenseId);
    if (!expenseId.success)
      return res.status(400).json({ error: "Invalid expense id" });
    const parsed = z
      .object({
        fileName: z.string().trim().min(1).max(180),
        mimeType: z.enum([
          "application/pdf",
          "image/jpeg",
          "image/png",
          "image/webp",
        ]),
        contentBase64: z
          .string()
          .min(4)
          .max(7_000_000)
          .regex(
            /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/
          ),
      })
      .safeParse(req.body);
    if (!parsed.success)
      return res
        .status(400)
        .json({
          error: "Provide a valid PDF or image receipt",
          details: parsed.error.flatten(),
        });
    const found = await pool.query(
      "SELECT property_id FROM expenses WHERE id=$1",
      [expenseId.data]
    );
    if (!found.rowCount)
      return res.status(404).json({ error: "Expense not found" });
    if (
      !(await membership(req.auth.userId, found.rows[0].property_id, [
        "OWNER",
        "MANAGER",
      ]))
    )
      return res.status(403).json({ error: "You do not manage this property" });
    const content = Buffer.from(parsed.data.contentBase64, "base64");
    if (
      content.length === 0 ||
      content.length > 5 * 1024 * 1024 ||
      content.toString("base64") !== parsed.data.contentBase64
    )
      return res
        .status(400)
        .json({ error: "Receipt must be a valid file up to 5 MB" });
    const name = parsed.data.fileName.replace(/[\\/\\\\\r\n\0]/g, "_");
    await pool.query(
      `INSERT INTO expense_receipts(expense_id,uploaded_by,file_name,mime_type,content) VALUES($1,$2,$3,$4,$5)
      ON CONFLICT(expense_id) DO UPDATE SET uploaded_by=EXCLUDED.uploaded_by,file_name=EXCLUDED.file_name,mime_type=EXCLUDED.mime_type,content=EXCLUDED.content,created_at=now()`,
      [expenseId.data, req.auth.userId, name, parsed.data.mimeType, content]
    );
    res.json({ receiptUrl: `/api/v1/expenses/${expenseId.data}/receipt` });
  })
);
router.get(
  "/api/v1/expenses/:expenseId/receipt",
  authenticate,
  asyncRoute(async (req, res) => {
    const expenseId = propertyIdSchema.safeParse(req.params.expenseId);
    if (!expenseId.success)
      return res.status(400).json({ error: "Invalid expense id" });
    const result = await pool.query(
      `SELECT er.file_name,er.mime_type,er.content,e.property_id FROM expense_receipts er JOIN expenses e ON e.id=er.expense_id WHERE er.expense_id=$1`,
      [expenseId.data]
    );
    if (!result.rowCount)
      return res.status(404).json({ error: "Receipt not found" });
    if (
      !(await membership(req.auth.userId, result.rows[0].property_id, [
        "OWNER",
        "MANAGER",
      ]))
    )
      return res.status(403).json({ error: "You do not manage this property" });
    res
      .set("Content-Type", result.rows[0].mime_type)
      .set(
        "Content-Disposition",
        `attachment; filename="${result.rows[0].file_name.replace(
          /["\\\r\n]/g,
          "_"
        )}"`
      )
      .set("X-Content-Type-Options", "nosniff")
      .send(result.rows[0].content);
  })
);

export default router;
