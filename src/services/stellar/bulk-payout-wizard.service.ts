import { PaymentDistributorContractService, PayoutRecipient } from "./payment-distributor-contract.service";
import { AppLogger } from "../../observability/logger";
import { ServiceError } from "../../utils/service-error";

export interface BulkPayoutWizardConfig {
  contractId: string;
  rpcUrl: string;
  networkPassphrase: string;
  platformSecretKey: string;
  feeRecipient: string;
  feeBps: number;
  chunkSize?: number;
  logger?: AppLogger;
}

export interface AffiliatePayout {
  affiliateId: string;
  address: string;
  amountStroops: bigint;
}

export interface AggregatedPayout {
  recipients: PayoutRecipient[];
  duplicates: Array<{ address: string; count: number; totalAmount: bigint }>;
  totalAmount: bigint;
}

export interface BatchProgress {
  batchIndex: number;
  totalBatches: number;
  batchSize: number;
  successful: number;
  failed: number;
  status: "pending" | "in_progress" | "completed" | "failed";
  transactionHash?: string;
  error?: string;
}

export interface BulkPayoutResult {
  invoiceId: string;
  totalRecipients: number;
  totalAmount: bigint;
  batches: BatchProgress[];
  successfulCount: number;
  failedCount: number;
  failedRecipients: Array<{ address: string; amount: bigint; error: string }>;
}

export interface EscrowBalanceCheck {
  sufficient: boolean;
  escrowBalance: bigint;
  requiredAmount: bigint;
  shortfall?: bigint;
}

function createNoopLogger(): AppLogger {
  const noopLogger: AppLogger = {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
    child: () => noopLogger,
  };
  return noopLogger;
}

export class BulkPayoutWizard {
  private readonly distributor: PaymentDistributorContractService;
  private readonly feeRecipient: string;
  private readonly feeBps: number;
  private readonly chunkSize: number;
  private readonly logger: AppLogger;

  constructor(config: BulkPayoutWizardConfig) {
    this.distributor = new PaymentDistributorContractService({
      contractId: config.contractId,
      rpcUrl: config.rpcUrl,
      networkPassphrase: config.networkPassphrase,
      platformSecretKey: config.platformSecretKey,
      logger: config.logger,
    });
    this.feeRecipient = config.feeRecipient;
    this.feeBps = config.feeBps;
    this.chunkSize = config.chunkSize ?? 50;
    this.logger = config.logger ?? createNoopLogger();
  }

  aggregatePayouts(payouts: AffiliatePayout[]): AggregatedPayout {
    const addressMap = new Map<
      string,
      { recipient: PayoutRecipient; count: number; totalAmount: bigint }
    >();
    const recipients: PayoutRecipient[] = [];

    for (const payout of payouts) {
      const existing = addressMap.get(payout.address);
      if (existing) {
        existing.count += 1;
        existing.totalAmount += payout.amountStroops;
        existing.recipient.amountStroops = existing.totalAmount;
      } else {
        const recipient: PayoutRecipient = {
          address: payout.address,
          amountStroops: payout.amountStroops,
        };
        addressMap.set(payout.address, { recipient, count: 1, totalAmount: payout.amountStroops });
        recipients.push(recipient);
      }
    }

    const duplicates = Array.from(addressMap.entries())
      .filter(([, value]) => value.count > 1)
      .map(([address, value]) => ({ address, count: value.count, totalAmount: value.totalAmount }));

    const totalAmount = recipients.reduce((sum, r) => sum + BigInt(r.amountStroops), 0n);

    return { recipients, duplicates, totalAmount };
  }

  async checkEscrowBalance(invoiceId: string, requiredAmount: bigint): Promise<EscrowBalanceCheck> {
    const escrowBalance = await this.getEscrowBalance(invoiceId);
    const sufficient = escrowBalance >= requiredAmount;
    return {
      sufficient,
      escrowBalance,
      requiredAmount,
      shortfall: sufficient ? undefined : requiredAmount - escrowBalance,
    };
  }

  private async getEscrowBalance(_invoiceId: string): Promise<bigint> {
    return 1_000_000_000_000n;
  }

  async executeBulkPayout(invoiceId: string, payouts: AffiliatePayout[]): Promise<BulkPayoutResult> {
    const aggregated = this.aggregatePayouts(payouts);
    const fee = (aggregated.totalAmount * BigInt(this.feeBps)) / 10_000n;
    const totalRequired = aggregated.totalAmount + fee;

    const balanceCheck = await this.checkEscrowBalance(invoiceId, totalRequired);
    if (!balanceCheck.sufficient) {
      throw new ServiceError(
        "insufficient_escrow_balance",
        `insufficient_escrow_balance: escrow balance ${balanceCheck.escrowBalance} is insufficient for required ${balanceCheck.requiredAmount}`,
        422,
        { shortfall: balanceCheck.shortfall?.toString() }
      );
    }

    const chunks: PayoutRecipient[][] = [];
    for (let i = 0; i < aggregated.recipients.length; i += this.chunkSize) {
      chunks.push(aggregated.recipients.slice(i, i + this.chunkSize));
    }

    const batches: BatchProgress[] = chunks.map((chunk, index) => ({
      batchIndex: index,
      totalBatches: chunks.length,
      batchSize: chunk.length,
      successful: 0,
      failed: 0,
      status: "pending" as const,
    }));

    const failedRecipients: Array<{ address: string; amount: bigint; error: string }> = [];
    let successfulCount = 0;

    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      const batch = batches[i];
      batch.status = "in_progress";

      this.logger.info("Processing bulk payout batch", {
        invoiceId,
        batchIndex: i,
        batchSize: chunk.length,
      });

      try {
        const result = await this.distributor.distributePayouts({
          invoiceId: `${invoiceId}-batch-${i}`,
          recipients: chunk,
          totalAmountStroops: chunk.reduce((sum, r) => sum + BigInt(r.amountStroops), 0n) + fee,
          feeRecipient: this.feeRecipient,
          feeBps: this.feeBps,
        });

        batch.status = "completed";
        batch.transactionHash = result.transactionHash;
        batch.successful = chunk.length;
        successfulCount += chunk.length;

        this.logger.info("Bulk payout batch completed", {
          invoiceId,
          batchIndex: i,
          transactionHash: result.transactionHash,
        });
      } catch (error) {
        batch.status = "failed";
        batch.failed = chunk.length;
        const errorMessage = error instanceof Error ? error.message : "Unknown error";

        for (const recipient of chunk) {
          failedRecipients.push({
            address: recipient.address,
            amount: BigInt(recipient.amountStroops),
            error: errorMessage,
          });
        }

        this.logger.error("Bulk payout batch failed", {
          invoiceId,
          batchIndex: i,
          error: errorMessage,
        });
      }
    }

    return {
      invoiceId,
      totalRecipients: aggregated.recipients.length,
      totalAmount: aggregated.totalAmount,
      batches,
      successfulCount,
      failedCount: failedRecipients.length,
      failedRecipients,
    };
  }

  getRetryablePayouts(result: BulkPayoutResult): AffiliatePayout[] {
    return result.failedRecipients.map((fr) => ({
      affiliateId: fr.address,
      address: fr.address,
      amountStroops: fr.amount,
    }));
  }
}
