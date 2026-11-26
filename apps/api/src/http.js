import { requireMembership } from "./auth.js";
import { propertyIdSchema } from "./validation.js";

export { propertyIdSchema };

export function asyncRoute(handler) {
  return (req, res, next) =>
    Promise.resolve(handler(req, res, next)).catch(next);
}

export function parsedPropertyId(req, res) {
  const parsed = propertyIdSchema.safeParse(req.params.propertyId);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid property id" });
    return null;
  }
  return parsed.data;
}

export function membership(userId, propertyId, roles) {
  return requireMembership(userId, propertyId, roles);
}
