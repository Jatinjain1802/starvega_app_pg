# Starvega PG Management

Starvega is one role-based React Native CLI app using JavaScript/JSX, backed by a JavaScript Node.js API and PostgreSQL. The API supports account setup, property operations, rent, complaints, announcements, expenses, and in-app notifications.

## Requirements

- Node.js 22.11 or newer
- PostgreSQL 15 or newer
- React Native CLI prerequisites for the target platform (Xcode/CocoaPods for iOS; Android Studio/JDK for Android)

## Start the API

```sh
npm install
createdb starvega
cp apps/api/.env.example apps/api/.env
# Set JWT_SECRET to a private random value of at least 32 characters.
npm run db:migrate -w @starvega/api
npm run api:dev
```

The API listens on port 4000. `GET /health` checks that the process is responding and `GET /ready` also checks its PostgreSQL connection.
Local credentials and configuration live in the ignored `apps/api/.env`. The current local setup connects to the `starvega` PostgreSQL database using the current macOS account and uses a generated JWT secret. For a database that requires a password, put its connection string in that file; never commit `.env`.

### Backend endpoints in this first slice

- `POST /api/v1/auth/register-owner` — create an owner and their first PG.
- `POST /api/v1/auth/login` and `GET /api/v1/auth/me` — sign in and inspect assigned roles/PGs.
- `POST /api/v1/properties/:propertyId/invitations` — owners invite managers/residents; managers invite residents.
- `POST /api/v1/auth/accept-invitation` — accept an invite and create the account or attach an existing account.
- `POST /api/v1/properties/:propertyId/rent-dues/generate` — create that month's dues from active resident rent assignments.
- `GET /api/v1/properties/:propertyId/rent-dues?month=YYYY-MM` — owner/manager property balances.
- `GET /api/v1/rent-dues/me` — resident's own rent history only.
- `GET /api/v1/properties` and `GET /api/v1/properties/:propertyId/dashboard` — assigned properties and owner/manager totals.
- `POST /api/v1/properties` — an existing owner creates another PG under their account.
- `PATCH /api/v1/properties/:propertyId` and `GET /api/v1/properties/:propertyId/members` — edit PG details and review membership assignments.
- `POST /api/v1/properties/:propertyId/rooms`, `GET /api/v1/properties/:propertyId/rooms`, and `PUT /api/v1/properties/:propertyId/residents/:residentId/bed` — room and bed setup.
- `PATCH /api/v1/properties/:propertyId/members/:membershipId`, `PATCH /api/v1/properties/:propertyId/residents/:residentId/rent`, and invitation `bedId` — owner manages membership, rent, and bed assignments.
- `/api/v1/properties/:propertyId/complaints` plus `/api/v1/complaints/:id/*` — visibility-scoped complaints, likes, solve/reopen, and history.
- `/api/v1/properties/:propertyId/announcements` — publish and read property announcements.
- `/api/v1/properties/:propertyId/expenses` — itemized expenses and receipt links for owners and managers.
- `PUT /api/v1/expenses/:expenseId/receipt` and `GET /api/v1/expenses/:expenseId/receipt` — upload (base64, PDF/JPEG/PNG/WebP, maximum 5 MB) and retrieve a protected expense receipt.
- `GET /api/v1/properties/:propertyId/manager-contact` — current manager contact for property members.
- `GET /api/v1/notifications` and `POST /api/v1/notifications/:id/read` — in-app notification feed.
- `POST /api/v1/rent-dues/:id/payment-orders`, `GET /api/v1/payments/me`, and `GET /api/v1/payments/:id/receipt` — online payment order, history, and receipt.

### Backend structure

```text
apps/api/src/
  app.js                 Express setup, middleware, health/readiness, errors
  server.js              HTTP lifecycle and rent scheduler startup
  routes/                Domain route modules and route registration
  auth.js                JWT authentication and membership authorization
  validation.js          Shared request schemas
  http.js                Shared route and property access helpers
  rent.js                Rent period validation
  rent-scheduler.js      Idempotent monthly due generation
  db/
    pool.js              PostgreSQL connection pool
    migrate.js           Ordered SQL migration runner
    migrations/          Versioned PostgreSQL schema
```

## Start the mobile app

```sh
npm run mobile:start
# In another terminal:
npm run mobile:ios
# or
npm run mobile:android
```

The development API host is configured for the iOS simulator (`localhost`) and Android emulator (`10.0.2.2`) in `apps/mobile/src/config.js`. For a physical device, point it to the computer's reachable LAN address and keep both devices on the same network.

## First owner setup

Open the app and choose **New owner? Set up a PG**. This creates the owner account, property, and owner membership. Owners can issue seven-day resident or manager invitations in the app; managers can invite residents. Residents need a positive `monthlyRentCents`, while managers do not. Share the invitation from the app. New users create a password when accepting; an existing user must enter their current password.

All API amounts are integer paise (for example, ₹8,500 is `850000`). Rent due generation is idempotent for a property, resident, and month. Owners and assigned managers can generate dues and see that property's resident balances; residents can see only their own dues.

## Current integration boundary

The API creates current-month dues on startup and checks once per day for newly invited residents. `RENT_DUE_DAY` controls the due day (default `5`; clamped to each month's last date). Manual rent due generation remains available. Online rent uses Razorpay when configured. Set `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, and `RAZORPAY_WEBHOOK_SECRET` in `apps/api/.env`, and configure the provider webhook at `/api/v1/webhooks/razorpay` for `payment.captured` and `payment.failed`. The API checks webhook signatures before changing payment state. Order creation returns `503` until credentials are configured. Notifications are available in-app; push and WhatsApp delivery need a provider configuration. Uploaded expense receipts are stored in PostgreSQL, limited to 5 MB each.
