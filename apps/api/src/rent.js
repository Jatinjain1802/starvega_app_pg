import { z } from "zod";

export const monthSchema = z
  .string()
  .regex(/^\d{4}-(0[1-9]|1[0-2])$/, "Month must use YYYY-MM format");
export const dueDateSchema = z.string().date();

export function monthStart(month) {
  return `${month}-01`;
}
