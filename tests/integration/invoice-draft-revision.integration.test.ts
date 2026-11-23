import crypto from "crypto";
import { DataSource } from "typeorm";
import { InvoiceDraftService } from "../../src/services/invoice-draft.service";
import { InvoiceDraft } from "../../src/models/InvoiceDraft.model";
import { createTestDataSource } from "../helpers/test-data-source";
import { ServiceError } from "../../src/utils/service-error";

describe("Invoice draft revision and autosave preconditions (issue #729)", () => {
  let dataSource: DataSource;
  let service: InvoiceDraftService;

  const sellerA = `seller_${crypto.randomUUID()}`;
  const walletA = "GBTESTWALLETSELLERAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
  const sellerB = `seller_${crypto.randomUUID()}`;
  const walletB = "GBTESTWALLETSELLERBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";

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

  it("first save creates revision 1 and resume returns that revision", async () => {
    const draft = await service.saveDraft(sellerA, walletA, null, {
      invoiceNumber: "INV-2026-001",
      customerName: "Acme Corporation",
      amount: "5000.0000",
      title: "Initial Draft Title",
    });

    expect(draft.id).toBeDefined();
    expect(draft.revision).toBe(1);
    expect(draft.lastSavedAt).toBeInstanceOf(Date);
    expect(draft.expiresAt).toBeInstanceOf(Date);

    // Resume the draft and verify revision is returned
    const resumed = await service.getDraft(draft.id, sellerA);
    expect(resumed.id).toBe(draft.id);
    expect(resumed.revision).toBe(1);
    expect(resumed.invoiceNumber).toBe("INV-2026-001");
    expect(resumed.customerName).toBe("Acme Corporation");
    expect(resumed.amount).toBe("5000.0000");
  });

  it("two writes against the same revision produce one replacement and one 409 conflict", async () => {
    const initial = await service.saveDraft(sellerA, walletA, null, {
      invoiceNumber: "INV-2026-002",
      title: "Tab 1 Base",
    });
    expect(initial.revision).toBe(1);

    // Tab 1 updates with revision precondition 1
    const tab1Update = await service.saveDraft(
      sellerA,
      walletA,
      initial.id,
      {
        invoiceNumber: "INV-2026-002",
        title: "Tab 1 Changes",
      },
      1
    );
    expect(tab1Update.revision).toBe(2);

    // Tab 2 attempts to save with stale revision precondition 1
    let conflictError: ServiceError | undefined;
    try {
      await service.saveDraft(
        sellerA,
        walletA,
        initial.id,
        {
          invoiceNumber: "INV-2026-002",
          title: "Tab 2 Stale Changes",
        },
        1
      );
    } catch (err) {
      if (err instanceof ServiceError) conflictError = err;
    }

    expect(conflictError).toBeDefined();
    expect(conflictError?.statusCode).toBe(409);
    expect(conflictError?.code).toBe("REVISION_CONFLICT");
    expect(conflictError?.details).toMatchObject({
      currentRevision: 2,
      revision: 2,
    });
  });

  it("a delayed stale save preserves the newer document and lastSavedAt", async () => {
    const initial = await service.saveDraft(sellerA, walletA, null, {
      invoiceNumber: "INV-2026-003",
      title: "Version 1",
    });

    // Valid update advances to revision 2
    const firstUpdate = await service.saveDraft(
      sellerA,
      walletA,
      initial.id,
      {
        invoiceNumber: "INV-2026-003",
        title: "Newer Document Written by Faster Tab",
      },
      1
    );
    const newerSavedAt = firstUpdate.lastSavedAt;

    // Delayed stale save arrives with revision 1
    await expect(
      service.saveDraft(
        sellerA,
        walletA,
        initial.id,
        {
          invoiceNumber: "INV-2026-003",
          title: "Stale Overwrite Attempt",
        },
        1
      )
    ).rejects.toMatchObject({
      code: "REVISION_CONFLICT",
      statusCode: 409,
    });

    // Confirm newer document and lastSavedAt are preserved intact
    const resumed = await service.getDraft(initial.id, sellerA);
    expect(resumed.title).toBe("Newer Document Written by Faster Tab");
    expect(resumed.revision).toBe(2);
    expect(new Date(resumed.lastSavedAt).getTime()).toBe(new Date(newerSavedAt).getTime());
  });

  it("successful updates advance one revision and renew inactivity expiry", async () => {
    const draft = await service.saveDraft(sellerA, walletA, null, {
      invoiceNumber: "INV-2026-004",
      title: "Step 1",
    });
    expect(draft.revision).toBe(1);

    const update1 = await service.saveDraft(
      sellerA,
      walletA,
      draft.id,
      { invoiceNumber: "INV-2026-004", title: "Step 2" },
      1
    );
    expect(update1.revision).toBe(2);

    const update2 = await service.saveDraft(
      sellerA,
      walletA,
      draft.id,
      { invoiceNumber: "INV-2026-004", title: "Step 3" },
      2
    );
    expect(update2.revision).toBe(3);
    expect(update2.expiresAt.getTime()).toBeGreaterThan(Date.now() + 29 * 24 * 60 * 60 * 1000);
  });

  it("ownership checks remain effective when another seller supplies a revision", async () => {
    const draft = await service.saveDraft(sellerA, walletA, null, {
      invoiceNumber: "INV-2026-005",
      title: "Seller A Draft",
    });

    // Seller B attempts to overwrite with valid revision 1
    await expect(
      service.saveDraft(
        sellerB,
        walletB,
        draft.id,
        { invoiceNumber: "INV-2026-005", title: "Hacked by Seller B" },
        1
      )
    ).rejects.toMatchObject({
      code: "FORBIDDEN",
      statusCode: 403,
    });

    // Verify document was not modified
    const current = await service.getDraft(draft.id, sellerA);
    expect(current.title).toBe("Seller A Draft");
    expect(current.revision).toBe(1);
  });

  it("requires a revision precondition when updating an existing draft", async () => {
    const draft = await service.saveDraft(sellerA, walletA, null, {
      invoiceNumber: "INV-2026-006",
      title: "Initial Draft",
    });

    // Attempting update without supplying expectedRevision
    await expect(
      service.saveDraft(sellerA, walletA, draft.id, {
        invoiceNumber: "INV-2026-006",
        title: "Update Without Revision",
      })
    ).rejects.toMatchObject({
      code: "REVISION_REQUIRED",
      statusCode: 400,
    });
  });

  it("database integration tests race two saves and assert the final JSON document", async () => {
    const draft = await service.saveDraft(sellerA, walletA, null, {
      invoiceNumber: "INV-2026-007",
      title: "Initial State",
      amount: "1000.0000",
    });
    expect(draft.revision).toBe(1);

    // Race two concurrent saveDraft operations against revision 1
    const [resultA, resultB] = await Promise.allSettled([
      service.saveDraft(
        sellerA,
        walletA,
        draft.id,
        {
          invoiceNumber: "INV-2026-007",
          title: "Title Winner A",
          amount: "2000.0000",
        },
        1
      ),
      service.saveDraft(
        sellerA,
        walletA,
        draft.id,
        {
          invoiceNumber: "INV-2026-007",
          title: "Title Winner B",
          amount: "3000.0000",
        },
        1
      ),
    ]);

    const successes = [resultA, resultB].filter((r) => r.status === "fulfilled");
    const failures = [resultA, resultB].filter((r) => r.status === "rejected");

    // Exactly one write succeeds, exactly one is rejected with 409 conflict
    expect(successes).toHaveLength(1);
    expect(failures).toHaveLength(1);

    const winnerPromiseResult = successes[0] as PromiseFulfilledResult<InvoiceDraft>;
    const loserPromiseResult = failures[0] as PromiseRejectedResult;

    expect(winnerPromiseResult.value.revision).toBe(2);
    expect(loserPromiseResult.reason).toBeInstanceOf(ServiceError);
    expect(loserPromiseResult.reason.statusCode).toBe(409);
    expect(loserPromiseResult.reason.code).toBe("REVISION_CONFLICT");

    // Assert final JSON document in database matches the winning save exactly
    const finalDoc = await service.getDraft(draft.id, sellerA);
    expect(finalDoc.revision).toBe(2);
    expect(finalDoc.title).toBe(winnerPromiseResult.value.draftData.title);
    expect(finalDoc.amount).toBe(winnerPromiseResult.value.draftData.amount);
  });
});
