import { randomBytes, createHash } from 'node:crypto';
import express, { NextFunction, Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import cors from 'cors';
import helmet from 'helmet';
import { z } from 'zod';
import { authenticate, AuthenticatedRequest, issueToken, requireMembership } from './auth';
import { pool } from './db/pool';
import { dueDateSchema, monthSchema, monthStart } from './rent';

const app = express();
const phoneSchema = z.string().regex(/^\+?[1-9]\d{7,14}$/, 'Use an international phone number');
const propertyIdSchema = z.string().uuid();
const passwordSchema = z.string().min(10).max(72);
const ownerRegistrationSchema = z.object({
  name: z.string().trim().min(1).max(120),
  phone: phoneSchema,
  password: passwordSchema,
  propertyName: z.string().trim().min(1).max(120),
  address: z.string().trim().min(1).max(500),
});
const invitationSchema = z.object({
  phone: phoneSchema,
  role: z.enum(['MANAGER', 'RESIDENT']),
  monthlyRentCents: z.number().int().positive().max(2_147_483_647).optional(),
}).superRefine((input, ctx) => {
  if (input.role === 'RESIDENT' && input.monthlyRentCents === undefined) {
    ctx.addIssue({ code: 'custom', path: ['monthlyRentCents'], message: 'Rent is required for residents' });
  }
  if (input.role === 'MANAGER' && input.monthlyRentCents !== undefined) {
    ctx.addIssue({ code: 'custom', path: ['monthlyRentCents'], message: 'Managers do not have a rent amount' });
  }
});
const acceptInvitationSchema = z.object({
  token: z.string().min(32).max(128),
  name: z.string().trim().min(1).max(120),
  password: passwordSchema,
});

app.disable('x-powered-by');
app.use(helmet());
app.use(cors());
app.use(express.json({ limit: '1mb' }));

app.get('/health', (_req, res) => res.json({ status: 'ok' }));

app.post('/api/v1/auth/register-owner', async (req, res, next) => {
  const parsed = ownerRegistrationSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid registration details', details: parsed.error.flatten() });
    return;
  }

  const client = await pool.connect();
  try {
    const { name, phone, password, propertyName, address } = parsed.data;
    const passwordHash = await bcrypt.hash(password, 12);
    await client.query('BEGIN');
    const user = await client.query(
      'INSERT INTO users (name, phone, password_hash) VALUES ($1, $2, $3) RETURNING id, name, phone',
      [name, phone, passwordHash],
    );
    const property = await client.query(
      'INSERT INTO properties (name, address) VALUES ($1, $2) RETURNING id, name, address',
      [propertyName, address],
    );
    await client.query(
      `INSERT INTO memberships (user_id, property_id, role)
       VALUES ($1, $2, 'OWNER')`,
      [user.rows[0].id, property.rows[0].id],
    );
    await client.query('COMMIT');
    res.status(201).json({
      token: issueToken(user.rows[0].id),
      user: user.rows[0],
      property: property.rows[0],
    });
  } catch (error) {
    await client.query('ROLLBACK');
    next(error);
  } finally {
    client.release();
  }
});

app.post('/api/v1/auth/login', async (req, res, next) => {
  const parsed = z.object({ phone: phoneSchema, password: z.string().min(1).max(72) }).safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid login details' });
    return;
  }

  try {
    const result = await pool.query(
      'SELECT id, name, phone, password_hash FROM users WHERE phone = $1',
      [parsed.data.phone],
    );
    const user = result.rows[0];
    if (!user || !(await bcrypt.compare(parsed.data.password, user.password_hash))) {
      res.status(401).json({ error: 'Phone number or password is incorrect' });
      return;
    }
    res.json({
      token: issueToken(user.id),
      user: { id: user.id, name: user.name, phone: user.phone },
    });
  } catch (error) {
    next(error);
  }
});

app.post('/api/v1/auth/accept-invitation', async (req, res, next) => {
  const parsed = acceptInvitationSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid invitation details', details: parsed.error.flatten() });
    return;
  }

  const client = await pool.connect();
  try {
    const tokenHash = createHash('sha256').update(parsed.data.token).digest('hex');
    await client.query('BEGIN');
    const invitationResult = await client.query(
      `SELECT id, property_id, phone, role, monthly_rent_cents
       FROM invitations
       WHERE token_hash = $1 AND accepted_at IS NULL AND expires_at > now()
       FOR UPDATE`,
      [tokenHash],
    );
    const invitation = invitationResult.rows[0];
    if (!invitation) {
      await client.query('ROLLBACK');
      res.status(400).json({ error: 'Invitation is invalid or expired' });
      return;
    }

    const existing = await client.query(
      'SELECT id, password_hash FROM users WHERE phone = $1 FOR UPDATE',
      [invitation.phone],
    );
    let userId: string;
    if (existing.rowCount) {
      const passwordMatches = await bcrypt.compare(parsed.data.password, existing.rows[0].password_hash);
      if (!passwordMatches) {
        await client.query('ROLLBACK');
        res.status(401).json({ error: 'Use the existing account password to accept this invitation' });
        return;
      }
      userId = existing.rows[0].id;
    } else {
      const hash = await bcrypt.hash(parsed.data.password, 12);
      const user = await client.query(
        'INSERT INTO users (name, phone, password_hash) VALUES ($1, $2, $3) RETURNING id',
        [parsed.data.name, invitation.phone, hash],
      );
      userId = user.rows[0].id;
    }

    await client.query(
      `INSERT INTO memberships (user_id, property_id, role, monthly_rent_cents)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (user_id, property_id, role) DO UPDATE
         SET status = 'ACTIVE', monthly_rent_cents = EXCLUDED.monthly_rent_cents`,
      [userId, invitation.property_id, invitation.role, invitation.monthly_rent_cents],
    );
    await client.query('UPDATE invitations SET accepted_at = now() WHERE id = $1', [invitation.id]);
    await client.query('COMMIT');
    res.status(201).json({ token: issueToken(userId) });
  } catch (error) {
    await client.query('ROLLBACK');
    next(error);
  } finally {
    client.release();
  }
});

app.get('/api/v1/auth/me', authenticate, async (req: AuthenticatedRequest, res, next) => {
  try {
    const result = await pool.query(
      `SELECT u.id, u.name, u.phone,
              COALESCE(json_agg(json_build_object(
                'propertyId', p.id, 'propertyName', p.name, 'role', m.role,
                'monthlyRentCents', m.monthly_rent_cents
              )) FILTER (WHERE m.id IS NOT NULL), '[]') AS memberships
       FROM users u
       LEFT JOIN memberships m ON m.user_id = u.id AND m.status = 'ACTIVE'
       LEFT JOIN properties p ON p.id = m.property_id
       WHERE u.id = $1
       GROUP BY u.id`,
      [req.auth!.userId],
    );
    if (!result.rowCount) {
      res.status(404).json({ error: 'User account not found' });
      return;
    }
    res.json(result.rows[0]);
  } catch (error) {
    next(error);
  }
});

app.post('/api/v1/properties/:propertyId/invitations', authenticate, async (req: AuthenticatedRequest, res, next) => {
  const propertyId = propertyIdSchema.safeParse(req.params.propertyId);
  if (!propertyId.success) {
    res.status(400).json({ error: 'Invalid property id' });
    return;
  }
  const parsed = invitationSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid invitation details', details: parsed.error.flatten() });
    return;
  }

  try {
    const ownerOrManager = await requireMembership(req.auth!.userId, propertyId.data, ['OWNER', 'MANAGER']);
    if (!ownerOrManager) {
      res.status(403).json({ error: 'You do not manage this property' });
      return;
    }
    const owner = await requireMembership(req.auth!.userId, propertyId.data, ['OWNER']);
    const manager = await requireMembership(req.auth!.userId, propertyId.data, ['MANAGER']);
    if (!owner && manager && parsed.data.role !== 'RESIDENT') {
      res.status(403).json({ error: 'Managers can invite residents only' });
      return;
    }

    const token = randomBytes(32).toString('hex');
    const tokenHash = createHash('sha256').update(token).digest('hex');
    await pool.query(
      `INSERT INTO invitations (property_id, phone, role, monthly_rent_cents, token_hash, expires_at, created_by)
       VALUES ($1, $2, $3, $4, $5, now() + interval '7 days', $6)`,
      [
        propertyId.data,
        parsed.data.phone,
        parsed.data.role,
        parsed.data.monthlyRentCents ?? null,
        tokenHash,
        req.auth!.userId,
      ],
    );
    res.status(201).json({ token, expiresInDays: 7 });
  } catch (error) {
    next(error);
  }
});

app.get('/api/v1/rent-dues/me', authenticate, async (req: AuthenticatedRequest, res, next) => {
  try {
    const result = await pool.query(
      `SELECT d.id, d.property_id AS "propertyId", p.name AS "propertyName",
              to_char(d.month, 'YYYY-MM') AS month, d.amount_cents AS "amountCents",
              d.due_date AS "dueDate",
              COALESCE(SUM(pay.amount_cents) FILTER (WHERE pay.status = 'SUCCEEDED'), 0)::int AS "paidCents"
       FROM rent_dues d
       JOIN properties p ON p.id = d.property_id
       LEFT JOIN payments pay ON pay.rent_due_id = d.id
       WHERE d.resident_id = $1
       GROUP BY d.id, p.name
       ORDER BY d.month DESC`,
      [req.auth!.userId],
    );
    res.json({ rentDues: result.rows });
  } catch (error) {
    next(error);
  }
});

app.get('/api/v1/properties/:propertyId/rent-dues', authenticate, async (req: AuthenticatedRequest, res, next) => {
  const propertyId = propertyIdSchema.safeParse(req.params.propertyId);
  if (!propertyId.success) {
    res.status(400).json({ error: 'Invalid property id' });
    return;
  }
  const monthResult = monthSchema.safeParse(req.query.month);
  if (!monthResult.success) {
    res.status(400).json({ error: 'Month must use YYYY-MM format' });
    return;
  }

  try {
    const allowed = await requireMembership(req.auth!.userId, propertyId.data, ['OWNER', 'MANAGER']);
    if (!allowed) {
      res.status(403).json({ error: 'You do not manage this property' });
      return;
    }
    const result = await pool.query(
      `SELECT d.id, d.resident_id AS "residentId", u.name AS "residentName",
              u.phone AS "residentPhone", to_char(d.month, 'YYYY-MM') AS month,
              d.amount_cents AS "amountCents", d.due_date AS "dueDate",
              COALESCE(SUM(pay.amount_cents) FILTER (WHERE pay.status = 'SUCCEEDED'), 0)::int AS "paidCents"
       FROM rent_dues d
       JOIN users u ON u.id = d.resident_id
       LEFT JOIN payments pay ON pay.rent_due_id = d.id
       WHERE d.property_id = $1 AND d.month = $2
       GROUP BY d.id, u.name, u.phone
       ORDER BY u.name`,
      [propertyId.data, monthStart(monthResult.data)],
    );
    res.json({ rentDues: result.rows });
  } catch (error) {
    next(error);
  }
});

app.post('/api/v1/properties/:propertyId/rent-dues/generate', authenticate, async (req: AuthenticatedRequest, res, next) => {
  const propertyId = propertyIdSchema.safeParse(req.params.propertyId);
  if (!propertyId.success) {
    res.status(400).json({ error: 'Invalid property id' });
    return;
  }
  const parsed = z.object({ month: monthSchema, dueDate: dueDateSchema }).safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Provide a YYYY-MM month and valid dueDate', details: parsed.error.flatten() });
    return;
  }

  try {
    const allowed = await requireMembership(req.auth!.userId, propertyId.data, ['OWNER', 'MANAGER']);
    if (!allowed) {
      res.status(403).json({ error: 'You do not manage this property' });
      return;
    }
    const result = await pool.query(
      `INSERT INTO rent_dues (property_id, resident_id, month, amount_cents, due_date)
       SELECT m.property_id, m.user_id, $2::date, m.monthly_rent_cents, $3::date
       FROM memberships m
       WHERE m.property_id = $1 AND m.role = 'RESIDENT' AND m.status = 'ACTIVE'
         AND m.monthly_rent_cents IS NOT NULL
       ON CONFLICT (resident_id, property_id, month) DO NOTHING
       RETURNING id, resident_id AS "residentId", amount_cents AS "amountCents"`,
      [propertyId.data, monthStart(parsed.data.month), parsed.data.dueDate],
    );
    res.status(201).json({ created: result.rowCount ?? 0, rentDues: result.rows });
  } catch (error) {
    next(error);
  }
});

app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
  if (typeof error === 'object' && error !== null && 'code' in error && error.code === '23505') {
    res.status(409).json({ error: 'An account with that phone number already exists' });
    return;
  }
  console.error('Request failed', error);
  res.status(500).json({ error: 'An unexpected server error occurred' });
});

export { app };
