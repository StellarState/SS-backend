import "reflect-metadata";
import crypto from "crypto";
import request from "supertest";
import { Keypair } from "stellar-sdk";
import type { Request, Response } from "express";
import { DataSource, getMetadataArgsStorage } from "typeorm";

import { createApp } from "../../src/app";
import { AuthChallenge } from "../../src/models/AuthChallenge.model";
import { Investment } from "../../src/models/Investment.model";
import { Invoice } from "../../src/models/Invoice.model";
import { KYCVerification } from "../../src/models/KYCVerification.model";
import { KycHistory } from "../../src/models/KycHistory.model";
import { Notification } from "../../src/models/Notification.model";
import { SecondaryListing } from "../../src/models/SecondaryListing.model";
import { Transaction } from "../../src/models/Transaction.model";
import { User } from "../../src/models/User.model";
import { Watchlist } from "../../src/models/Watchlist.model";
import { approveKYC } from "../../src/routes/admin/approve-kyc";
import { rejectKYC } from "../../src/routes/admin/reject-kyc";
import { revokeKYC } from "../../src/routes/admin/revoke-kyc";
import { createAuthService, type AuthService } from "../../src/services/auth.service";
import { KycService } from "../../src/services/kyc.service";
import { createNotificationService } from "../../src/services/notification.service";
import { SecondaryMarketService } from "../../src/services/secondary-market.service";
import {
  InvoiceStatus,
  KYCStatus,
  KYCVerificationType,
  ListingStatus,
  NotificationType,
  UserType,
} from "../../src/types/enums";
import type { AppConfig } from "../../src/config/env";
import type { AppLogger } from "../../src/observability/logger";

/**
 * Issue #564: notifications are created for KYC decisions and secondary
 * market sales, and the list / mark-read endpoints return an accurate unread
 * count scoped to the requesting wallet.
 */

const JWT_SECRET = "test-jwt-secret-key-for-notification-events";
const ADMIN_KEY = "test-admin-key-564";

function patchEntityMetadataForSQLite(): void {
  for (const column of getMetadataArgsStorage().columns) {
    if (column.options.type === "timestamptz") column.options.type = "datetime" as never;
    // simple-json round-trips objects on SQLite, so notification `data` can be asserted on.
    if (column.options.type === "jsonb") column.options.type = "simple-json" as never;
    if (column.options.type === "enum") column.options.type = "varchar" as never;
  }
}

const silentLogger = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
} as unknown as AppLogger;

/** Minimal Express response that records what the admin handlers send. */
function fakeResponse() {
  const res = { statusCode: 200, body: undefined as unknown };
  const api = {
    status(code: number) {
      res.statusCode = code;
      return api;
    },
    json(body: unknown) {
      res.body = body;
      return api;
    },
  };
  return { res, api: api as unknown as Response };
}

describe("Integration: platform event notifications (issue #564)", () => {
  let dataSource: DataSource;
  let app: ReturnType<typeof createApp>;
  let authService: AuthService;

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
      ],
    });
    await dataSource.initialize();

    const config = {
      jwt: { secret: JWT_SECRET, expiresIn: "1h" },
      auth: { challengeTtlMs: 300_000 },
      stellar: { network: "testnet", networkPassphrase: "Test SDF Network ; September 2015" },
    } as unknown as AppConfig;

    authService = createAuthService(dataSource, config);
    app = createApp({
      authService,
      notificationService: createNotificationService(dataSource),
      metricsEnabled: false,
      http: { rateLimit: { enabled: false } },
    });
  });

  afterAll(async () => {
    if (dataSource?.isInitialized) {
      await dataSource.destroy();
    }
  });

  async function seedUser(kycStatus = KYCStatus.PENDING, userType = UserType.INVESTOR) {
    const users = dataSource.getRepository(User);
    return users.save(
      users.create({ stellarAddress: Keypair.random().publicKey(), userType, kycStatus })
    );
  }

  const notificationsFor = (userId: string) =>
    dataSource.getRepository(Notification).find({ where: { userId } });

  describe("KYC status changes", () => {
    const adminRequest = (body: Record<string, unknown>) =>
      ({ headers: { "x-admin-key": ADMIN_KEY }, body }) as unknown as Request<
        unknown,
        unknown,
        never
      >;

    it("notifies the user when an admin approves, rejects or revokes their KYC", async () => {
      const user = await seedUser(KYCStatus.PENDING);
      const reviewer = await seedUser(KYCStatus.APPROVED);

      const approved = fakeResponse();
      await approveKYC(adminRequest({ userId: user.id, reviewerId: reviewer.id }), approved.api, dataSource);
      expect(approved.res.statusCode).toBe(200);

      const revoked = fakeResponse();
      await revokeKYC(
        adminRequest({ userId: user.id, reviewerId: reviewer.id, revocationReason: "Expired ID" }),
        revoked.api,
        dataSource
      );
      expect(revoked.res.statusCode).toBe(200);

      const rejected = fakeResponse();
      await rejectKYC(
        adminRequest({ userId: user.id, reviewerId: reviewer.id, rejectionReason: "Blurry scan" }),
        rejected.api,
        dataSource
      );
      expect(rejected.res.statusCode).toBe(200);

      const byType = (await notificationsFor(user.id)).map((n) => [n.type, n.title, n.message]);
      expect(byType).toEqual(
        expect.arrayContaining([
          [NotificationType.KYC_APPROVED, "KYC Approved", expect.any(String)],
          [NotificationType.KYC, "KYC Approval Revoked", expect.stringContaining("Expired ID")],
          [NotificationType.KYC_REJECTED, "KYC Rejected", expect.stringContaining("Blurry scan")],
        ])
      );
      expect(byType).toHaveLength(3);

      // The reviewer is not notified about someone else's KYC.
      expect(await notificationsFor(reviewer.id)).toHaveLength(0);
    });

    it("notifies the user when the KYC provider webhook decides", async () => {
      const user = await seedUser(KYCStatus.PENDING);
      const verifications = dataSource.getRepository(KYCVerification);
      await verifications.save(
        verifications.create({
          userId: user.id,
          verificationType: KYCVerificationType.IDENTITY,
          status: KYCStatus.PENDING,
          wallet: user.stellarAddress,
        })
      );

      await new KycService(dataSource, "secret", silentLogger).processWebhook({
        userId: user.id,
        status: KYCStatus.APPROVED,
      });

      const [notification] = await notificationsFor(user.id);
      expect(notification).toMatchObject({
        type: NotificationType.KYC_APPROVED,
        title: "KYC Approved",
        read: false,
      });
    });
  });

  describe("secondary market sales", () => {
    it("notifies the listing's seller on a partial and then a full sale", async () => {
      const seller = await seedUser(KYCStatus.APPROVED);
      const buyer = await seedUser(KYCStatus.APPROVED);

      const invoices = dataSource.getRepository(Invoice);
      const invoice = await invoices.save(
        invoices.create({
          sellerId: (await seedUser(KYCStatus.APPROVED, UserType.SELLER)).id,
          invoiceNumber: `INV-${crypto.randomBytes(3).toString("hex")}`,
          customerName: "Acme Ltd",
          amount: "1000.0000",
          discountRate: "5.00",
          netAmount: "950.0000",
          dueDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
          status: InvoiceStatus.FUNDED,
        })
      );

      // Legacy listing with only the wallet recorded: the seller is found by wallet.
      const listings = dataSource.getRepository(SecondaryListing);
      const listing = await listings.save(
        listings.create({
          invoiceId: invoice.id,
          sellerWallet: seller.stellarAddress,
          sellerId: null,
          quantity: "10.0000",
          pricePerFraction: "2.0000",
          totalPrice: "20.0000",
          status: ListingStatus.ACTIVE,
          expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
        })
      );

      const market = new SecondaryMarketService(dataSource);
      await market.buyListing({
        listingId: listing.id,
        buyerWallet: buyer.stellarAddress,
        buyerId: buyer.id,
        quantity: "4",
      });
      await market.buyListing({
        listingId: listing.id,
        buyerWallet: buyer.stellarAddress,
        buyerId: buyer.id,
      });

      const sold = await notificationsFor(seller.id);
      expect(sold).toHaveLength(2);
      expect(sold.every((n) => n.type === NotificationType.LISTING_SOLD)).toBe(true);

      const partial = sold.find((n) => n.title === "Listing Partially Sold");
      expect(partial?.message).toContain(invoice.invoiceNumber);
      expect(partial?.data).toMatchObject({
        listingId: listing.id,
        quantity: "4.0000",
        totalPrice: "8.0000",
        remainingQuantity: "6.0000",
      });

      const full = sold.find((n) => n.title === "Listing Sold");
      expect(full?.data).toMatchObject({
        quantity: "6.0000",
        totalPrice: "12.0000",
        remainingQuantity: "0.0000",
      });
      expect(await notificationsFor(buyer.id)).toHaveLength(0);
    });

    it("does not notify anyone when the purchase fails", async () => {
      const seller = await seedUser(KYCStatus.APPROVED);
      const market = new SecondaryMarketService(dataSource);

      await expect(
        market.buyListing({
          listingId: crypto.randomUUID(),
          buyerWallet: Keypair.random().publicKey(),
          buyerId: crypto.randomUUID(),
        })
      ).rejects.toMatchObject({ code: "LISTING_NOT_FOUND" });

      expect(await notificationsFor(seller.id)).toHaveLength(0);
    });
  });

  describe("GET /notifications and mark-read", () => {
    let owner: User;
    let ownerToken: string;
    let strangerToken: string;
    let strangerNotificationId: string;
    const ids: string[] = [];

    beforeAll(async () => {
      owner = await seedUser();
      const stranger = await seedUser();
      ownerToken = authService.generateToken(owner).token;
      strangerToken = authService.generateToken(stranger).token;

      const repo = dataSource.getRepository(Notification);
      const base = Date.now() - 60_000;
      // Inserted out of order on purpose; the API must return newest first.
      for (const [offset, read] of [
        [2, false],
        [0, true],
        [4, false],
        [1, false],
        [3, true],
      ] as const) {
        const at = new Date(base + offset * 1000);
        const saved = await repo.save(
          repo.create({
            userId: owner.id,
            type: NotificationType.SYSTEM,
            title: `n${offset}`,
            message: `notification ${offset}`,
            read,
            timestamp: at,
            createdAt: at,
          })
        );
        ids[offset] = saved.id;
      }

      const strangers = await repo.save(
        repo.create({
          userId: stranger.id,
          type: NotificationType.SYSTEM,
          title: "not yours",
          message: "belongs to someone else",
          read: false,
        })
      );
      strangerNotificationId = strangers.id;
    });

    const list = (token: string) =>
      request(app).get("/api/v1/notifications").set("Authorization", `Bearer ${token}`);

    it("lists only the wallet's notifications, newest first, with an accurate unread count", async () => {
      const response = await list(ownerToken);

      expect(response.status).toBe(200);
      expect(response.body.data.map((n: Notification) => n.title)).toEqual([
        "n4",
        "n3",
        "n2",
        "n1",
        "n0",
      ]);
      expect(response.body.unreadCount).toBe(3);
      expect(JSON.stringify(response.body)).not.toContain(strangerNotificationId);
    });

    it("keeps the unread count for the whole inbox when filtering", async () => {
      const response = await request(app)
        .get("/api/v1/notifications?read=true")
        .set("Authorization", `Bearer ${ownerToken}`);

      expect(response.body.data).toHaveLength(2);
      expect(response.body.unreadCount).toBe(3);
    });

    it("marks a single notification read and lowers the unread count", async () => {
      const response = await request(app)
        .patch(`/api/v1/notifications/${ids[4]}/read`)
        .set("Authorization", `Bearer ${ownerToken}`);

      expect(response.status).toBe(200);
      expect(response.body.data.read).toBe(true);
      expect((await list(ownerToken)).body.unreadCount).toBe(2);
    });

    it("does not let one wallet mark another wallet's notification read", async () => {
      const response = await request(app)
        .patch(`/api/v1/notifications/${strangerNotificationId}/read`)
        .set("Authorization", `Bearer ${ownerToken}`);

      expect(response.status).toBe(404);
      const row = await dataSource
        .getRepository(Notification)
        .findOneByOrFail({ id: strangerNotificationId });
      expect(row.read).toBe(false);
    });

    it("marks every notification read in bulk without touching other wallets", async () => {
      const response = await request(app)
        .patch("/api/v1/notifications/read-all")
        .set("Authorization", `Bearer ${ownerToken}`);

      expect(response.status).toBe(200);
      expect(response.body.data.updated).toBe(2);

      const after = await list(ownerToken);
      expect(after.body.unreadCount).toBe(0);
      expect(after.body.data.every((n: Notification) => n.read)).toBe(true);

      expect((await list(strangerToken)).body.unreadCount).toBe(1);
    });
  });
});
