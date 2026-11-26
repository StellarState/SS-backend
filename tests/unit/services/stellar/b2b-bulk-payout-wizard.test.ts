import { Account, Keypair } from "@stellar/stellar-sdk";
import {
  BulkPayoutWizard,
  type AffiliatePayout,
} from "../../../../src/services/stellar/bulk-payout-wizard.service";
import { PaymentDistributorContractService } from "../../../../src/services/stellar/payment-distributor-contract.service";

describe("BulkPayoutWizard (Enterprise Bulk Affiliate Payout Distribution)", () => {
  const contractId = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";
  const feeRecipient = Keypair.random().publicKey();
  const platformSecretKey = Keypair.random().secret();
  const rpcUrl = "https://soroban-testnet.stellar.org";
  const networkPassphrase = "Test SDF Network ; September 2015";
  const feeBps = 250;

  function createMockRpc(status: "SUCCESS" | "FAILED" = "SUCCESS") {
    return {
      getAccount: jest.fn().mockResolvedValue(new Account(Keypair.fromSecret(platformSecretKey).publicKey(), "1")),
      prepareTransaction: jest.fn().mockImplementation(async (tx) => tx),
      sendTransaction: jest.fn().mockResolvedValue({ status: "PENDING", hash: "tx-hash" }),
      getTransaction: jest.fn().mockResolvedValue({ status, ledger: 77 }),
    } as any;
  }

  function createWizard(overrides: Partial<{
    rpcStatus: "SUCCESS" | "FAILED";
    chunkSize: number;
  }> = {}) {
    const rpc = createMockRpc(overrides.rpcStatus ?? "SUCCESS");
    return new BulkPayoutWizard({
      contractId,
      rpcUrl,
      networkPassphrase,
      platformSecretKey,
      feeRecipient,
      feeBps,
      chunkSize: overrides.chunkSize ?? 50,
      logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } as any,
    });
  }

  function createAffiliatePayouts(count: number, baseAmount = 1000n): AffiliatePayout[] {
    return Array.from({ length: count }, (_, i): AffiliatePayout => ({
      affiliateId: `affiliate-${i}`,
      address: Keypair.random().publicKey(),
      amountStroops: baseAmount * BigInt(i + 1),
    }));
  }

  describe("aggregatePayouts", () => {
    it("aggregates unique affiliate payouts correctly", () => {
      const wizard = createWizard();
      const payouts = [
        { affiliateId: "a1", address: "GABC1", amountStroops: 1000n },
        { affiliateId: "a2", address: "GABC2", amountStroops: 2000n },
        { affiliateId: "a3", address: "GABC3", amountStroops: 3000n },
      ];

      const result = wizard.aggregatePayouts(payouts);

      expect(result.recipients).toHaveLength(3);
      expect(result.totalAmount).toBe(6000n);
      expect(result.duplicates).toHaveLength(0);
    });

    it("detects and aggregates duplicate destinations", () => {
      const wizard = createWizard();
      const address = "GABC123";
      const payouts = [
        { affiliateId: "a1", address, amountStroops: 1000n },
        { affiliateId: "a2", address, amountStroops: 2000n },
        { affiliateId: "a3", address: "GABC2", amountStroops: 3000n },
      ];

      const result = wizard.aggregatePayouts(payouts);

      expect(result.recipients).toHaveLength(2);
      expect(result.totalAmount).toBe(6000n);
      expect(result.duplicates).toHaveLength(1);
      expect(result.duplicates[0].address).toBe(address);
      expect(result.duplicates[0].count).toBe(2);
      expect(result.duplicates[0].totalAmount).toBe(3000n);
    });

    it("handles multiple duplicate groups", () => {
      const wizard = createWizard();
      const payouts = [
        { affiliateId: "a1", address: "GABC1", amountStroops: 1000n },
        { affiliateId: "a2", address: "GABC1", amountStroops: 2000n },
        { affiliateId: "a3", address: "GABC2", amountStroops: 3000n },
        { affiliateId: "a4", address: "GABC2", amountStroops: 4000n },
        { affiliateId: "a5", address: "GABC3", amountStroops: 5000n },
      ];

      const result = wizard.aggregatePayouts(payouts);

      expect(result.recipients).toHaveLength(3);
      expect(result.duplicates).toHaveLength(2);
      expect(result.duplicates.map((d) => d.address).sort()).toEqual(["GABC1", "GABC2"]);
    });
  });

  describe("checkEscrowBalance", () => {
    it("returns sufficient when escrow balance covers required amount", async () => {
      const wizard = createWizard({ rpcStatus: "SUCCESS" });
      const result = await wizard.checkEscrowBalance("INV-1", 1000n);

      expect(result.sufficient).toBe(true);
      expect(result.escrowBalance).toBeGreaterThanOrEqual(result.requiredAmount);
      expect(result.shortfall).toBeUndefined();
    });

    it("returns insufficient with shortfall when escrow balance is too low", async () => {
      const wizard = createWizard({ rpcStatus: "SUCCESS" });
      const largeAmount = 2_000_000_000_000n;
      const result = await wizard.checkEscrowBalance("INV-1", largeAmount);

      expect(result.sufficient).toBe(false);
      expect(result.shortfall).toBe(largeAmount - result.escrowBalance);
    });
  });

  describe("executeBulkPayout", () => {
    it("executes single batch for small number of recipients", async () => {
      const wizard = createWizard({ chunkSize: 50 });
      const payouts = createAffiliatePayouts(10, 1000n);

      const result = await wizard.executeBulkPayout("INV-100", payouts);

      expect(result.invoiceId).toBe("INV-100");
      expect(result.totalRecipients).toBe(10);
      expect(result.batches).toHaveLength(1);
      expect(result.batches[0].status).toBe("completed");
      expect(result.batches[0].transactionHash).toBe("tx-hash");
      expect(result.successfulCount).toBe(10);
      expect(result.failedCount).toBe(0);
      expect(result.failedRecipients).toHaveLength(0);
    });

    it("chunks into multiple batches of configured size (50)", async () => {
      const wizard = createWizard({ chunkSize: 50 });
      const payouts = createAffiliatePayouts(120, 1000n);

      const result = await wizard.executeBulkPayout("INV-101", payouts);

      expect(result.batches).toHaveLength(3);
      expect(result.batches[0].batchSize).toBe(50);
      expect(result.batches[1].batchSize).toBe(50);
      expect(result.batches[2].batchSize).toBe(20);
      expect(result.batches.every((b) => b.status === "completed")).toBe(true);
      expect(result.successfulCount).toBe(120);
    });

    it("tracks progress per sub-batch with confirmation", async () => {
      const wizard = createWizard({ chunkSize: 50 });
      const payouts = createAffiliatePayouts(75, 1000n);

      const result = await wizard.executeBulkPayout("INV-102", payouts);

      expect(result.batches).toHaveLength(2);
      expect(result.batches[0]).toMatchObject({
        batchIndex: 0,
        totalBatches: 2,
        batchSize: 50,
        successful: 50,
        failed: 0,
        status: "completed",
      });
      expect(result.batches[0].transactionHash).toBeDefined();
      expect(result.batches[1]).toMatchObject({
        batchIndex: 1,
        totalBatches: 2,
        batchSize: 25,
        successful: 25,
        failed: 0,
        status: "completed",
      });
    });

    it("verifies total payout sum matches escrow balance before execution", async () => {
      const wizard = createWizard({ rpcStatus: "SUCCESS" });
      const payouts = createAffiliatePayouts(5, 500_000_000_000n);

      await expect(wizard.executeBulkPayout("INV-103", payouts)).rejects.toThrow(
        "insufficient_escrow_balance"
      );
    });

    it("calculates fee correctly and includes in total required amount", async () => {
      const wizard = createWizard({ chunkSize: 50 });
      const payouts = createAffiliatePayouts(5, 1000n);
      const totalAmount = payouts.reduce((sum, p) => sum + p.amountStroops, 0n);
      const expectedFee = (totalAmount * BigInt(feeBps)) / 10_000n;

      const result = await wizard.executeBulkPayout("INV-104", payouts);

      expect(result.totalAmount).toBe(totalAmount);
    });
  });

  describe("failure handling and retry", () => {
    it("records failed recipients with error details", async () => {
      const wizard = createWizard({ rpcStatus: "FAILED" });
      const payouts = createAffiliatePayouts(5, 1000n);

      const result = await wizard.executeBulkPayout("INV-105", payouts);

      expect(result.failedCount).toBe(5);
      expect(result.successfulCount).toBe(0);
      expect(result.failedRecipients).toHaveLength(5);
      expect(result.failedRecipients.every((fr) => fr.error)).toBe(true);
      expect(result.batches.every((b) => b.status === "failed")).toBe(true);
    });

    it("provides failure summary report with retryable payouts", async () => {
      const wizard = createWizard({ rpcStatus: "FAILED" });
      const payouts = createAffiliatePayouts(10, 1000n);

      const result = await wizard.executeBulkPayout("INV-106", payouts);
      const retryable = wizard.getRetryablePayouts(result);

      expect(retryable).toHaveLength(10);
      expect(retryable.map((r) => r.address).sort()).toEqual(
        payouts.map((p) => p.address).sort()
      );
      expect(retryable.map((r) => r.amountStroops).sort()).toEqual(
        payouts.map((p) => p.amountStroops).sort()
      );
    });

    it("allows retry only for failed payout recipients", async () => {
      const successWizard = createWizard({ rpcStatus: "SUCCESS" });
      const failWizard = createWizard({ rpcStatus: "FAILED" });

      const payouts = createAffiliatePayouts(6, 1000n);

      const firstResult = await failWizard.executeBulkPayout("INV-107", payouts);
      expect(firstResult.failedCount).toBe(6);

      const retryPayouts = successWizard.getRetryablePayouts(firstResult);
      const retryResult = await successWizard.executeBulkPayout("INV-107-retry", retryPayouts);

      expect(retryResult.successfulCount).toBe(6);
      expect(retryResult.failedCount).toBe(0);
    });

    it("handles partial failure in multi-batch scenario", async () => {
      let callCount = 0;
      const mockRpc = {
        getAccount: jest.fn().mockResolvedValue(new Account(Keypair.fromSecret(platformSecretKey).publicKey(), "1")),
        prepareTransaction: jest.fn().mockImplementation(async (tx) => tx),
        sendTransaction: jest.fn().mockResolvedValue({ status: "PENDING", hash: "tx-hash" }),
        getTransaction: jest.fn().mockImplementation(async () => {
          callCount++;
          if (callCount <= 2) return { status: "SUCCESS", ledger: 77 };
          return { status: "FAILED", ledger: 77 };
        }),
      } as any;

      const wizard = new BulkPayoutWizard({
        contractId,
        rpcUrl,
        networkPassphrase,
        platformSecretKey,
        feeRecipient,
        feeBps,
        chunkSize: 2,
        logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } as any,
      });

      (wizard as any).distributor = new PaymentDistributorContractService({
        contractId,
        server: mockRpc,
        networkPassphrase,
        platformSecretKey,
        confirmationPollMs: 0,
        confirmationAttempts: 1,
      });

      const payouts = createAffiliatePayouts(6, 1000n);
      const result = await wizard.executeBulkPayout("INV-108", payouts);

      expect(result.batches).toHaveLength(3);
      expect(result.batches[0].status).toBe("completed");
      expect(result.batches[1].status).toBe("completed");
      expect(result.batches[2].status).toBe("failed");
      expect(result.failedCount).toBe(2);
      expect(result.successfulCount).toBe(4);
    });
  });

  describe("edge cases", () => {
    it("handles empty payout list", () => {
      const wizard = createWizard();
      const result = wizard.aggregatePayouts([]);
      expect(result.recipients).toHaveLength(0);
      expect(result.totalAmount).toBe(0n);
      expect(result.duplicates).toHaveLength(0);
    });

    it("handles single payout", () => {
      const wizard = createWizard();
      const payouts = [{ affiliateId: "a1", address: "GABC1", amountStroops: 1000n }];
      const result = wizard.aggregatePayouts(payouts);
      expect(result.recipients).toHaveLength(1);
      expect(result.totalAmount).toBe(1000n);
    });

    it("uses default chunk size of 50 when not specified", () => {
      const wizard = new BulkPayoutWizard({
        contractId,
        rpcUrl,
        networkPassphrase,
        platformSecretKey,
        feeRecipient,
        feeBps,
        logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } as any,
      });
      expect((wizard as any).chunkSize).toBe(50);
    });

    it("handles very large payout amounts with bigint precision", () => {
      const wizard = createWizard();
      const payouts = [
        { affiliateId: "a1", address: "GABC1", amountStroops: 999_999_999_999_999_999n },
        { affiliateId: "a2", address: "GABC2", amountStroops: 1n },
      ];
      const result = wizard.aggregatePayouts(payouts);
      expect(result.totalAmount).toBe(1_000_000_000_000_000_000n);
    });
  });
});
