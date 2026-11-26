import "dotenv/config";
import { z } from "zod";

const configSchema = z.object({
  PORT: z.coerce.number().int().positive().default(4000),
  RENT_DUE_DAY: z.coerce.number().int().min(1).max(31).default(5),
  DATABASE_URL: z.string().min(1),
  JWT_SECRET: z.string().min(32),
  JWT_EXPIRES_IN: z.string().default("12h"),
  RAZORPAY_KEY_ID: z.string().optional(),
  RAZORPAY_KEY_SECRET: z.string().optional(),
  RAZORPAY_WEBHOOK_SECRET: z.string().optional(),
});

export const config = configSchema.parse(process.env);
