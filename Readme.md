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
PLATFORM_SECRET_KEY=SXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX

# Smart Contracts
ESCROW_CONTRACT_ID=CXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX
TOKEN_CONTRACT_ID=CXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX

# IPFS
IPFS_API_URL=https://api.pinata.cloud
IPFS_JWT=your_pinata_jwt_token

# JWT
JWT_SECRET=your-super-secret-jwt-key
JWT_EXPIRES_IN=15m
AUTH_CHALLENGE_TTL_MS=300000

# Email
SENDGRID_API_KEY=SG.xxxxxxxxxxxxx
FROM_EMAIL=noreply@stellarsettle.com
```

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
```

### Investments
```
GET    /api/investments              # List user investments
POST   /api/investments              # Invest in invoice
GET    /api/investments/:id          # Get investment details
```

### Marketplace
```
GET    /api/marketplace              # Browse available invoices
GET    /api/marketplace/stats        # Market statistics
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

See [docs/DATABASE.md](docs/DATABASE.md) for complete schema.

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

- Health check: `GET /health`
- Metrics: `GET /metrics` (Prometheus format)
- Logs: Winston with daily rotation

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
