import request from "supertest";
import express from "express";
import { QueryFailedError, type DataSource } from "typeorm";
import { createInvoiceDocumentsRouter } from "../../src/routes/invoice-documents.routes";
import { createErrorMiddleware } from "../../src/middleware/error.middleware";
import { InvoiceDocumentService } from "../../src/services/invoice-document.service";
import { InvoiceService } from "../../src/services/invoice.service";
import { Invoice } from "../../src/models/Invoice.model";
import { InvoiceDocument } from "../../src/models/InvoiceDocument.model";
import { isValidCid } from "../../src/utils/cid.utils";
import { InvoiceStatus, KYCStatus, UserType } from "../../src/types/enums";
import type { InvoiceTransition } from "../../src/lib/invoice-state-machine";

const silentLogger = {
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  child: jest.fn(),
} as never;

const CID_V0 = "QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG";
const CID_V1_BASE32 = "bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi";
const CID_V1_BASE58 = "zdj7WWeQ43G6JJvLWQWZpyHuAMq6uYWRjkBXFad11vE2LHhQ7";
const CID_RAW_LEAF = "bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku";

const OWNER_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OTHER_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const INVOICE_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

describe("isValidCid (issue #781)", () => {
  it.each([CID_V0, CID_V1_BASE32, CID_V1_BASE58, CID_RAW_LEAF])("accepts %s", (cid) => {
    expect(isValidCid(cid)).toBe(true);
  });

  it.each([
    ["empty", ""],
    ["garbage", "not-a-cid"],
    ["short v0", "Qm123"],
    ["truncated base32", CID_V1_BASE32.slice(0, -1)],
    ["extended base32", `${CID_V1_BASE32}a`],
    ["truncated base58", CID_V1_BASE58.slice(0, -1)],
    ["uppercase base32", CID_V1_BASE32.toUpperCase()],
    ["base58 with invalid char 0", `z${"0".repeat(48)}`],
  ])("rejects %s", (_label, cid) => {
    expect(isValidCid(cid)).toBe(false);
  });

  it("rejects non-strings", () => {
    expect(isValidCid(undefined)).toBe(false);
    expect(isValidCid(42)).toBe(false);
  });
});

interface Store {
  invoice: Partial<Invoice> | null;
  documents: InvoiceDocument[];
}

function fakeDataSource(store: Store) {
  const documentRepo = {
    create: jest.fn((data: Partial<InvoiceDocument>) => ({ ...data })),
    save: jest.fn(async (doc: InvoiceDocument) => {
      if (store.documents.some((d) => d.cid === doc.cid && !d.deletedAt)) {
        throw new QueryFailedError(
          "INSERT",
          [],
          new Error("duplicate key value violates unique constraint")
        );
      }
      const saved = {
        ...doc,
        id: `doc-${store.documents.length + 1}`,
        createdAt: new Date(Date.UTC(2026, 0, store.documents.length + 1)),
        deletedAt: null,
      } as InvoiceDocument;
      store.documents.push(saved);
      return saved;
    }),
    find: jest.fn(async () => store.documents.filter((d) => !d.deletedAt)),
    softDelete: jest.fn(async ({ invoiceId }: { invoiceId: string }) => {
      let affected = 0;
      for (const doc of store.documents) {
        if (doc.invoiceId === invoiceId && !doc.deletedAt) {
          doc.deletedAt = new Date();
          affected++;
        }
      }
      return { affected };
    }),
  };
  const invoiceRepo = { findOne: jest.fn(async () => store.invoice) };
  const getRepository = jest.fn((entity: unknown) =>
    entity === InvoiceDocument ? documentRepo : invoiceRepo
  );
  const dataSource = {
    getRepository,
    manager: { getRepository },
    transaction: async (fn: (manager: unknown) => unknown) => fn({ getRepository }),
  } as unknown as DataSource;
  return { dataSource, documentRepo };
}

function buildApp(store: Store, user: { id: string; userType?: UserType; role?: string }) {
  const { dataSource, documentRepo } = fakeDataSource(store);
  const service = new InvoiceDocumentService(dataSource, silentLogger);
  const authService = {
    getCurrentUser: jest.fn().mockResolvedValue({
      stellarAddress: "GUSER",
      kycStatus: KYCStatus.APPROVED,
      userType: UserType.SELLER,
      ...user,
    }),
  };
  const app = express();
  app.use(express.json());
  app.use(
    "/api/v1/invoices",
    createInvoiceDocumentsRouter({
      invoiceDocumentService: service,
      authService: authService as never,
    })
  );
  app.use(createErrorMiddleware(silentLogger));
  return { app, service, documentRepo };
}

function newStore(status: InvoiceStatus = InvoiceStatus.DRAFT): Store {
  return { invoice: { id: INVOICE_ID, sellerId: OWNER_ID, status }, documents: [] };
}

const validBody = {
  cid: CID_V1_BASE32,
  document_type: "invoice_pdf",
  file_size_bytes: 123456,
};

describe("POST /api/v1/invoices/:id/documents (issue #781)", () => {
  it("registers a CID with accurate type and size metadata", async () => {
    const store = newStore();
    const { app } = buildApp(store, { id: OWNER_ID });

    const res = await request(app)
      .post(`/api/v1/invoices/${INVOICE_ID}/documents`)
      .set("Authorization", "Bearer token")
      .send({ ...validBody, filename: "invoice.pdf", mime_type: "application/pdf" })
      .expect(201);

    expect(res.body.data).toMatchObject({
      invoice_id: INVOICE_ID,
      cid: CID_V1_BASE32,
      document_type: "invoice_pdf",
      file_size_bytes: 123456,
      filename: "invoice.pdf",
      mime_type: "application/pdf",
    });
    expect(store.documents[0]).toMatchObject({
      cid: CID_V1_BASE32,
      docType: "invoice_pdf",
      fileSize: 123456,
    });
  });

  it("rejects an invalid CID with cid_invalid", async () => {
    const store = newStore();
    const { app } = buildApp(store, { id: OWNER_ID });

    const res = await request(app)
      .post(`/api/v1/invoices/${INVOICE_ID}/documents`)
      .set("Authorization", "Bearer token")
      .send({ ...validBody, cid: "QmNotARealCid" })
      .expect(400);

    expect(res.body.error.code).toBe("cid_invalid");
    expect(store.documents).toHaveLength(0);
  });

  it("only lets the invoice owner register documents", async () => {
    const store = newStore();
    const { app } = buildApp(store, { id: OTHER_ID });

    const res = await request(app)
      .post(`/api/v1/invoices/${INVOICE_ID}/documents`)
      .set("Authorization", "Bearer token")
      .send(validBody)
      .expect(403);

    expect(res.body.error.code).toBe("unauthorized_invoice_access");
    expect(store.documents).toHaveLength(0);
  });

  it.each([
    ["unknown document_type", { document_type: "selfie" }],
    ["zero size", { file_size_bytes: 0 }],
    ["fractional size", { file_size_bytes: 1.5 }],
    ["string size", { file_size_bytes: "100" }],
    ["oversized", { file_size_bytes: 2_147_483_648 }],
    ["empty filename", { filename: " " }],
  ])("rejects %s with VALIDATION_ERROR", async (_label, override) => {
    const { app } = buildApp(newStore(), { id: OWNER_ID });
    const res = await request(app)
      .post(`/api/v1/invoices/${INVOICE_ID}/documents`)
      .set("Authorization", "Bearer token")
      .send({ ...validBody, ...override })
      .expect(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("rejects a CID already registered on the invoice", async () => {
    const { app } = buildApp(newStore(), { id: OWNER_ID });
    const post = () =>
      request(app)
        .post(`/api/v1/invoices/${INVOICE_ID}/documents`)
        .set("Authorization", "Bearer token")
        .send(validBody);

    await post().expect(201);
    const res = await post().expect(409);
    expect(res.body.error.code).toBe("document_already_registered");
  });

  it("rejects registration on funded or withdrawn invoices", async () => {
    for (const status of [InvoiceStatus.FUNDED, InvoiceStatus.CANCELLED]) {
      const { app } = buildApp(newStore(status), { id: OWNER_ID });
      const res = await request(app)
        .post(`/api/v1/invoices/${INVOICE_ID}/documents`)
        .set("Authorization", "Bearer token")
        .send(validBody)
        .expect(409);
      expect(res.body.error.code).toBe("invalid_invoice_status");
    }
  });

  it("returns 404 for unknown or malformed invoice ids", async () => {
    const missing = buildApp({ invoice: null, documents: [] }, { id: OWNER_ID });
    await request(missing.app)
      .post(`/api/v1/invoices/${INVOICE_ID}/documents`)
      .set("Authorization", "Bearer token")
      .send(validBody)
      .expect(404);

    const malformed = buildApp(newStore(), { id: OWNER_ID });
    await request(malformed.app)
      .get("/api/v1/invoices/not-a-uuid/documents")
      .set("Authorization", "Bearer token")
      .expect(404);
  });

  it("requires authentication", async () => {
    const { app } = buildApp(newStore(), { id: OWNER_ID });
    await request(app).post(`/api/v1/invoices/${INVOICE_ID}/documents`).send(validBody).expect(401);
  });
});

describe("GET /api/v1/invoices/:id/documents (issue #781)", () => {
  async function registerAll(service: InvoiceDocumentService) {
    const requester = { id: OWNER_ID };
    await service.registerDocument({
      invoiceId: INVOICE_ID,
      requester,
      cid: CID_V1_BASE32,
      documentType: "invoice_pdf",
      fileSizeBytes: 100,
    });
    await service.registerDocument({
      invoiceId: INVOICE_ID,
      requester,
      cid: CID_V0,
      documentType: "verification_report",
      fileSizeBytes: 200,
    });
    await service.registerDocument({
      invoiceId: INVOICE_ID,
      requester,
      cid: CID_V1_BASE58,
      documentType: "issuer_cert",
      fileSizeBytes: 300,
    });
  }

  it("returns every registered document with CIDs and metadata", async () => {
    const store = newStore(InvoiceStatus.PUBLISHED);
    const { app, service } = buildApp(store, { id: OTHER_ID });
    await registerAll(service);

    const res = await request(app)
      .get(`/api/v1/invoices/${INVOICE_ID}/documents`)
      .set("Authorization", "Bearer token")
      .expect(200);

    expect(
      res.body.data.map((d: Record<string, unknown>) => [d.cid, d.document_type, d.file_size_bytes])
    ).toEqual([
      [CID_V1_BASE32, "invoice_pdf", 100],
      [CID_V0, "verification_report", 200],
      [CID_V1_BASE58, "issuer_cert", 300],
    ]);
  });

  it("excludes soft-deleted documents", async () => {
    const store = newStore(InvoiceStatus.PUBLISHED);
    const { app, service } = buildApp(store, { id: OWNER_ID });
    await registerAll(service);
    store.documents[1].deletedAt = new Date();

    const res = await request(app)
      .get(`/api/v1/invoices/${INVOICE_ID}/documents`)
      .set("Authorization", "Bearer token")
      .expect(200);

    expect(res.body.data.map((d: { cid: string }) => d.cid)).toEqual([
      CID_V1_BASE32,
      CID_V1_BASE58,
    ]);
  });

  it("hides documents of non-public invoices from other users but not the owner or admins", async () => {
    const store = newStore(InvoiceStatus.DRAFT);
    const other = buildApp(store, { id: OTHER_ID, userType: UserType.INVESTOR });
    await request(other.app)
      .get(`/api/v1/invoices/${INVOICE_ID}/documents`)
      .set("Authorization", "Bearer token")
      .expect(404);

    const owner = buildApp(store, { id: OWNER_ID });
    await request(owner.app)
      .get(`/api/v1/invoices/${INVOICE_ID}/documents`)
      .set("Authorization", "Bearer token")
      .expect(200);

    const admin = buildApp(store, { id: OTHER_ID, userType: UserType.ADMIN });
    await request(admin.app)
      .get(`/api/v1/invoices/${INVOICE_ID}/documents`)
      .set("Authorization", "Bearer token")
      .expect(200);
  });
});

describe("document soft delete on invoice withdrawal (issue #781)", () => {
  it("soft-deletes documents when an invoice is cancelled", async () => {
    const store = newStore();
    const { service, documentRepo } = buildApp(store, { id: OWNER_ID });
    await service.registerDocument({
      invoiceId: INVOICE_ID,
      requester: { id: OWNER_ID },
      cid: CID_V0,
      documentType: "invoice_pdf",
      fileSizeBytes: 1,
    });
    const effect = service.createWithdrawalEffect();

    await effect({ to: InvoiceStatus.PUBLISHED, invoice: { id: INVOICE_ID } } as InvoiceTransition);
    expect(documentRepo.softDelete).not.toHaveBeenCalled();

    await effect({ to: InvoiceStatus.CANCELLED, invoice: { id: INVOICE_ID } } as InvoiceTransition);
    expect(documentRepo.softDelete).toHaveBeenCalledWith({ invoiceId: INVOICE_ID });
    expect(await service.listDocuments(INVOICE_ID, { id: OWNER_ID })).toEqual([]);
  });

  it("rejects draft deletion with document linkage instead of removing documents", async () => {
    const save = jest.fn();
    const invoice = { id: INVOICE_ID, sellerId: OWNER_ID, status: InvoiceStatus.DRAFT } as Invoice;
    const manager = {
      findOne: jest.fn().mockResolvedValue(invoice),
      save,
      getRepository: jest.fn((entity) => ({ count: async () => entity === InvoiceDocument ? 2 : 0 })),
      connection: { getMetadata: () => ({ tableName: "invoice_documents" }) },
    };
    const service = new InvoiceService({ invoiceRepository: {} as never, ipfsService: {} as never, dataSource: { transaction: async (fn: (m: unknown) => unknown) => fn(manager) } as never });
    await expect(service.deleteInvoice(INVOICE_ID, OWNER_ID)).rejects.toMatchObject({ code: "invoice_has_dependents", statusCode: 409 });
    expect(save).not.toHaveBeenCalled();
  });
});
