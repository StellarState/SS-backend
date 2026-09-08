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
import { AuthChallenge } from "../../src/models/AuthChallenge.model"; // Need this maybe?
import { HttpError } from "../../src/utils/http-error";

describe("Integration: Seller Dashboard Aggregates", () => {
  let dataSource: DataSource;
  let app: ReturnType<typeof createApp>;
  let config: AppConfig;
  let authService: ReturnType<typeof createAuthService>;

  beforeAll(async () => {
    patchEntityMetadataForSQLite();
    dataSource = new DataSource({
      type: "sqlite",
      database: ":memory:",
      entities: [User, Invoice, Investment],
      synchronize: true,
      dropSchema: true,
    });
    await dataSource.initialize();

    config = {
        jwt: { secret: "test-secret", expiresIn: "1h" },
        kyc: { skipVerification: true },
    } as any;

    authService = createAuthService(config, dataSource.getRepository(User), dataSource.getRepository(AuthChallenge));
    app = createApp(dataSource, config);
  });

  afterAll(async () => {
    await dataSource.destroy();
  });

  it("should restrict seller dashboard aggregates (invoice list) to owned invoices", async () => {
    // 1. Setup - Create 2 users
    const userRepo = dataSource.getRepository(User);
    const sellerA = await userRepo.save(userRepo.create({ stellarAddress: "GA-SELLER-A", kycVerified: true }));
    const sellerB = await userRepo.save(userRepo.create({ stellarAddress: "GA-SELLER-B", kycVerified: true }));

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
