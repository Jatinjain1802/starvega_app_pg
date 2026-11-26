# Starvega PG Management

Starvega is being built as one role-based React Native CLI app backed by a Node.js API and PostgreSQL. The first implementation slice covers account setup, role/property membership, monthly rent dues, and owner/manager/resident rent views.

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

The API listens on port 4000. `GET /health` checks that the process is responding.

## Start the mobile app

```sh
npm run mobile:start
# In another terminal:
npm run mobile:ios
# or
npm run mobile:android
```

The development API host is configured for the iOS simulator (`localhost`) and Android emulator (`10.0.2.2`) in `apps/mobile/src/config.ts`. For a physical device, point it to the computer's reachable LAN address and keep both devices on the same network.

## First owner setup

Open the app and choose **New owner? Set up a PG**. This creates the owner account, property, and owner membership. Owners can issue seven-day resident or manager invitations in the app; managers can invite residents. Residents need a positive `monthlyRentCents`, while managers do not. Share the invitation from the app. New users create a password when accepting; an existing user must enter their current password.

All API amounts are integer paise (for example, ₹8,500 is `850000`). Rent due generation is idempotent for a property, resident, and month. Owners and assigned managers can generate dues and see that property's resident balances; residents can see only their own dues.

## Current integration boundary

The payment gateway and notification channels have not been selected. Payment records are modeled, but the app does not claim to take payments or issue payment receipts yet. Gateway intents, verified payment webhooks, receipts, and push notifications must be implemented after the provider and delivery-channel decisions are confirmed. Do not mark dues paid manually in the database.
