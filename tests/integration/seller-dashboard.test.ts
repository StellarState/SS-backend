import "reflect-metadata";
import request from "supertest";
import { DataSource, getMetadataArgsStorage } from "typeorm";
import { Keypair } from "stellar-sdk";
import { createApp } from "../../src/app";
import { User } from "../../src/models/User.model";
import { Invoice } from "../../src/models/Invoice.model";
import { Investment } from "../../src/models/Investment.model";
import { InvoiceStatus, InvestmentStatus } from "../../src/types/enums";
import type { AppConfig } from "../../src/config/env";

function patchEntityMetadataForSQLite(): void {
  const columns = getMetadataArgsStorage().columns;
  for (const col of columns) {
    if (col.options.type === "timestamptz") {
      col.options.type = "datetime" as any;
    }
    if (col.options.type === "jsonb") {
      col.options.type = "text" as any;
    }
    if (col.options.type === "enum") {
      col.options.type = "varchar" as any;
    }
  }
}

import { createAuthService } from "../../src/services/auth.service";
import { createInvoiceService } from "../../src/services/invoice.service";
import { AuthChallenge } from "../../src/models/AuthChallenge.model";
import { Transaction } from "../../src/models/Transaction.model";
import { KYCVerification } from "../../src/models/KYCVerification.model";
import { Notification } from "../../src/models/Notification.model";
import { HttpError } from "../../src/utils/http-error";

describe("Integration: Seller Dashboard Aggregates", () => {
  let dataSource: DataSource;
  let app: ReturnType<typeof createApp>;
  let config: AppConfig;
  let authService: ReturnType<typeof createAuthService>;

  beforeAll(async () => {
    process.env.JWT_SECRET = "test-secret";
    patchEntityMetadataForSQLite();
    dataSource = new DataSource({
      type: "sqlite",
      database: ":memory:",
      entities: [User, Invoice, Investment, AuthChallenge, Transaction, KYCVerification, Notification],
      synchronize: true,
      dropSchema: true,
    });
    await dataSource.initialize();

    config = {
      port: 3000,
      nodeEnv: "test",
      jwt: { secret: "test-secret", expiresIn: "1h" },
      auth: { challengeTtlMs: 5 * 60 * 1000 },
      observability: { metricsEnabled: false },
      http: {
        trustProxy: false,
        corsAllowedOrigins: [],
        corsAllowCredentials: false,
        bodySizeLimit: "1mb",
        shutdownTimeoutMs: 15000,
        rateLimit: { enabled: false, windowMs: 60000, max: 1000 },
      },
      reconciliation: { enabled: false, intervalMs: 30000, batchSize: 25, gracePeriodMs: 60000, maxRuntimeMs: 10000 },
      stellar: { network: "testnet", networkPassphrase: "Test SDF Network ; September 2015" },
      sorobanEscrow: { enabled: false, contractId: null, fundingMode: "wallet_xdr", settlementMode: "wallet_xdr" },
      admin: { apiKey: "test-admin-key" },
      ipfs: {
        pinataJwt: "test",
        pinataGateway: "test",
        timeoutMs: 5000,
        maxRetries: 3,
        baseRetryDelayMs: 100,
        maxFileSizeMB: 10,
        allowedMimeTypes: ["application/pdf", "image/png", "image/jpeg"],
        uploadRateLimit: { windowMs: 15 * 60 * 1000, maxUploads: 10 },
      },
      kyc: {
        skipVerification: true,
        webhookSecret: "",
      },
    } as unknown as AppConfig;

    authService = createAuthService(dataSource, config);
    const invoiceService = createInvoiceService(dataSource, {} as any);
    app = createApp({ authService, invoiceService, config });
  });

  afterAll(async () => {
    await dataSource.destroy();
  });

  it("should restrict seller dashboard aggregates (invoice list) to owned invoices", async () => {
    // 1. Setup - Create 2 users
    const userRepo = dataSource.getRepository(User);
    const sellerA = await userRepo.save(userRepo.create({ stellarAddress: "GA-SELLER-A", isKycVerified: true }));
    const sellerB = await userRepo.save(userRepo.create({ stellarAddress: "GA-SELLER-B", isKycVerified: true }));

    // 2. Create invoices for each
    const invoiceRepo = dataSource.getRepository(Invoice);
    await invoiceRepo.save([
        invoiceRepo.create({ sellerId: sellerA.id, invoiceNumber: "INV-A1", amount: "100", customerName: "C1", status: InvoiceStatus.DRAFT, dueDate: new Date() }),
        invoiceRepo.create({ sellerId: sellerA.id, invoiceNumber: "INV-A2", amount: "200", customerName: "C2", status: InvoiceStatus.FUNDED, dueDate: new Date() }),
        invoiceRepo.create({ sellerId: sellerB.id, invoiceNumber: "INV-B1", amount: "300", customerName: "C3", status: InvoiceStatus.SETTLED, dueDate: new Date() }),
    ]);

    // 3. Mock authentication
    const tokenA = authService.generateToken({ id: sellerA.id, stellarAddress: sellerA.stellarAddress });
    const tokenB = authService.generateToken({ id: sellerB.id, stellarAddress: sellerB.stellarAddress });

    // 4. Request invoices for Seller A
    const resA = await request(app)
      .get("/api/v1/invoices")
      .set("Authorization", `Bearer ${tokenA}`);

    expect(resA.status).toBe(200);
    expect(resA.body.data).toHaveLength(2);
    expect(resA.body.data.every((inv: any) => inv.sellerId === sellerA.id)).toBe(true);

    // 5. Request invoices for Seller B
    const resB = await request(app)
      .get("/api/v1/invoices")
      .set("Authorization", `Bearer ${tokenB}`);

    expect(resB.status).toBe(200);
    expect(resB.body.data).toHaveLength(1);
    expect(resB.body.data[0].sellerId).toBe(sellerB.id);
  });
});
