# Database Workflow

This repository uses TypeORM migrations against PostgreSQL. The canonical
schema starts with `src/migrations/1731513600000-InitialSchema.ts` and is
extended by follow-up migrations in timestamp order.

## Local setup

```bash
createdb stellarsettle_dev
export DATABASE_URL=postgresql://localhost:5432/stellarsettle_dev
export JWT_SECRET=dev-secret
export STELLAR_HORIZON_URL=https://horizon-testnet.stellar.org
export STELLAR_USDC_ASSET_CODE=USDC
export STELLAR_USDC_ASSET_ISSUER=GXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX
export STELLAR_ESCROW_PUBLIC_KEY=GXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX
npm install
npm run db:migrate
npm run type-check
npm run dev
```

## Entity alignment notes

- `User.stellarAddress`, `User.userType`, and `User.kycStatus` map to the
  quoted camelCase columns created by the initial migration.
- `Investment.stellarOperationIndex` and `Transaction.investmentId` come from
  `1731700000000-AddInvestmentPaymentVerification.ts`.
- `Transaction.invoiceId` is added by
  `1731800000000-AddTransactionInvoiceAndInvestmentLinks.ts`.

## Transaction foreign-key ownership

| TransactionType | `invoice_id` | `investment_id` | Notes |
| --- | --- | --- | --- |
| `investment` | Set to the funded invoice | Set to the investment row | Funding an invoice through an investment |
| `payment` | Set to the repaid invoice | Nullable | Seller repayment or invoice settlement |
| `withdrawal` | Nullable | Nullable | User-level cash movement, not invoice-scoped |
| `refund` | Set when refund is invoice-specific | Set when refund reverses an investment | Populate whichever entity the refund reverses |

For existing environments, historical backfill can be done later by joining
transactions to investments through the stored `investment_id` and the linked
invoice on `investments.invoice_id`.
