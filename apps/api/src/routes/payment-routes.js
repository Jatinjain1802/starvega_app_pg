import { createHmac, timingSafeEqual } from "node:crypto";
import { Router } from "express";
import { z } from "zod";
import { authenticate } from "../auth.js";
import { config } from "../config.js";
import { pool } from "../db/pool.js";
import { asyncRoute, membership, propertyIdSchema } from "../http.js";

const router = Router();

router.get(
  "/api/v1/payments/me",
  authenticate,
  asyncRoute(async (req, res) => {
    const rows = await pool.query(
      `SELECT pay.id,pay.amount_cents AS "amountCents",pay.status,pay.gateway_reference AS "gatewayReference",pay.receipt_url AS "receiptUrl",pay.created_at AS "createdAt",pay.paid_at AS "paidAt",to_char(d.month,'YYYY-MM') AS month FROM payments pay JOIN rent_dues d ON d.id=pay.rent_due_id WHERE pay.resident_id=$1 ORDER BY pay.created_at DESC`,
      [req.auth.userId]
    );
    res.json({ payments: rows.rows });
  })
);

router.post(
  "/api/v1/rent-dues/:dueId/payment-orders",
  authenticate,
  asyncRoute(async (req, res) => {
    const dueId = propertyIdSchema.safeParse(req.params.dueId);
    if (!dueId.success)
      return res.status(400).json({ error: "Invalid rent due id" });
    const keyId = config.RAZORPAY_KEY_ID,
      keySecret = config.RAZORPAY_KEY_SECRET;
    if (!keyId || !keySecret)
      return res
        .status(503)
        .json({ error: "Online payments are not configured" });
    const parsed = z
      .object({ idempotencyKey: z.string().min(8).max(120) })
      .safeParse(req.body);
    if (!parsed.success)
      return res.status(400).json({ error: "Provide an idempotencyKey" });
    const c = await pool.connect();
    try {
      await c.query("BEGIN");
      const due = await c.query(
        "SELECT id,property_id,amount_cents FROM rent_dues WHERE id=$1 AND resident_id=$2 FOR UPDATE",
        [dueId.data, req.auth.userId]
      );
      if (!due.rowCount) {
        await c.query("ROLLBACK");
        return res.status(404).json({ error: "Rent due not found" });
      }
      const du = due.rows[0];
      let payment = await c.query(
        "SELECT id,rent_due_id,resident_id,gateway_order_id,amount_cents,status FROM payments WHERE idempotency_key=$1 FOR UPDATE",
        [parsed.data.idempotencyKey]
      );
      if (payment.rowCount) {
        if (
          payment.rows[0].resident_id !== req.auth.userId ||
          payment.rows[0].rent_due_id !== du.id
        ) {
          await c.query("ROLLBACK");
          return res
            .status(409)
            .json({
              error: "Idempotency key was used for a different payment",
            });
        }
        await c.query("COMMIT");
        return res.json({
          paymentId: payment.rows[0].id,
          orderId: payment.rows[0].gateway_order_id,
          amountCents: payment.rows[0].amount_cents,
          status: payment.rows[0].status,
          keyId,
        });
      }
      const paid = await c.query(
        "SELECT COALESCE(sum(amount_cents),0)::int amount FROM payments WHERE rent_due_id=$1 AND status='SUCCEEDED'",
        [du.id]
      );
      const outstanding = du.amount_cents - paid.rows[0].amount;
      if (outstanding <= 0) {
        await c.query("ROLLBACK");
        return res.status(409).json({ error: "This rent due is already paid" });
      }
      const pending = await c.query(
        "SELECT id FROM payments WHERE rent_due_id=$1 AND status='PENDING' AND gateway_order_id IS NOT NULL LIMIT 1",
        [du.id]
      );
      if (pending.rowCount) {
        await c.query("ROLLBACK");
        return res
          .status(409)
          .json({ error: "A payment order is already open for this rent due" });
      }
      const created = await c.query(
        "INSERT INTO payments(rent_due_id,resident_id,amount_cents,gateway,idempotency_key) VALUES($1,$2,$3,'RAZORPAY',$4) RETURNING id",
        [du.id, req.auth.userId, outstanding, parsed.data.idempotencyKey]
      );
      const membershipRow = await c.query(
        "SELECT p.name FROM properties p WHERE p.id=$1",
        [du.property_id]
      );
      let response;
      try {
        response = await fetch("https://api.razorpay.com/v1/orders", {
          method: "POST",
          headers: {
            Authorization: `Basic ${Buffer.from(
              `${keyId}:${keySecret}`
            ).toString("base64")}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            amount: outstanding,
            currency: "INR",
            receipt: created.rows[0].id,
            notes: {
              paymentId: created.rows[0].id,
              property: membershipRow.rows[0].name,
            },
          }),
          signal: AbortSignal.timeout(15000),
        });
      } catch {
        await c.query("ROLLBACK");
        return res
          .status(502)
          .json({ error: "Payment provider could not be reached" });
      }
      if (!response.ok) {
        await c.query("ROLLBACK");
        console.error("Razorpay order creation failed", response.status);
        return res
          .status(502)
          .json({ error: "Payment provider could not create an order" });
      }
      let order;
      try {
        order = await response.json();
      } catch {
        await c.query("ROLLBACK");
        return res
          .status(502)
          .json({ error: "Payment provider returned an invalid response" });
      }
      if (
        typeof order.id !== "string" ||
        order.amount !== outstanding ||
        order.currency !== "INR"
      ) {
        await c.query("ROLLBACK");
        return res
          .status(502)
          .json({ error: "Payment provider returned an invalid order" });
      }
      await c.query("UPDATE payments SET gateway_order_id=$1 WHERE id=$2", [
        order.id,
        created.rows[0].id,
      ]);
      await c.query("COMMIT");
      res
        .status(201)
        .json({
          paymentId: created.rows[0].id,
          orderId: order.id,
          amountCents: outstanding,
          keyId,
        });
    } catch (e) {
      await c.query("ROLLBACK");
      throw e;
    } finally {
      c.release();
    }
  })
);

router.get(
  "/api/v1/payments/:paymentId/receipt",
  authenticate,
  asyncRoute(async (req, res) => {
    const id = propertyIdSchema.safeParse(req.params.paymentId);
    if (!id.success)
      return res.status(400).json({ error: "Invalid payment id" });
    const row = await pool.query(
      `SELECT pay.id,pay.resident_id AS "residentId",d.property_id AS "propertyId",pay.amount_cents AS "amountCents",pay.status,pay.gateway_reference AS "gatewayReference",pay.paid_at AS "paidAt",u.name AS "residentName",p.name AS "propertyName",p.address,to_char(d.month,'YYYY-MM') AS month FROM payments pay JOIN users u ON u.id=pay.resident_id JOIN rent_dues d ON d.id=pay.rent_due_id JOIN properties p ON p.id=d.property_id WHERE pay.id=$1`,
      [id.data]
    );
    if (!row.rowCount)
      return res.status(404).json({ error: "Payment not found" });
    const receipt = row.rows[0];
    if (
      receipt.residentId !== req.auth.userId &&
      !(await membership(req.auth.userId, receipt.propertyId, [
        "OWNER",
        "MANAGER",
      ]))
    )
      return res.status(403).json({ error: "You cannot view this receipt" });
    if (receipt.status !== "SUCCEEDED")
      return res
        .status(409)
        .json({ error: "Receipt is available after payment succeeds" });
    res.json({
      receipt: {
        ...receipt,
        receiptUrl: `/api/v1/payments/${id.data}/receipt`,
      },
    });
  })
);

router.post(
  "/api/v1/webhooks/razorpay",
  asyncRoute(async (req, res) => {
    const secret = config.RAZORPAY_WEBHOOK_SECRET;
    if (!secret)
      return res
        .status(503)
        .json({ error: "Payment webhook is not configured" });
    const signature = req.header("x-razorpay-signature") ?? "";
    const expected = createHmac("sha256", secret)
      .update(req.rawBody ?? Buffer.alloc(0))
      .digest("hex");
    if (
      signature.length !== expected.length ||
      !timingSafeEqual(Buffer.from(signature), Buffer.from(expected))
    )
      return res.status(401).json({ error: "Invalid webhook signature" });
    const eventId = req.header("x-razorpay-event-id");
    if (!eventId)
      return res.status(400).json({ error: "Missing webhook event id" });
    const event = req.body;
    const entity = event?.payload?.payment?.entity;
    if (
      !["payment.captured", "payment.failed"].includes(event?.event) ||
      !entity
    )
      return res.json({ received: true, ignored: true });
    const c = await pool.connect();
    try {
      await c.query("BEGIN");
      const seen = await c.query(
        "INSERT INTO payment_webhook_events(gateway,event_id) VALUES('RAZORPAY',$1) ON CONFLICT DO NOTHING RETURNING event_id",
        [eventId]
      );
      if (!seen.rowCount) {
        await c.query("COMMIT");
        return res.json({ received: true, duplicate: true });
      }
      const found = await c.query(
        "SELECT id,rent_due_id,amount_cents,resident_id FROM payments WHERE gateway_order_id=$1 FOR UPDATE",
        [entity.order_id]
      );
      if (found.rowCount) {
        const p = found.rows[0];
        if (entity.amount !== p.amount_cents || entity.currency !== "INR") {
          await c.query("ROLLBACK");
          return res
            .status(400)
            .json({ error: "Payment amount does not match order" });
        }
        const successful = event.event === "payment.captured";
        const changed = await c.query(
          "UPDATE payments SET status=$1,gateway_reference=$2,receipt_url=$3,paid_at=CASE WHEN $1='SUCCEEDED' THEN now() ELSE NULL END,updated_at=now() WHERE id=$4 AND status='PENDING' RETURNING id",
          [
            successful ? "SUCCEEDED" : "FAILED",
            entity.id,
            successful ? `/api/v1/payments/${p.id}/receipt` : null,
            p.id,
          ]
        );
        if (changed.rowCount) {
          const due = await c.query(
            "SELECT property_id FROM rent_dues WHERE id=$1",
            [p.rent_due_id]
          );
          await c.query(
            "INSERT INTO notifications(user_id,property_id,type,title,body,data) VALUES($1,$2,$3,$4,$5,$6)",
            [
              p.resident_id,
              due.rows[0].property_id,
              successful ? "RENT_PAID" : "RENT_PAYMENT_FAILED",
              successful ? "Rent payment received" : "Rent payment failed",
              successful
                ? "Your rent payment has been received"
                : "Your rent payment failed. You can try again.",
              JSON.stringify({ paymentId: p.id }),
            ]
          );
        }
      }
      await c.query("COMMIT");
      res.json({ received: true });
    } catch (e) {
      await c.query("ROLLBACK");
      throw e;
    } finally {
      c.release();
    }
  })
);

export default router;
