<div align="center">
  <img src="logo.png" alt="StellarSettle Logo" width="200"/>
  
  # StellarSettle API
  
  **Backend API powering the StellarSettle invoice financing platform**
  
  [![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
  [![Node.js](https://img.shields.io/badge/node-22.x%20LTS-brightgreen)](https://nodejs.org)
  [![TypeScript](https://img.shields.io/badge/TypeScript-5.7%2B-blue)](https://www.typescriptlang.org/)
</div>

## 📋 Overview

RESTful API backend for StellarSettle that handles:

- User authentication & authorization
- Invoice management & verification
- Stellar blockchain integration
- Payment processing & settlement
- IPFS document storage
- Real-time notifications

## 🏗️ Architecture
```
src/
├── config/           # Configuration & environment
├── controllers/      # Route handlers
├── models/          # Database models (TypeORM)
├── services/        # Business logic
│   ├── stellar/     # Stellar SDK integration
│   ├── ipfs/        # IPFS storage
│   └── ocr/         # Invoice OCR processing
├── middleware/      # Auth, validation, error handling
├── routes/          # API routes
├── utils/           # Helper functions
└── types/           # TypeScript types
```

## 🚀 Quick Start

### Prerequisites

- Node.js 22.x LTS
- TypeScript 5.7+
- PostgreSQL 14+
- Stellar account (testnet/mainnet)
- IPFS account (Pinata recommended)

### Version requirements (align with .cursorrules)

- **Node.js:** 22.x LTS
- **TypeScript:** 5.7+
- **Express:** 5.x (not 4.x)
- **Stellar SDK:** use latest — check with `npm view stellar-sdk version`

Before adding or upgrading any package:

1. Check latest version: `npm view PACKAGE version`
2. Install: `npm install PACKAGE@latest`
3. Verify: `npm list PACKAGE`

### Installation
```bash
# Install dependencies
npm install

# Copy environment variables
cp .env.example .env

# Edit .env with your credentials
nano .env

# Run database migrations
npm run db:migrate

# Start development server
npm run dev
```

### Environment Variables
```env
# Server
PORT=3000
NODE_ENV=development

# Database
DATABASE_URL=postgresql://user:password@localhost:5432/stellarsettle

# Stellar
STELLAR_NETWORK=testnet
STELLAR_HORIZON_URL=https://horizon-testnet.stellar.org
STELLAR_USDC_ASSET_CODE=USDC
STELLAR_USDC_ASSET_ISSUER=GXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX
STELLAR_ESCROW_PUBLIC_KEY=GXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX
STELLAR_VERIFY_ALLOWED_AMOUNT_DELTA=0.0001
STELLAR_VERIFY_RETRY_ATTEMPTS=3
STELLAR_VERIFY_RETRY_BASE_DELAY_MS=250
PLATFORM_SECRET_KEY=SXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX

# Smart Contracts
ESCROW_CONTRACT_ID=CXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX
TOKEN_CONTRACT_ID=CXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX

# IPFS
IPFS_API_URL=https://api.pinata.cloud
IPFS_JWT=your_pinata_jwt_token
IPFS_MAX_FILE_SIZE_MB=10
IPFS_ALLOWED_MIME_TYPES=application/pdf,image/jpeg,image/png,image/gif,image/webp
IPFS_UPLOAD_RATE_LIMIT_WINDOW_MS=900000
IPFS_UPLOAD_RATE_LIMIT_MAX_UPLOADS=10

# JWT
JWT_SECRET=your-super-secret-jwt-key
JWT_EXPIRES_IN=15m
AUTH_CHALLENGE_TTL_MS=300000

# Observability
METRICS_ENABLED=true

# Background reconciliation
STELLAR_RECONCILIATION_ENABLED=false
STELLAR_RECONCILIATION_INTERVAL_MS=30000
STELLAR_RECONCILIATION_BATCH_SIZE=25
STELLAR_RECONCILIATION_GRACE_PERIOD_MS=60000
STELLAR_RECONCILIATION_MAX_RUNTIME_MS=10000

# Email
SENDGRID_API_KEY=SG.xxxxxxxxxxxxx
FROM_EMAIL=noreply@stellarsettle.com
```

**Obtaining Pinata Credentials:**
1. Sign up at [Pinata](https://pinata.cloud/)
2. Create an API key with pinning permissions
3. Use the API key as your `IPFS_JWT` value

## 📡 API Endpoints

### Authentication
```
POST   /api/v1/auth/challenge       # Create a short-lived wallet challenge
POST   /api/v1/auth/verify          # Verify a signed challenge and issue a JWT
GET    /api/v1/auth/me              # Get current user from JWT
```

Authentication currently uses short-lived access JWTs only. Clients renew access by requesting and signing a new Stellar challenge instead of using refresh tokens.

### Invoices
```
GET    /api/invoices                # List all invoices
GET    /api/invoices/:id            # Get invoice details
POST   /api/invoices                # Create new invoice
PUT    /api/invoices/:id            # Update invoice
DELETE /api/invoices/:id            # Delete invoice
POST   /api/invoices/:id/publish    # Publish to marketplace
POST   /api/invoices/:id/payment    # Record payment
POST   /api/v1/invoices/:id/document # Upload supporting document (PDF/image)
```

### Marketplace
```
GET    /api/v1/marketplace/invoices  # Browse published invoices (public, no auth required)
```

**Note**: The marketplace endpoint provides public read access to published invoices for investor discovery. See [docs/MARKETPLACE_API.md](docs/MARKETPLACE_API.md) for detailed documentation.

### Investments
```
GET    /api/investments              # List user investments
POST   /api/investments              # Invest in invoice
GET    /api/investments/:id          # Get investment details
```

### Dashboard
```
GET    /api/dashboard/seller         # Seller analytics
GET    /api/dashboard/investor       # Investor analytics
```

Full API documentation: [docs/API.md](docs/API.md)

## 🗃️ Database Schema
```sql
-- Core tables
users
invoices
investments
transactions
kyc_verifications
notifications
```

See [docs/DB_WORKFLOW.md](docs/DB_WORKFLOW.md) for the local migration workflow,
entity-to-schema alignment notes, and transaction foreign-key ownership.

## 🧪 Testing
```bash
# Run all tests
npm test

# Run tests in watch mode
npm run test:watch

# Generate coverage report
npm run test:coverage

# Run E2E tests
npm run test:e2e
```

## 🔒 Security

- JWT authentication
- Rate limiting (100 req/min per IP)
- Input validation with Joi
- SQL injection prevention (parameterized queries)
- XSS protection
- CORS configured
- Helmet.js security headers

## 📊 Monitoring

- Health check: `GET /health` (includes process uptime and request ID)
- Metrics: `GET /metrics` (Prometheus format)
- Metrics labels are intentionally low-cardinality: `method`, normalized route template, and `status_class`
- Logs: Winston JSON logs with `X-Request-Id` correlation IDs

## Background Reconciliation

- Enable `STELLAR_RECONCILIATION_ENABLED=true` to start the in-process worker.
- The worker scans a bounded batch of stale pending investments / transactions and reuses the existing Stellar payment verification path for idempotent reconciliation.
- Current deployment assumption: run the worker on a single replica unless you add your own leader-election or advisory-lock strategy.

## 🚢 Deployment
```bash
# Build for production
npm run build

# Start production server
npm start

# Run with PM2
pm2 start ecosystem.config.js
```

## 🤝 Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for **commit conventions**, **secrets policy**, and **PR / CI requirements** (Conventional Commits, Husky, CI checks).

## 📄 License

MIT License - see [LICENSE](LICENSE) file for details

---

Built with ❤️ on Stellar
