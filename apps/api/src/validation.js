import { z } from "zod";

export const phoneSchema = z
  .string()
  .regex(/^\+?[1-9]\d{7,14}$/, "Use an international phone number");
export const propertyIdSchema = z.string().uuid();
export const passwordSchema = z.string().min(10).max(72);

export const ownerRegistrationSchema = z.object({
  name: z.string().trim().min(1).max(120),
  phone: phoneSchema,
  password: passwordSchema,
  propertyName: z.string().trim().min(1).max(120),
  address: z.string().trim().min(1).max(500),
});

export const acceptInvitationSchema = z.object({
  token: z.string().min(32).max(128),
  name: z.string().trim().min(1).max(120),
  password: passwordSchema,
});

export const invitationSchema = z
  .object({
    phone: phoneSchema,
    role: z.enum(["MANAGER", "RESIDENT"]),
    monthlyRentCents: z.number().int().positive().max(2_147_483_647).optional(),
    bedId: z.string().uuid().optional(),
  })
  .superRefine((input, ctx) => {
    if (input.role === "RESIDENT" && input.monthlyRentCents === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["monthlyRentCents"],
        message: "Rent is required for residents",
      });
    }
    if (input.role === "MANAGER" && input.monthlyRentCents !== undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["monthlyRentCents"],
        message: "Managers do not have a rent amount",
      });
    }
    if (input.role === "MANAGER" && input.bedId !== undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["bedId"],
        message: "Managers cannot be assigned a resident bed",
      });
    }
  });
