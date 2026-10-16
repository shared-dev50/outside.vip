# Outside.vip — Live Experiences, Curated

A secure, high-velocity event discovery and ticketing platform built with modern TypeScript, Express, Prisma, PostgreSQL, React, Vite, and Tailwind CSS.

---

## ⚡ Tech Stack

- **Backend**: Node.js 20+, Express, TypeScript, Zod, Prisma ORM, PostgreSQL
- **Frontend**: React 18, Vite, TypeScript, React Router 6, TanStack Query, Tailwind CSS, Lucide Icons
- **Database**: PostgreSQL (Prisma migrations + seeds)
- **Security & Payments**: Stripe Checkout (M-Pesa ready adapter), unguessable cryptographic tokens, atomic check-in transactions
- **Testing**: Vitest, Supertest

---

## 🛠️ Project Structure

```
outside.vip/
├── package.json              # Monorepo workspaces config (server, client)
├── .env.example              # Environment variables template
├── server/
│   ├── prisma/
│   │   ├── schema.prisma     # Normalized PostgreSQL schema
│   │   ├── migrations/       # Versioned Prisma migration history
│   │   └── seed.ts           # Realistic seed data (events, tiers, users)
│   ├── src/
│   │   ├── config/           # Validated env via Zod
│   │   ├── db/               # Prisma client singleton
│   │   ├── middleware/       # Auth (JWT/roles), error handler
│   │   ├── modules/
│   │   │   ├── auth/         # Register, Login, Me
│   │   │   ├── events/       # Discovery, search, filters, slug lookup
│   │   │   └── health/       # Health check with live DB probe
│   │   ├── app.ts            # Express application setup
│   │   ├── index.ts          # Server bootstrap & graceful shutdown
│   │   └── tests/            # Vitest integration test suite
│   └── tsconfig.json
├── client/
│   ├── src/
│   │   ├── components/layout/# Navbar with demo login, Footer
│   │   ├── context/          # AuthContext with token persistence
│   │   ├── lib/              # Typed API client
│   │   ├── pages/
│   │   │   ├── HomePage.tsx               # Discovery, hero spotlight, filters
│   │   │   ├── EventDetailPage.tsx        # Tier selector, interactive subtotal
│   │   │   ├── OrganizerDashboardPage.tsx # Sales metrics, managed events
│   │   │   ├── CreateEventPage.tsx        # 6-section dedicated event editor
│   │   │   ├── ScannerPage.tsx            # Browser QR check-in & token validator
│   │   │   └── OrderConfirmationPage.tsx  # Attendee digital pass with QR code
│   │   ├── types/            # Shared TypeScript contracts
│   │   ├── App.tsx           # React Router route tree
│   │   └── main.tsx          # React mount & QueryClientProvider
│   ├── tailwind.config.js    # Outside.vip dark editorial theme
│   └── vite.config.ts        # Vite config with /api proxy
```

---

## 🚀 Quickstart

### 1. Prerequisites
- Node.js v20+
- PostgreSQL running locally or remotely

### 2. Environment Setup
```bash
# Copy environment files
cp .env.example .env
cp server/.env.example server/.env
cp client/.env.example client/.env
```

Ensure `DATABASE_URL` in `.env` and `server/.env` points to your PostgreSQL instance:
```bash
DATABASE_URL="postgresql://username:password@localhost:5432/outside_vip?schema=public"
```

### 3. Install Dependencies
```bash
npm install
```

### 4. Database Setup & Seed
```bash
# Push schema & generate Prisma client
npm run db:migrate

# Seed with rich sample events, ticket tiers, organizers, and sample orders
npm run db:seed
```

### 5. Running the Application
```bash
# Start both backend (port 4000) and frontend (port 5173) concurrently:
npm run dev
```
- Public Platform: `http://localhost:5173`
- Organizer Portal: `http://localhost:5173/organizer`
- Dedicated Event Editor: `http://localhost:5173/organizer/events/new`
- Browser Door Scanner: `http://localhost:5173/scanner`
- Health Endpoint: `http://localhost:4000/api/health`

---

## 🧪 Testing & Verification

```bash
# Run all test suites across workspaces:
npm run test

# Run type check:
npm run typecheck

# Build for production:
npm run build
```

---

## 🔑 Demo Accounts (from Seed)

- **Organizer Account**: `sol@outside.vip` (Password: `Outside2026!`)
- **Attendee Account**: `alex@outside.vip` (Password: `Outside2026!`)
- **Admin Account**: `admin@outside.vip` (Password: `Outside2026!`)
