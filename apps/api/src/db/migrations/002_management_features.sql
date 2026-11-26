CREATE TYPE complaint_visibility AS ENUM ('COMMON', 'PRIVATE');
CREATE TYPE complaint_status AS ENUM ('OPEN', 'SOLVED');

CREATE TABLE rooms (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id uuid NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (property_id, name), UNIQUE (id, property_id)
);
CREATE TABLE beds (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id uuid NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  room_id uuid NOT NULL,
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (room_id, property_id) REFERENCES rooms(id, property_id) ON DELETE CASCADE,
  UNIQUE (room_id, name), UNIQUE (id, property_id)
);
ALTER TABLE memberships ADD COLUMN bed_id uuid;
ALTER TABLE memberships ADD CONSTRAINT memberships_bed_property_fk
  FOREIGN KEY (bed_id, property_id) REFERENCES beds(id, property_id);
ALTER TABLE invitations ADD COLUMN bed_id uuid;
ALTER TABLE invitations ADD CONSTRAINT invitations_bed_property_fk
  FOREIGN KEY (bed_id, property_id) REFERENCES beds(id, property_id);
CREATE UNIQUE INDEX memberships_active_bed_idx ON memberships (bed_id) WHERE status = 'ACTIVE' AND bed_id IS NOT NULL;

CREATE TABLE complaints (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id uuid NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  raised_by uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  title text NOT NULL,
  description text NOT NULL,
  visibility complaint_visibility NOT NULL,
  is_safety boolean NOT NULL DEFAULT false,
  status complaint_status NOT NULL DEFAULT 'OPEN',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  solved_at timestamptz,
  solved_by uuid REFERENCES users(id)
);
CREATE INDEX complaints_property_created_idx ON complaints (property_id, created_at DESC);
CREATE TABLE complaint_likes (
  complaint_id uuid NOT NULL REFERENCES complaints(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (complaint_id, user_id)
);
CREATE TABLE complaint_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  complaint_id uuid NOT NULL REFERENCES complaints(id) ON DELETE CASCADE,
  actor_id uuid NOT NULL REFERENCES users(id),
  action text NOT NULL CHECK (action IN ('CREATED', 'SOLVED', 'REOPENED')),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE announcements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id uuid NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  posted_by uuid NOT NULL REFERENCES users(id),
  title text NOT NULL,
  body text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX announcements_property_created_idx ON announcements (property_id, created_at DESC);
CREATE TABLE expenses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id uuid NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  added_by uuid NOT NULL REFERENCES users(id),
  title text NOT NULL,
  category text NOT NULL,
  amount_cents integer NOT NULL CHECK (amount_cents > 0),
  items jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(items) = 'array'),
  receipt_url text,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX expenses_property_created_idx ON expenses (property_id, created_at DESC);
CREATE TABLE expense_receipts (
  expense_id uuid PRIMARY KEY REFERENCES expenses(id) ON DELETE CASCADE,
  uploaded_by uuid NOT NULL REFERENCES users(id),
  file_name text NOT NULL,
  mime_type text NOT NULL CHECK (mime_type IN ('application/pdf','image/jpeg','image/png','image/webp')),
  content bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  property_id uuid REFERENCES properties(id) ON DELETE CASCADE,
  type text NOT NULL,
  title text NOT NULL,
  body text NOT NULL,
  data jsonb NOT NULL DEFAULT '{}'::jsonb,
  read_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX notifications_user_created_idx ON notifications (user_id, created_at DESC);
ALTER TABLE payments ADD COLUMN idempotency_key text UNIQUE;
ALTER TABLE payments ADD COLUMN gateway_order_id text UNIQUE;
ALTER TABLE payments ADD COLUMN paid_at timestamptz;
CREATE TABLE payment_webhook_events (
  gateway text NOT NULL,
  event_id text NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (gateway, event_id)
);
