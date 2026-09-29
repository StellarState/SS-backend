import "reflect-metadata";
import crypto from "crypto";
import jwt from "jsonwebtoken";
import request from "supertest";
import { Keypair } from "stellar-sdk";
import { DataSource, getMetadataArgsStorage } from "typeorm";

import { createApp } from "../../src/app";
import { AuthChallenge } from "../../src/models/AuthChallenge.model";
import { Investment } from "../../src/models/Investment.model";
import { Invoice } from "../../src/models/Invoice.model";
import { InvoiceStatusHistory } from "../../src/models/InvoiceStatusHistory.model";
import { KYCVerification } from "../../src/models/KYCVerification.model";
import { KycHistory } from "../../src/models/KycHistory.model";
import { Notification } from "../../src/models/Notification.model";
import { SecondaryListing } from "../../src/models/SecondaryListing.model";
import { Transaction } from "../../src/models/Transaction.model";
import { User } from "../../src/models/User.model";
import { Watchlist } from "../../src/models/Watchlist.model";
import { createAuthService } from "../../src/services/auth.service";
import { InvoiceService } from "../../src/services/invoice.service";
import type { IPFSService } from "../../src/services/ipfs.service";
import { createMarketplaceService } from "../../src/services/marketplace.service";
import { createNotificationService } from "../../src/services/notification.service";
import { InvoiceStatus, KYCStatus, NotificationType, UserType } from "../../src/types/enums";
import type { AppConfig } from "../../src/config/env";

/**
 * Issue #565: the issuer/admin review workflow over HTTP, including the 409
 * shape for invalid transitions. Also checks the seller notifications for
 * approval and rejection that issue #564 asks for.
 */

const JWT_SECRET = "test-jwt-secret-key-for-review-workflow";
const ADMIN_KEY = "test-admin-key-565";

function patchEntityMetadataForSQLite(): void {
  for (const column of getMetadataArgsStorage().columns) {
    if (column.options.type === "timestamptz") column.options.type = "datetime" as never;
    if (column.options.type === "jsonb") column.options.type = "text" as never;
    if (column.options.type === "enum") column.options.type = "varchar" as never;
  }
}

describe("Integration: invoice review workflow (issue #565)", () => {
  let dataSource: DataSource;
  let app: ReturnType<typeof createApp>;
  let seller: User;
  let sellerToken: string;
  let otherSellerToken: string;
  let adminToken: string;

  beforeAll(async () => {
    process.env.JWT_SECRET = JWT_SECRET;
    process.env.ADMIN_API_KEY = ADMIN_KEY;
    patchEntityMetadataForSQLite();

    dataSource = new DataSource({
      type: "sqlite",
      database: ":memory:",
      dropSchema: true,
      synchronize: true,
      entities: [
        User,
        Invoice,
        Investment,
        AuthChallenge,
        Transaction,
        KYCVerification,
        KycHistory,
        Notification,
        SecondaryListing,
        Watchlist,
        InvoiceStatusHistory,
      ],
    });
    await dataSource.initialize();

    const config = {
      jwt: { secret: JWT_SECRET, expiresIn: "1h" },
      auth: { challengeTtlMs: 300_000 },
      stellar: { network: "testnet", networkPassphrase: "Test SDF Network ; September 2015" },
      sorobanEscrow: { enabled: false, contractId: null, fundingMode: "wallet_xdr", rpcUrl: null },
      ipfs: {
        maxFileSizeMB: 10,
        allowedMimeTypes: ["application/pdf"],
        uploadRateLimit: { windowMs: 60_000, maxUploads: 10 },
      },
      kyc: { skipVerification: true },
      cache: { enabled: false, invoicesListTtlSeconds: 30, invoiceDetailTtlSeconds: 60 },
    } as unknown as AppConfig;

    const authService = createAuthService(dataSource, config);
    const notificationService = createNotificationService(dataSource);
    const invoiceService = new InvoiceService({
      invoiceRepository: dataSource.getRepository(Invoice),
      ipfsService: {} as IPFSService,
      dataSource,
      notificationSink: notificationService,
    });

    app = createApp({
      authService,
      invoiceService,
      notificationService,
      marketplaceService: createMarketplaceService(dataSource),
      config,
      metricsEnabled: false,
      http: { rateLimit: { enabled: false } },
    });

    const users = dataSource.getRepository(User);
    seller = await users.save(
      users.create({
        stellarAddress: Keypair.random().publicKey(),
        userType: UserType.SELLER,
        kycStatus: KYCStatus.APPROVED,
      })
    );
    const otherSeller = await users.save(
      users.create({
        stellarAddress: Keypair.random().publicKey(),
        userType: UserType.SELLER,
        kycStatus: KYCStatus.APPROVED,
      })
    );

    sellerToken = authService.generateToken(seller).token;
    otherSellerToken = authService.generateToken(otherSeller).token;
    adminToken = jwt.sign(
      { sub: Keypair.random().publicKey(), userId: crypto.randomUUID(), userType: "admin" },
      JWT_SECRET,
      { expiresIn: "1h" }
    );
  });

  afterAll(async () => {
    if (dataSource?.isInitialized) {
      await dataSource.destroy();
    }
  });

  async function seedInvoice(
    status: InvoiceStatus,
    overrides: Partial<Invoice> = {}
  ): Promise<Invoice> {
    const repo = dataSource.getRepository(Invoice);
    return repo.save(
      repo.create({
        sellerId: seller.id,
        invoiceNumber: `INV-${crypto.randomBytes(4).toString("hex")}`,
        customerName: "Acme Ltd",
        amount: "1000.0000",
        discountRate: "5.00",
        netAmount: "950.0000",
        dueDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
        ipfsHash: "QmReviewWorkflowDoc",
        status,
        ...overrides,
      })
    );
  }

  const statusOf = async (id: string) =>
    (await dataSource.getRepository(Invoice).findOneByOrFail({ id })).status;

  describe("PATCH /invoices/:id/submit", () => {
    it("moves the issuer's draft to pending", async () => {
      const invoice = await seedInvoice(InvoiceStatus.DRAFT);

      const response = await request(app)
        .patch(`/api/v1/invoices/${invoice.id}/submit`)
        .set("Authorization", `Bearer ${sellerToken}`);

      expect(response.status).toBe(200);
      expect(response.body.data.status).toBe(InvoiceStatus.PENDING);
      expect(await statusOf(invoice.id)).toBe(InvoiceStatus.PENDING);
    });

    it("is restricted to the invoice's issuer", async () => {
      const invoice = await seedInvoice(InvoiceStatus.DRAFT);

      const response = await request(app)
        .patch(`/api/v1/invoices/${invoice.id}/submit`)
        .set("Authorization", `Bearer ${otherSellerToken}`);

      expect(response.status).toBe(404);
      expect(await statusOf(invoice.id)).toBe(InvoiceStatus.DRAFT);

      const unauthenticated = await request(app).patch(`/api/v1/invoices/${invoice.id}/submit`);
      expect(unauthenticated.status).toBe(401);
    });

    it("validates required fields before transitioning", async () => {
      const invoice = await seedInvoice(InvoiceStatus.DRAFT, { ipfsHash: null });

      const response = await request(app)
        .patch(`/api/v1/invoices/${invoice.id}/submit`)
        .set("Authorization", `Bearer ${sellerToken}`);

      expect(response.status).toBe(422);
      expect(response.body.error.code).toBe("INVOICE_NOT_PUBLISHABLE");
      expect(await statusOf(invoice.id)).toBe(InvoiceStatus.DRAFT);
    });

    it("returns 409 with the current and allowed states for an invalid transition", async () => {
      const invoice = await seedInvoice(InvoiceStatus.PUBLISHED);

      const response = await request(app)
        .patch(`/api/v1/invoices/${invoice.id}/submit`)
        .set("Authorization", `Bearer ${sellerToken}`);

      expect(response.status).toBe(409);
      expect(response.body.error.code).toBe("INVALID_STATUS_TRANSITION");
      expect(response.body.error.details).toMatchObject({
        currentState: InvoiceStatus.PUBLISHED,
        requestedState: InvoiceStatus.PENDING,
        allowedStates: [InvoiceStatus.FUNDED, InvoiceStatus.CANCELLED],
      });
    });
  });

  describe("PATCH /invoices/:id/approve", () => {
    it("is admin only", async () => {
      const invoice = await seedInvoice(InvoiceStatus.PENDING);

      const asSeller = await request(app)
        .patch(`/api/v1/invoices/${invoice.id}/approve`)
        .set("Authorization", `Bearer ${sellerToken}`);
      expect(asSeller.status).toBe(403);

      const anonymous = await request(app).patch(`/api/v1/invoices/${invoice.id}/approve`);
      expect(anonymous.status).toBe(401);

      const wrongKey = await request(app)
        .patch(`/api/v1/invoices/${invoice.id}/approve`)
        .set("x-admin-key", "not-the-key");
      expect(wrongKey.status).toBe(401);

      expect(await statusOf(invoice.id)).toBe(InvoiceStatus.PENDING);
    });

    it("makes a pending invoice live on the marketplace immediately and notifies the seller", async () => {
      const invoice = await seedInvoice(InvoiceStatus.PENDING);

      const before = await request(app).get("/api/v1/marketplace/invoices");
      expect(JSON.stringify(before.body)).not.toContain(invoice.id);

      const response = await request(app)
        .patch(`/api/v1/invoices/${invoice.id}/approve`)
        .set("Authorization", `Bearer ${adminToken}`);

      expect(response.status).toBe(200);
      expect(response.body.data.status).toBe(InvoiceStatus.PUBLISHED);

      const after = await request(app).get("/api/v1/marketplace/invoices");
      expect(after.status).toBe(200);
      expect(JSON.stringify(after.body)).toContain(invoice.id);

      const notification = await dataSource.getRepository(Notification).findOne({
        where: { userId: seller.id, type: NotificationType.INVOICE_APPROVED },
      });
      expect(notification?.message).toContain(invoice.invoiceNumber);
    });

    it("accepts the admin API key as well as an admin JWT", async () => {
      const invoice = await seedInvoice(InvoiceStatus.PENDING);

      const response = await request(app)
        .patch(`/api/v1/invoices/${invoice.id}/approve`)
        .set("x-admin-key", ADMIN_KEY);

      expect(response.status).toBe(200);
      expect(await statusOf(invoice.id)).toBe(InvoiceStatus.PUBLISHED);
    });

    it("returns 409 when the invoice is not pending", async () => {
      const invoice = await seedInvoice(InvoiceStatus.DRAFT);

      const response = await request(app)
        .patch(`/api/v1/invoices/${invoice.id}/approve`)
        .set("Authorization", `Bearer ${adminToken}`);

      expect(response.status).toBe(409);
      expect(response.body.error.details).toMatchObject({
        currentState: InvoiceStatus.DRAFT,
        requestedState: InvoiceStatus.PUBLISHED,
      });
      expect(response.body.error.details.allowedStates).toContain(InvoiceStatus.PENDING);
      expect(await statusOf(invoice.id)).toBe(InvoiceStatus.DRAFT);
    });
  });

  describe("PATCH /invoices/:id/reject", () => {
    it("returns a pending invoice to draft with the reason and notifies the seller", async () => {
      const invoice = await seedInvoice(InvoiceStatus.PENDING);

      const response = await request(app)
        .patch(`/api/v1/invoices/${invoice.id}/reject`)
        .set("Authorization", `Bearer ${adminToken}`)
        .send({ reason: "Purchase order is unsigned" });

      expect(response.status).toBe(200);
      expect(response.body.data.status).toBe(InvoiceStatus.DRAFT);
      expect(response.body.data.rejectionReason).toBe("Purchase order is unsigned");

      const notification = await dataSource.getRepository(Notification).findOne({
        where: { userId: seller.id, type: NotificationType.INVOICE_REJECTED },
      });
      expect(notification?.message).toContain("Purchase order is unsigned");

      // The seller can fix it and resubmit.
      const resubmit = await request(app)
        .patch(`/api/v1/invoices/${invoice.id}/submit`)
        .set("Authorization", `Bearer ${sellerToken}`);
      expect(resubmit.status).toBe(200);
      expect(await statusOf(invoice.id)).toBe(InvoiceStatus.PENDING);
    });

    it("requires a reason", async () => {
      const invoice = await seedInvoice(InvoiceStatus.PENDING);

      const response = await request(app)
        .patch(`/api/v1/invoices/${invoice.id}/reject`)
        .set("Authorization", `Bearer ${adminToken}`)
        .send({ reason: "   " });

      expect(response.status).toBe(400);
      expect(await statusOf(invoice.id)).toBe(InvoiceStatus.PENDING);
    });

    it("is admin only", async () => {
      const invoice = await seedInvoice(InvoiceStatus.PENDING);

      const response = await request(app)
        .patch(`/api/v1/invoices/${invoice.id}/reject`)
        .set("Authorization", `Bearer ${sellerToken}`)
        .send({ reason: "Self-rejection" });

      expect(response.status).toBe(403);
      expect(await statusOf(invoice.id)).toBe(InvoiceStatus.PENDING);
    });

    it("returns 409 when the invoice is not pending", async () => {
      const invoice = await seedInvoice(InvoiceStatus.FUNDED);

      const response = await request(app)
        .patch(`/api/v1/invoices/${invoice.id}/reject`)
        .set("Authorization", `Bearer ${adminToken}`)
        .send({ reason: "Too late" });

      expect(response.status).toBe(409);
      expect(response.body.error.details).toMatchObject({
        currentState: InvoiceStatus.FUNDED,
        requestedState: InvoiceStatus.DRAFT,
        allowedStates: [InvoiceStatus.SETTLED, InvoiceStatus.CANCELLED],
      });
    });
  });

  describe("DELETE /invoices/:id", () => {
    it("deletes the issuer's draft", async () => {
      const invoice = await seedInvoice(InvoiceStatus.DRAFT);

      const response = await request(app)
        .delete(`/api/v1/invoices/${invoice.id}`)
        .set("Authorization", `Bearer ${sellerToken}`);

      expect(response.status).toBe(204);
      const row = await dataSource
        .getRepository(Invoice)
        .findOne({ where: { id: invoice.id }, withDeleted: true });
      expect(row?.deletedAt).not.toBeNull();
      expect(await dataSource.getRepository(Invoice).findOneBy({ id: invoice.id })).toBeNull();
    });

    it.each([InvoiceStatus.PENDING, InvoiceStatus.PUBLISHED, InvoiceStatus.CANCELLED])(
      "refuses to delete a %s invoice with 409",
      async (status) => {
        const invoice = await seedInvoice(status);

        const response = await request(app)
          .delete(`/api/v1/invoices/${invoice.id}`)
          .set("Authorization", `Bearer ${sellerToken}`);

        expect(response.status).toBe(409);
        expect(response.body.error.details).toEqual({
          currentState: status,
          allowedStates: [InvoiceStatus.DRAFT],
        });
        const row = await dataSource.getRepository(Invoice).findOneByOrFail({ id: invoice.id });
        expect(row.deletedAt).toBeNull();
      }
    );

    it("is restricted to the invoice's issuer", async () => {
      const invoice = await seedInvoice(InvoiceStatus.DRAFT);

      const response = await request(app)
        .delete(`/api/v1/invoices/${invoice.id}`)
        .set("Authorization", `Bearer ${otherSellerToken}`);

      expect(response.status).toBe(404);
    });
  });
});
