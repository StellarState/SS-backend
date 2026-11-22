import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { DataSource } from "typeorm";
import { reliabilityDatabase, closeReliabilityDatabase } from "../helpers/postgres-reliability";
import { InvoiceService } from "../../src/services/invoice.service";
import { InvestmentService } from "../../src/services/investment.service";
import { Invoice } from "../../src/models/Invoice.model";
import { User } from "../../src/models/User.model";
import { Investment } from "../../src/models/Investment.model";
import { InvoiceDocument } from "../../src/models/InvoiceDocument.model";
import { SecondaryListing } from "../../src/models/SecondaryListing.model";
import { InvoiceStatusHistory } from "../../src/models/InvoiceStatusHistory.model";
import { InvestorAcknowledgement } from "../../src/models/InvestorAcknowledgement.model";
import { createInvoiceController } from "../../src/controllers/invoice.controller";
import { createErrorMiddleware } from "../../src/middleware/error.middleware";
import { InvoiceStatus, InvestmentStatus, KYCStatus, UserType } from "../../src/types/enums";
import { getCurrentTermsVersion } from "../../src/services/investor-acknowledgement.service";

const suite = process.env.DATABASE_URL ? describe : describe.skip;
suite("atomic draft deletion (#827)", () => {
  let source: DataSource;
  let invoice: Invoice;
  let seller: User;
  let investor: User;
  let service: InvoiceService;
  const log = {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    child: jest.fn(),
  } as never;
  beforeAll(async () => {
    source = await reliabilityDatabase();
  }, 60000);
  afterAll(async () => {
    if (source) await closeReliabilityDatabase(source);
  });
  beforeEach(async () => {
    seller = await source
      .getRepository(User)
      .save({
        stellarAddress: `G${randomUUID().replace(/-/g, "")}`,
        userType: UserType.SELLER,
        kycStatus: KYCStatus.APPROVED,
      });
    investor = await source
      .getRepository(User)
      .save({
        stellarAddress: `G${randomUUID().replace(/-/g, "")}`,
        userType: UserType.INVESTOR,
        kycStatus: KYCStatus.APPROVED,
      });
    invoice = await source
      .getRepository(Invoice)
      .save({
        sellerId: seller.id,
        invoiceNumber: randomUUID(),
        customerName: "Customer",
        amount: "1000",
        discountRate: "0",
        netAmount: "1000",
        dueDate: new Date(Date.now() + 10 * 86400000),
        status: InvoiceStatus.DRAFT,
      });
    service = new InvoiceService({
      invoiceRepository: source.getRepository(Invoice),
      ipfsService: {} as never,
      dataSource: source,
    });
  });

  it("soft deletes a draft and records its cancellation atomically", async () => {
    await service.deleteInvoice(invoice.id, seller.id);
    expect(await source.getRepository(Invoice).findOneBy({ id: invoice.id })).toBeNull();
    expect(
      await source.getRepository(Invoice).findOne({ where: { id: invoice.id }, withDeleted: true })
    ).toMatchObject({ status: InvoiceStatus.CANCELLED, deletedAt: expect.any(Date) });
    expect(
      await source.getRepository(InvoiceStatusHistory).findOneBy({ invoiceId: invoice.id })
    ).toMatchObject({ fromStatus: InvoiceStatus.DRAFT, toStatus: InvoiceStatus.CANCELLED });
  });

  it.each([InvestmentStatus.PENDING, InvestmentStatus.CONFIRMED, InvestmentStatus.CANCELLED])(
    "rejects %s investment linkage, including soft deleted records",
    async (status) => {
      const investment = await source
        .getRepository(Investment)
        .save({
          invoiceId: invoice.id,
          investorId: investor.id,
          investorWallet: investor.stellarAddress,
          investmentAmount: "10",
          expectedReturn: "10",
          status,
        });
      await source.getRepository(Investment).softDelete(investment.id);
      await expect(service.deleteInvoice(invoice.id, seller.id)).rejects.toMatchObject({
        code: "invoice_has_dependents",
        statusCode: 409,
        details: { dependencies: ["investments"] },
      });
      expect(await source.getRepository(Invoice).findOneBy({ id: invoice.id })).not.toBeNull();
    }
  );

  it("retains linked documents and returns the standard HTTP conflict envelope", async () => {
    const doc = await source
      .getRepository(InvoiceDocument)
      .save({
        invoiceId: invoice.id,
        cid: "document",
        filename: "invoice.pdf",
        mimeType: "application/pdf",
        fileSize: 10,
      });
    const app = express();
    const controller = createInvoiceController(service);
    app.delete(
      "/:id",
      (req, _res, next) => {
        (req as any).user = seller;
        next();
      },
      controller.deleteInvoice as any
    );
    app.use(createErrorMiddleware(log));
    const res = await request(app).delete(`/${invoice.id}`).expect(409);
    expect(res.body).toMatchObject({
      success: false,
      error: {
        code: "invoice_has_dependents",
        details: { invoice_id: invoice.id, dependencies: ["invoice_documents"] },
      },
    });
    expect(await source.getRepository(InvoiceDocument).findOneBy({ id: doc.id })).not.toBeNull();
  });

  it("blocks secondary listings and an invoice CID even without an investment row", async () => {
    await source
      .getRepository(SecondaryListing)
      .save({
        invoiceId: invoice.id,
        sellerWallet: investor.stellarAddress,
        sellerId: investor.id,
        quantity: "10",
        pricePerFraction: "1",
        totalPrice: "10",
        expiresAt: invoice.dueDate,
      });
    await expect(service.deleteInvoice(invoice.id, seller.id)).rejects.toMatchObject({
      code: "invoice_has_dependents",
    });
    await source.getRepository(SecondaryListing).delete({ invoiceId: invoice.id });
    await source.getRepository(Invoice).update(invoice.id, { ipfsHash: "existing-document" });
    await expect(service.deleteInvoice(invoice.id, seller.id)).rejects.toMatchObject({
      details: { dependencies: ["ipfs_document"] },
    });
  });

  it.each([InvoiceStatus.DRAFT, InvoiceStatus.PUBLISHED])(
    "concurrent invest and delete on %s have one valid outcome",
    async (status) => {
      await source.getRepository(Invoice).update(invoice.id, { status });
      await source
        .getRepository(InvestorAcknowledgement)
        .save({
          walletAddress: investor.stellarAddress,
          userId: investor.id,
          termsVersion: getCurrentTermsVersion(),
        });
      const investments = new InvestmentService(source);
      const results = await Promise.allSettled([
        service.deleteInvoice(invoice.id, seller.id),
        investments.createInvestment({
          invoiceId: invoice.id,
          investorId: investor.id,
          investorWallet: investor.stellarAddress,
          investmentAmount: "10",
        }),
      ]);
      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      const live = await source.getRepository(Invoice).findOneBy({ id: invoice.id });
      const count = await source.getRepository(Investment).countBy({ invoiceId: invoice.id });
      expect(
        status === InvoiceStatus.DRAFT ? !live && count === 0 : Boolean(live) && count === 1
      ).toBe(true);
    }
  );
});
