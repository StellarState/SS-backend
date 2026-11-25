import { QueryFailedError } from "typeorm";
import {
  InvoiceExtensionService,
  PENDING_EXTENSION_UNIQUE_INDEX,
  validateProposedDeadline,
} from "../../src/services/invoice-extension.service";
import { Invoice } from "../../src/models/Invoice.model";
import { Investment } from "../../src/models/Investment.model";
import { InvoiceExtensionRequest } from "../../src/models/InvoiceExtensionRequest.model";
import { ExtensionRequestStatus, InvoiceStatus } from "../../src/types/enums";
import { ServiceError } from "../../src/utils/service-error";

/** Fixed clock for every case. */
const NOW = new Date("2026-06-01T12:00:00.000Z");

type Row = Record<string, unknown>;

function makeService(opts: {
  invoice?: Row | null;
  pending?: Row | null;
  request?: Row | null;
  now?: Date;
  saveError?: unknown;
}) {
  const requestRepo = {
    findOne: jest.fn(async ({ where }: { where: Row }) => {
      if (where.id) return opts.request ?? null;
      if (where.status === ExtensionRequestStatus.PENDING) return opts.pending ?? null;
      return null;
    }),
    create: jest.fn((data: Row) => ({ id: "req-1", createdAt: NOW, updatedAt: NOW, ...data })),
    save: jest.fn(async (row: Row) => {
      if (opts.saveError) throw opts.saveError;
      return row;
    }),
  };
  const invoiceRepo = {
    findOne: jest.fn(async () => (opts.invoice ? { ...opts.invoice } : null)),
    save: jest.fn(async (row: Row) => row),
  };
  const investmentRepo = { find: jest.fn().mockResolvedValue([]) };
  const repoFor = (entity: unknown) => {
    if (entity === InvoiceExtensionRequest) return requestRepo;
    if (entity === Invoice) return invoiceRepo;
    if (entity === Investment) return investmentRepo;
    throw new Error("unexpected repository");
  };
  const manager = { getRepository: jest.fn(repoFor) };
  const dataSource = {
    getRepository: jest.fn(repoFor),
    transaction: jest.fn(async (cb: (m: typeof manager) => unknown) => cb(manager)),
  };
  const now = opts.now ?? NOW;

  return {
    service: new InvoiceExtensionService(dataSource as never, undefined, () => now),
    requestRepo,
    invoiceRepo,
  };
}

const openInvoice = (overrides: Row = {}): Row => ({
  id: "inv-1",
  sellerId: "seller-1",
  status: InvoiceStatus.PUBLISHED,
  fundingDeadline: new Date("2026-06-10T00:00:00.000Z"),
  // TypeORM returns `date` columns as bare strings.
  dueDate: "2026-07-01",
  ...overrides,
});

const request = (service: InvoiceExtensionService, proposedDeadline: Date) =>
  service.requestExtension({ invoiceId: "inv-1", sellerId: "seller-1", proposedDeadline });

describe("InvoiceExtensionService (issue #477)", () => {
  it("rejects extension on funded invoices with 422", async () => {
    const { service } = makeService({ invoice: openInvoice({ status: InvoiceStatus.FUNDED }) });
    await expect(request(service, new Date("2026-06-20T00:00:00Z"))).rejects.toMatchObject({
      code: "EXTENSION_NOT_ALLOWED",
      statusCode: 422,
    });
  });

  it("rejects a second pending extension request", async () => {
    const { service, requestRepo } = makeService({
      invoice: openInvoice(),
      pending: { id: "existing", status: ExtensionRequestStatus.PENDING },
    });
    const attempt = request(service, new Date("2026-06-20T00:00:00Z"));
    await expect(attempt).rejects.toBeInstanceOf(ServiceError);
    await expect(attempt).rejects.toMatchObject({ code: "EXTENSION_PENDING", statusCode: 409 });
    expect(requestRepo.save).not.toHaveBeenCalled();
  });

  it("checks the invoice under a row lock inside a transaction (issue #734)", async () => {
    const { service, invoiceRepo } = makeService({ invoice: openInvoice() });
    await request(service, new Date("2026-06-20T00:00:00Z"));
    expect(invoiceRepo.findOne).toHaveBeenCalledWith({
      where: { id: "inv-1" },
      lock: { mode: "pessimistic_write" },
    });
  });

  it("maps a lost race on the pending-request index to 409 EXTENSION_PENDING (issue #734)", async () => {
    const violation = new QueryFailedError("INSERT ...", [], {
      code: "23505",
      constraint: PENDING_EXTENSION_UNIQUE_INDEX,
    } as never);
    const { service } = makeService({ invoice: openInvoice(), saveError: violation });
    await expect(request(service, new Date("2026-06-20T00:00:00Z"))).rejects.toMatchObject({
      code: "EXTENSION_PENDING",
      statusCode: 409,
    });
  });

  it("does not hide other unique violations behind EXTENSION_PENDING", async () => {
    const other = new QueryFailedError("INSERT ...", [], {
      code: "23505",
      constraint: "PK_invoice_extension_requests_id",
    } as never);
    const { service } = makeService({ invoice: openInvoice(), saveError: other });
    await expect(request(service, new Date("2026-06-20T00:00:00Z"))).rejects.toBe(other);
  });
});

describe("Funding extension deadline rules (issue #733)", () => {
  describe("at submission", () => {
    it("accepts a later deadline before maturity and records the previous one", async () => {
      const { service, requestRepo } = makeService({ invoice: openInvoice() });
      const proposed = new Date("2026-06-20T09:30:00.000Z");

      const row = await request(service, proposed);

      expect(row).toMatchObject({
        proposedDeadline: proposed,
        previousDeadline: new Date("2026-06-10T00:00:00.000Z"),
        status: ExtensionRequestStatus.PENDING,
      });
      expect(requestRepo.save).toHaveBeenCalledTimes(1);
    });

    it.each([
      ["earlier than", "2026-06-09T23:59:59.999Z"],
      ["equal to", "2026-06-10T00:00:00.000Z"],
    ])("rejects a proposal %s the current deadline with 422", async (_case, iso) => {
      const { service, requestRepo } = makeService({ invoice: openInvoice() });
      await expect(request(service, new Date(iso))).rejects.toMatchObject({
        code: "EXTENSION_DEADLINE_NOT_LATER",
        statusCode: 422,
        details: { currentDeadline: "2026-06-10T00:00:00.000Z" },
      });
      expect(requestRepo.save).not.toHaveBeenCalled();
    });

    it("accepts one millisecond past the current deadline", async () => {
      const { service } = makeService({ invoice: openInvoice() });
      await expect(request(service, new Date("2026-06-10T00:00:00.001Z"))).resolves.toBeDefined();
    });

    it("compares instants, so a proposal with a timezone offset is judged by its UTC time", async () => {
      // 2026-06-09T22:00:00-03:00 is 2026-06-10T01:00:00Z: later than the
      // current deadline even though its local calendar date is earlier.
      const { service } = makeService({ invoice: openInvoice() });
      await expect(request(service, new Date("2026-06-09T22:00:00-03:00"))).resolves.toBeDefined();

      // 2026-06-10T01:00:00+02:00 is 2026-06-09T23:00:00Z: earlier.
      const second = makeService({ invoice: openInvoice() });
      await expect(
        request(second.service, new Date("2026-06-10T01:00:00+02:00"))
      ).rejects.toMatchObject({ code: "EXTENSION_DEADLINE_NOT_LATER" });
    });

    it("treats date-only maturity as the end of that day in UTC, inclusive", async () => {
      const atCutoff = makeService({ invoice: openInvoice() });
      await expect(
        request(atCutoff.service, new Date("2026-07-01T23:59:59.999Z"))
      ).resolves.toBeDefined();

      const pastCutoff = makeService({ invoice: openInvoice() });
      await expect(
        request(pastCutoff.service, new Date("2026-07-02T00:00:00.000Z"))
      ).rejects.toMatchObject({
        code: "EXTENSION_BEYOND_MATURITY",
        statusCode: 422,
        details: { maturityCutoff: "2026-07-01T23:59:59.999Z" },
      });
    });

    it("applies the same cutoff when maturity is a Date at UTC midnight", async () => {
      const { service } = makeService({
        invoice: openInvoice({ dueDate: new Date("2026-07-01T00:00:00.000Z") }),
      });
      await expect(request(service, new Date("2026-07-01T18:00:00.000Z"))).resolves.toBeDefined();
    });

    it("rejects a proposal whose local date is maturity day but whose UTC instant is the next day", async () => {
      // 2026-07-01T21:00:00-05:00 is 2026-07-02T02:00:00Z.
      const { service } = makeService({ invoice: openInvoice() });
      await expect(request(service, new Date("2026-07-01T21:00:00-05:00"))).rejects.toMatchObject({
        code: "EXTENSION_BEYOND_MATURITY",
      });
    });

    it("rejects a proposal in the past with 400 INVALID_DEADLINE", async () => {
      const { service } = makeService({ invoice: openInvoice() });
      await expect(request(service, new Date("2026-06-01T11:59:59.000Z"))).rejects.toMatchObject({
        code: "INVALID_DEADLINE",
        statusCode: 400,
      });
    });

    it("rejects an invalid date with 400 before touching the database", async () => {
      const { service, invoiceRepo } = makeService({ invoice: openInvoice() });
      await expect(request(service, new Date("not a date"))).rejects.toMatchObject({
        code: "INVALID_DEADLINE",
        statusCode: 400,
      });
      expect(invoiceRepo.findOne).not.toHaveBeenCalled();
    });

    describe("null legacy deadline", () => {
      it("treats the deadline as now: any future proposal within maturity is accepted", async () => {
        const { service } = makeService({ invoice: openInvoice({ fundingDeadline: null }) });
        const row = await request(service, new Date("2026-06-01T12:00:01.000Z"));
        expect(row).toMatchObject({ previousDeadline: null });
      });

      it("still rejects past proposals and proposals beyond maturity", async () => {
        const past = makeService({ invoice: openInvoice({ fundingDeadline: null }) });
        await expect(request(past.service, NOW)).rejects.toMatchObject({
          code: "INVALID_DEADLINE",
        });

        const late = makeService({ invoice: openInvoice({ fundingDeadline: null }) });
        await expect(request(late.service, new Date("2026-07-05T00:00:00Z"))).rejects.toMatchObject(
          { code: "EXTENSION_BEYOND_MATURITY" }
        );
      });
    });

    it("lets an already-expired window be reopened up to maturity", async () => {
      const { service } = makeService({
        invoice: openInvoice({ fundingDeadline: new Date("2026-05-20T00:00:00.000Z") }),
      });
      await expect(request(service, new Date("2026-06-15T00:00:00Z"))).resolves.toBeDefined();
    });
  });

  describe("at approval", () => {
    const pendingRequest = (overrides: Row = {}): Row => ({
      id: "req-1",
      invoiceId: "inv-1",
      status: ExtensionRequestStatus.PENDING,
      proposedDeadline: new Date("2026-06-20T00:00:00.000Z"),
      previousDeadline: new Date("2026-06-10T00:00:00.000Z"),
      ...overrides,
    });

    const approve = (service: InvoiceExtensionService) =>
      service.reviewExtension({
        invoiceId: "inv-1",
        requestId: "req-1",
        decision: "approve",
        reviewedBy: "GADMIN",
      });

    it("applies a still-valid proposal", async () => {
      const { service, invoiceRepo } = makeService({
        invoice: openInvoice(),
        request: pendingRequest(),
      });
      const { request: saved, invoice } = await approve(service);
      expect(saved.status).toBe(ExtensionRequestStatus.APPROVED);
      expect(invoice!.fundingDeadline).toEqual(new Date("2026-06-20T00:00:00.000Z"));
      expect(invoiceRepo.save).toHaveBeenCalledTimes(1);
    });

    it("rejects a proposal that expired while awaiting review, without changing the invoice", async () => {
      const { service, invoiceRepo, requestRepo } = makeService({
        invoice: openInvoice(),
        request: pendingRequest(),
        now: new Date("2026-06-20T00:00:00.000Z"),
      });
      await expect(approve(service)).rejects.toMatchObject({
        code: "EXTENSION_EXPIRED",
        statusCode: 409,
      });
      expect(invoiceRepo.save).not.toHaveBeenCalled();
      expect(requestRepo.save).not.toHaveBeenCalled();
    });

    it("rejects a proposal beyond maturity (e.g. one created before this rule existed)", async () => {
      const { service, invoiceRepo } = makeService({
        invoice: openInvoice(),
        request: pendingRequest({ proposedDeadline: new Date("2026-07-02T00:00:00.000Z") }),
      });
      await expect(approve(service)).rejects.toMatchObject({
        code: "EXTENSION_BEYOND_MATURITY",
        statusCode: 422,
      });
      expect(invoiceRepo.save).not.toHaveBeenCalled();
    });

    it("rejects a proposal that is no longer later than the invoice's current deadline", async () => {
      // The deadline moved past the proposal while it waited.
      const { service } = makeService({
        invoice: openInvoice({ fundingDeadline: new Date("2026-06-25T00:00:00.000Z") }),
        request: pendingRequest(),
      });
      await expect(approve(service)).rejects.toMatchObject({
        code: "EXTENSION_DEADLINE_NOT_LATER",
        statusCode: 422,
      });
    });

    it("still allows rejecting a stale proposal so the seller can submit a new one", async () => {
      const { service } = makeService({
        invoice: openInvoice(),
        request: pendingRequest(),
        now: new Date("2026-06-21T00:00:00.000Z"),
      });
      const { request: saved } = await service.reviewExtension({
        invoiceId: "inv-1",
        requestId: "req-1",
        decision: "reject",
        reviewedBy: "GADMIN",
      });
      expect(saved.status).toBe(ExtensionRequestStatus.REJECTED);
    });

    it("locks the request row so concurrent reviews cannot both act", async () => {
      const { service, requestRepo } = makeService({
        invoice: openInvoice(),
        request: pendingRequest(),
      });
      await approve(service);
      expect(requestRepo.findOne).toHaveBeenCalledWith({
        where: { id: "req-1", invoiceId: "inv-1" },
        lock: { mode: "pessimistic_write" },
      });
    });
  });
});

describe("validateProposedDeadline", () => {
  it("is the same rule set the service applies", () => {
    expect(() =>
      validateProposedDeadline(
        { fundingDeadline: null, dueDate: "2026-07-01" as unknown as Date },
        new Date("2026-07-01T23:59:59.999Z"),
        NOW
      )
    ).not.toThrow();
  });

  it("rejects an invoice with no maturity date", () => {
    expect(() =>
      validateProposedDeadline(
        { fundingDeadline: null, dueDate: null as unknown as Date },
        new Date("2026-06-05T00:00:00Z"),
        NOW
      )
    ).toThrow(expect.objectContaining({ code: "EXTENSION_BEYOND_MATURITY" }));
  });
});
