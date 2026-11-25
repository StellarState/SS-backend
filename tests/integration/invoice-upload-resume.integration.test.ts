import { AddInvoiceUploadSessions1795300000000 } from "../../src/migrations/1795300000000-AddInvoiceUploadSessions";
import { InvoiceService } from "../../src/services/invoice.service";
import { createHash, randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { DataSource } from "typeorm";
import { reliabilityDatabase, closeReliabilityDatabase } from "../helpers/postgres-reliability";
import { InvoiceUploadService } from "../../src/services/invoice-upload.service";
import { Invoice } from "../../src/models/Invoice.model";
import { User } from "../../src/models/User.model";
import { InvoiceDocument } from "../../src/models/InvoiceDocument.model";
import { InvoiceStatus, KYCStatus, UserType } from "../../src/types/enums";
import { createInvoiceUploadsRouter } from "../../src/routes/invoice-uploads.routes";
import { createErrorMiddleware } from "../../src/middleware/error.middleware";
import { validateInvoiceForPublish } from "../../src/lib/validate-invoice-for-publish";
import type { IPFSService } from "../../src/services/ipfs.service";

const suite = process.env.DATABASE_URL ? describe : describe.skip;
suite("durable invoice upload protocol (#826)", () => {
  let source: DataSource;
  let invoice: Invoice;
  let seller: User;
  let service: InvoiceUploadService;
  let app: express.Express;
  const bytes = Buffer.from("verified invoice bytes");
  const checksum = createHash("sha256").update(bytes).digest("hex");
  const ipfs = {
    validateUploadMetadata: jest.fn(),
    uploadFile: jest.fn().mockResolvedValue({
      hash: "QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG",
      size: bytes.length,
      timestamp: new Date().toISOString(),
    }),
  };
  const log = {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    child: jest.fn(),
  } as never;

  beforeAll(async () => {
    source = await reliabilityDatabase();
    const runner = source.createQueryRunner();
    const migration = new AddInvoiceUploadSessions1795300000000();
    await migration.down(runner);
    await migration.up(runner);
    await runner.release();
  }, 60000);
  afterAll(async () => {
    if (source) await closeReliabilityDatabase(source);
  });
  beforeEach(async () => {
    jest.clearAllMocks();
    seller = await source.getRepository(User).save({
      stellarAddress: `G${randomUUID().replace(/-/g, "")}`,
      userType: UserType.SELLER,
      kycStatus: KYCStatus.APPROVED,
    });
    invoice = await source.getRepository(Invoice).save({
      sellerId: seller.id,
      invoiceNumber: randomUUID(),
      customerName: "Customer",
      amount: "1000",
      discountRate: "0",
      netAmount: "1000",
      dueDate: new Date(Date.now() + 10 * 86400000),
      status: InvoiceStatus.DRAFT,
      ipfsHash: "legacy-document",
    });
    service = new InvoiceUploadService(source, ipfs as unknown as IPFSService);
    app = express();
    app.use(express.json());
    app.use(
      "/api/v1/invoices",
      createInvoiceUploadsRouter(service, { getCurrentUser: async () => seller } as never)
    );
    app.use(createErrorMiddleware(log));
  });
  const start = (override = {}) =>
    request(app)
      .post(`/api/v1/invoices/${invoice.id}/uploads`)
      .set("Authorization", "Bearer test")
      .send({
        filename: "invoice.pdf",
        mime_type: "application/pdf",
        file_size_bytes: bytes.length,
        content_checksum: checksum,
        ...override,
      });

  it("resumes after service recreation, accepts exact retries, and persists verified completion", async () => {
    const id = randomUUID();
    await start({ upload_session_id: id }).expect(201);
    await start({ upload_session_id: id }).expect(201);
    expect(
      validateInvoiceForPublish(
        await source.getRepository(Invoice).findOneByOrFail({ id: invoice.id })
      )
    ).toEqual(expect.arrayContaining([expect.objectContaining({ code: "DOCUMENT_NOT_VERIFIED" })]));
    const publisher = new InvoiceService({
      invoiceRepository: source.getRepository(Invoice),
      dataSource: source,
      ipfsService: ipfs as never,
    });
    await expect(
      publisher.publishInvoice({ invoiceId: invoice.id, sellerId: seller.id })
    ).rejects.toMatchObject({ code: "invoice_not_publishable" });
    const first = bytes.subarray(0, 8);
    await service.append(invoice.id, seller.id, id, 0, first);
    service = new InvoiceUploadService(source, ipfs as unknown as IPFSService);
    expect((await service.get(invoice.id, seller.id, id)).received_bytes).toBe(8);
    await service.append(invoice.id, seller.id, id, 0, first);
    await expect(
      service.append(invoice.id, seller.id, id, 0, Buffer.from("changed!"))
    ).rejects.toMatchObject({ statusCode: 409 });
    await service.append(invoice.id, seller.id, id, 8, bytes.subarray(8));
    const done = await service.complete(invoice.id, seller.id, id);
    expect(done).toMatchObject({
      upload_complete: true,
      content_checksum: checksum,
      received_bytes: bytes.length,
    });
    await service.complete(invoice.id, seller.id, id);
    expect(ipfs.uploadFile).toHaveBeenCalledTimes(1);
    expect(ipfs.uploadFile.mock.calls[0][0]).toEqual(bytes);
    expect(
      await source.getRepository(InvoiceDocument).findOneBy({ invoiceId: invoice.id })
    ).toMatchObject({
      fileSize: bytes.length,
      contentChecksum: checksum,
      checksumVerified: true,
      uploadSessionId: id,
    });
    expect(
      validateInvoiceForPublish(
        await source.getRepository(Invoice).findOneByOrFail({ id: invoice.id })
      )
    ).toEqual([]);
    await publisher.publishInvoice({ invoiceId: invoice.id, sellerId: seller.id });
    expect((await service.complete(invoice.id, seller.id, id)).upload_complete).toBe(true);
    expect(ipfs.uploadFile).toHaveBeenCalledTimes(1);
  });

  it("rejects mismatched bytes before pinning and returns the standard conflict envelope", async () => {
    const res = await start({ content_checksum: "0".repeat(64) }).expect(201);
    const id = res.body.data.upload_session_id;
    await request(app)
      .patch(`/api/v1/invoices/${invoice.id}/uploads/${id}`)
      .set("Authorization", "Bearer test")
      .set("Content-Type", "application/octet-stream")
      .set("Upload-Offset", "0")
      .send(bytes)
      .expect(200);
    const conflict = await request(app)
      .post(`/api/v1/invoices/${invoice.id}/uploads/${id}/complete`)
      .set("Authorization", "Bearer test")
      .expect(409);
    expect(conflict.body).toMatchObject({ success: false, error: { code: "checksum_mismatch" } });
    expect(ipfs.uploadFile).not.toHaveBeenCalled();
    expect((await service.get(invoice.id, seller.id, id)).upload_complete).toBe(false);
  });

  it("rejects a duplicate checksum before calling IPFS", async () => {
    await source.getRepository(InvoiceDocument).save({
      invoiceId: invoice.id,
      cid: "QmAlreadyPinned",
      docType: "invoice_pdf",
      filename: "invoice.pdf",
      mimeType: "application/pdf",
      fileSize: bytes.length,
      contentChecksum: checksum,
      checksumVerified: true,
    });
    const res = await start();
    const id = res.body.data.upload_session_id;
    await service.append(invoice.id, seller.id, id, 0, bytes);
    await expect(service.complete(invoice.id, seller.id, id)).rejects.toMatchObject({
      code: "duplicate_invoice_document",
      statusCode: 409,
    });
    expect(ipfs.uploadFile).not.toHaveBeenCalled();
  });

  it("restarts from zero and rejects stale chunks from the superseded session", async () => {
    const res = await start().expect(201);
    const id = res.body.data.upload_session_id;
    await service.append(invoice.id, seller.id, id, 0, bytes.subarray(0, 8));
    const restarted = await service.restart(invoice.id, seller.id, id, {
      content_checksum: null,
      filename: "replacement.pdf",
    });
    expect(restarted.upload_session_id).not.toBe(id);
    expect(restarted.received_bytes).toBe(0);
    expect(restarted.content_checksum).toBeNull();
    expect(restarted.filename).toBe("replacement.pdf");
    await expect(
      service.append(invoice.id, seller.id, id, 8, bytes.subarray(8))
    ).rejects.toMatchObject({ code: "upload_state_conflict" });
    await expect(
      service.complete(invoice.id, seller.id, restarted.upload_session_id)
    ).rejects.toMatchObject({ code: "upload_incomplete" });
  });

  it.each([
    { content_checksum: "bad" },
    { file_size_bytes: "10" },
    { upload_session_id: "invalid" },
    { filename: "" },
  ])("validates metadata before persistence: %j", async (body) => {
    await start(body).expect(400);
  });

  it("preserves chunks after gateway failure and rejects access by another owner", async () => {
    const res = await start().expect(201);
    const id = res.body.data.upload_session_id;
    await expect(service.get(invoice.id, randomUUID(), id)).rejects.toMatchObject({
      statusCode: 403,
    });
    await service.append(invoice.id, seller.id, id, 0, bytes);
    ipfs.uploadFile.mockRejectedValueOnce(new Error("gateway unavailable"));
    await expect(service.complete(invoice.id, seller.id, id)).rejects.toThrow(
      "gateway unavailable"
    );
    expect((await service.get(invoice.id, seller.id, id)).received_bytes).toBe(bytes.length);
    expect((await service.complete(invoice.id, seller.id, id)).upload_complete).toBe(true);
  });
});
