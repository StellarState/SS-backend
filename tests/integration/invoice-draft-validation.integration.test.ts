import crypto from "crypto";
import { DataSource } from "typeorm";
import { InvoiceDraftService } from "../../src/services/invoice-draft.service";
import { InvoiceDraft } from "../../src/models/InvoiceDraft.model";
import { createTestDataSource } from "../helpers/test-data-source";
import { ServiceError } from "../../src/utils/service-error";
import {
  validateDraftPayload,
  UNKNOWN_FIELDS_POLICY,
  MAX_DRAFT_TEXT_LENGTH,
  MAX_DRAFT_KEY_COUNT,
  MAX_DRAFT_NESTING_DEPTH,
} from "../../src/lib/invoice-draft-validation";

describe("Invoice draft partial schema and structural validation (issue #730)", () => {
  let dataSource: DataSource;
  let service: InvoiceDraftService;

  const sellerId = `seller_${crypto.randomUUID()}`;
  const sellerWallet = "GBTESTWALLETSELLERAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

  beforeAll(async () => {
    dataSource = await createTestDataSource();
    await dataSource.synchronize(true);
    service = new InvoiceDraftService(dataSource);
  });

  afterAll(async () => {
    await dataSource.destroy();
  });

  beforeEach(async () => {
    await dataSource.getRepository(InvoiceDraft).clear();
  });

  describe("Acceptance Criteria 1: Empty or incomplete valid forms remain saveable and resumable", () => {
    it("allows saving an empty draft payload and resuming it", async () => {
      const draft = await service.saveDraft(sellerId, sellerWallet, null, {});
      expect(draft.id).toBeDefined();

      const resumed = await service.getDraft(draft.id, sellerId);
      expect(resumed.id).toBe(draft.id);
      expect(resumed.revision).toBe(1);
    });

    it("allows saving a partially filled draft without requiring publish-ready data", async () => {
      const partialData = {
        title: "Work in Progress Invoice",
        amount: "1500.50",
      };

      const draft = await service.saveDraft(sellerId, sellerWallet, null, partialData);
      expect(draft.id).toBeDefined();

      const resumed = await service.getDraft(draft.id, sellerId);
      expect(resumed.title).toBe("Work in Progress Invoice");
      expect(resumed.amount).toBe("1500.50");
      expect(resumed.customerName).toBeUndefined();
      expect(resumed.dueDate).toBeUndefined();
    });

    it("allows null or empty strings for incomplete form fields", async () => {
      const partialData = {
        invoiceNumber: "",
        customerName: null,
        description: "",
      };

      const draft = await service.saveDraft(sellerId, sellerWallet, null, partialData as any);
      const resumed = await service.getDraft(draft.id, sellerId);
      expect(resumed.invoiceNumber).toBe("");
      expect(resumed.customerName).toBeNull();
      expect(resumed.description).toBe("");
    });
  });

  describe("Acceptance Criteria 2: Objects and arrays in known scalar fields return 400 before persistence", () => {
    it("rejects an array in amount with 400 and field-specific error", async () => {
      let error: ServiceError | undefined;
      try {
        await service.saveDraft(sellerId, sellerWallet, null, {
          title: "Invalid Amount Array",
          amount: ["1000"] as any,
        });
      } catch (err) {
        if (err instanceof ServiceError) error = err;
      }

      expect(error).toBeDefined();
      expect(error?.statusCode).toBe(400);
      expect(error?.code).toBe("INVALID_DRAFT_DATA");
      expect(error?.details).toMatchObject({
        fieldErrors: expect.objectContaining({
          amount: expect.stringContaining("amount must be a scalar value"),
        }),
      });

      // Verify nothing was persisted
      const allDrafts = await service.listDrafts(sellerId);
      expect(allDrafts).toHaveLength(0);
    });

    it("rejects an object in amount with 400 before persistence", async () => {
      await expect(
        service.saveDraft(sellerId, sellerWallet, null, {
          amount: { value: 1000, currency: "USD" } as any,
        })
      ).rejects.toMatchObject({
        statusCode: 400,
        code: "INVALID_DRAFT_DATA",
      });

      const allDrafts = await service.listDrafts(sellerId);
      expect(allDrafts).toHaveLength(0);
    });

    it("rejects an object in title with 400 before persistence", async () => {
      await expect(
        service.saveDraft(sellerId, sellerWallet, null, {
          title: { en: "Invoice Title" } as any,
        })
      ).rejects.toMatchObject({
        statusCode: 400,
        code: "INVALID_DRAFT_DATA",
      });
    });

    it("rejects an array in dueDate with 400 before persistence", async () => {
      await expect(
        service.saveDraft(sellerId, sellerWallet, null, {
          dueDate: ["2026-12-31"] as any,
        })
      ).rejects.toMatchObject({
        statusCode: 400,
        code: "INVALID_DRAFT_DATA",
      });
    });

    it("rejects a boolean in a known scalar field", async () => {
      await expect(
        service.saveDraft(sellerId, sellerWallet, null, {
          customerName: true as any,
        })
      ).rejects.toMatchObject({
        statusCode: 400,
        code: "INVALID_DRAFT_DATA",
      });
    });
  });

  describe("Acceptance Criteria 3: yieldBps accepts its documented integer form and rejects incompatible types", () => {
    it("accepts documented integer number form for yieldBps", async () => {
      const draft = await service.saveDraft(sellerId, sellerWallet, null, {
        title: "Valid Yield",
        yieldBps: 750,
      });

      const resumed = await service.getDraft(draft.id, sellerId);
      expect(resumed.yieldBps).toBe(750);
    });

    it("accepts zero as a valid integer yieldBps", async () => {
      const draft = await service.saveDraft(sellerId, sellerWallet, null, {
        yieldBps: 0,
      });

      const resumed = await service.getDraft(draft.id, sellerId);
      expect(resumed.yieldBps).toBe(0);
    });

    it("accepts and normalizes a clean integer string for yieldBps", async () => {
      const draft = await service.saveDraft(sellerId, sellerWallet, null, {
        yieldBps: "500" as any,
      });

      const resumed = await service.getDraft(draft.id, sellerId);
      expect(resumed.yieldBps).toBe(500);
    });

    it("rejects float numbers for yieldBps with 400", async () => {
      await expect(
        service.saveDraft(sellerId, sellerWallet, null, {
          yieldBps: 750.5 as any,
        })
      ).rejects.toMatchObject({
        statusCode: 400,
        code: "INVALID_DRAFT_DATA",
      });
    });

    it("rejects non-integer strings for yieldBps with 400", async () => {
      await expect(
        service.saveDraft(sellerId, sellerWallet, null, {
          yieldBps: "750.5" as any,
        })
      ).rejects.toMatchObject({
        statusCode: 400,
        code: "INVALID_DRAFT_DATA",
      });

      await expect(
        service.saveDraft(sellerId, sellerWallet, null, {
          yieldBps: "high" as any,
        })
      ).rejects.toMatchObject({
        statusCode: 400,
        code: "INVALID_DRAFT_DATA",
      });
    });

    it("rejects objects and arrays for yieldBps with 400", async () => {
      await expect(
        service.saveDraft(sellerId, sellerWallet, null, {
          yieldBps: { bps: 500 } as any,
        })
      ).rejects.toMatchObject({
        statusCode: 400,
        code: "INVALID_DRAFT_DATA",
      });

      await expect(
        service.saveDraft(sellerId, sellerWallet, null, {
          yieldBps: [500] as any,
        })
      ).rejects.toMatchObject({
        statusCode: 400,
        code: "INVALID_DRAFT_DATA",
      });
    });

    it("rejects booleans for yieldBps with 400", async () => {
      await expect(
        service.saveDraft(sellerId, sellerWallet, null, {
          yieldBps: true as any,
        })
      ).rejects.toMatchObject({
        statusCode: 400,
        code: "INVALID_DRAFT_DATA",
      });
    });
  });

  describe("Acceptance Criteria 4: Unknown form keys follow one documented preserve-or-reject policy", () => {
    it("documents UNKNOWN_FIELDS_POLICY as PRESERVE", () => {
      expect(UNKNOWN_FIELDS_POLICY).toBe("PRESERVE");
    });

    it("preserves unknown extension fields in draftData and returns them on resume", async () => {
      const payload = {
        title: "Extended Form Draft",
        amount: "5000",
        customCategory: "Logistics",
        internalReference: "REF-9988",
        issuerMetadata: {
          stepCompleted: 2,
          department: "Accounts Payable",
        },
      };

      const draft = await service.saveDraft(sellerId, sellerWallet, null, payload);
      const resumed = await service.getDraft(draft.id, sellerId);

      expect(resumed.title).toBe("Extended Form Draft");
      expect(resumed.amount).toBe("5000");
      expect(resumed.customCategory).toBe("Logistics");
      expect(resumed.internalReference).toBe("REF-9988");
      expect(resumed.issuerMetadata).toEqual({
        stepCompleted: 2,
        department: "Accounts Payable",
      });
    });
  });

  describe("Acceptance Criteria 5: Payload and text limits bound nested form state", () => {
    it("rejects payloads exceeding the maximum text length limit", async () => {
      const oversizedText = "A".repeat(MAX_DRAFT_TEXT_LENGTH + 1);

      await expect(
        service.saveDraft(sellerId, sellerWallet, null, {
          title: oversizedText,
        })
      ).rejects.toMatchObject({
        statusCode: 400,
        code: "INVALID_DRAFT_DATA",
      });
    });

    it("rejects extension fields exceeding maximum nesting depth", async () => {
      const deeplyNested = {
        level1: {
          level2: {
            level3: {
              level4: "Too deep",
            },
          },
        },
      };

      await expect(
        service.saveDraft(sellerId, sellerWallet, null, {
          title: "Deeply Nested Test",
          extensionData: deeplyNested,
        })
      ).rejects.toMatchObject({
        statusCode: 400,
        code: "INVALID_DRAFT_DATA",
      });
    });

    it("rejects payloads that are not plain objects (arrays or primitives)", async () => {
      await expect(
        service.saveDraft(sellerId, sellerWallet, null, ["item1", "item2"] as any)
      ).rejects.toMatchObject({
        statusCode: 400,
        code: "INVALID_DRAFT_DATA",
      });

      await expect(
        service.saveDraft(sellerId, sellerWallet, null, "plain string" as any)
      ).rejects.toMatchObject({
        statusCode: 400,
        code: "INVALID_DRAFT_DATA",
      });
    });
  });

  describe("Acceptance Criteria 6: Preservation of previously saved version after rejection", () => {
    it("preserves the original saved document intact after an invalid update is rejected", async () => {
      // 1. Initial valid save
      const initial = await service.saveDraft(sellerId, sellerWallet, null, {
        title: "Original Pristine Title",
        amount: "2500.0000",
        customerName: "Acme Corp",
      });
      const initialSavedAt = initial.lastSavedAt;

      // 2. Stale or invalid update attempt with malformed shape
      await expect(
        service.saveDraft(sellerId, sellerWallet, initial.id, {
          title: "Poisoned Title",
          amount: { invalidNested: "malformed" } as any,
        })
      ).rejects.toMatchObject({
        statusCode: 400,
        code: "INVALID_DRAFT_DATA",
      });

      // 3. Confirm the previously saved version is completely unchanged
      const persisted = await service.getDraft(initial.id, sellerId);
      expect(persisted.title).toBe("Original Pristine Title");
      expect(persisted.amount).toBe("2500.0000");
      expect(persisted.customerName).toBe("Acme Corp");
      expect(new Date(persisted.lastSavedAt).getTime()).toBe(new Date(initialSavedAt).getTime());
    });
  });
});
