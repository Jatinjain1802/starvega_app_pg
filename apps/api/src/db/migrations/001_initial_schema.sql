CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TYPE membership_role AS ENUM ('OWNER', 'MANAGER', 'RESIDENT');
CREATE TYPE membership_status AS ENUM ('ACTIVE', 'INACTIVE');
CREATE TYPE rent_due_status AS ENUM ('UNPAID', 'PARTIALLY_PAID', 'PAID');
CREATE TYPE payment_status AS ENUM ('PENDING', 'SUCCEEDED', 'FAILED', 'REFUNDED');

CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  phone text NOT NULL UNIQUE,
  password_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE properties (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  address text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE memberships (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  property_id uuid NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  role membership_role NOT NULL,
  status membership_status NOT NULL DEFAULT 'ACTIVE',
  monthly_rent_cents integer,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, property_id, role),
  CHECK (monthly_rent_cents IS NULL OR monthly_rent_cents > 0),
  CHECK (role = 'RESIDENT' OR monthly_rent_cents IS NULL)
);

CREATE INDEX memberships_property_role_status_idx
  ON memberships (property_id, role, status);
CREATE INDEX memberships_user_status_idx ON memberships (user_id, status);

CREATE TABLE invitations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id uuid NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  phone text NOT NULL,
  role membership_role NOT NULL CHECK (role IN ('MANAGER', 'RESIDENT')),
  monthly_rent_cents integer,
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  accepted_at timestamptz,
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (monthly_rent_cents IS NULL OR monthly_rent_cents > 0),
  CHECK ((role = 'RESIDENT' AND monthly_rent_cents IS NOT NULL)
    OR (role = 'MANAGER' AND monthly_rent_cents IS NULL))
);

CREATE TABLE rent_dues (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id uuid NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  resident_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  month date NOT NULL,
  amount_cents integer NOT NULL CHECK (amount_cents > 0),
  due_date date NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (resident_id, property_id, month),
  CHECK (extract(day FROM month) = 1)
);

CREATE INDEX rent_dues_property_month_idx ON rent_dues (property_id, month);
CREATE INDEX rent_dues_resident_month_idx ON rent_dues (resident_id, month DESC);

CREATE TABLE payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rent_due_id uuid NOT NULL REFERENCES rent_dues(id) ON DELETE RESTRICT,
  resident_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  amount_cents integer NOT NULL CHECK (amount_cents > 0),
  status payment_status NOT NULL DEFAULT 'PENDING',
  gateway text NOT NULL,
  gateway_reference text UNIQUE,
  receipt_url text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX payments_due_status_idx ON payments (rent_due_id, status);
CREATE INDEX payments_resident_created_idx ON payments (resident_id, created_at DESC);
