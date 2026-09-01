import {
  Contract,
  Address,
  nativeToScVal,
  xdr,
  SorobanRpc,
  Transaction,
  FeeBumpTransaction,
} from "stellar-sdk";
import type { AppLogger } from "../../observability/logger";
import { logger as globalLogger } from "../../observability/logger";
import { ServiceError } from "../../utils/service-error";
import type {
  CreateEscrowParams,
  CreateEscrowResult,
  FundEscrowParams,
  RecordPaymentParams,
  SettleEscrowParams,
  SimulateTransactionResult,
  SendTransactionResult,
} from "../../types/soroban.types";

export type CreateEscrowInput = CreateEscrowParams;
export type { CreateEscrowResult, FundEscrowParams, RecordPaymentParams, SettleEscrowParams };

const DEFAULT_RPC_TIMEOUT_MS = 15_000;
const DEFAULT_CONFIRMATION_POLL_MS = 1000;
const DEFAULT_CONFIRMATION_ATTEMPTS = 20;

/**
 * RPC failures reach the HTTP layer as ServiceError so the error middleware can
 * map them to a gateway status; a bespoke error class would fall through to a
 * generic 500. The timeout guard is layered on top of that same contract.
 */
const RPC_OPERATIONS = {
  simulation: {
    failureCode: "soroban_simulation_failed",
    logMessage: "Soroban simulateTransaction call failed.",
    failureMessage: "Failed to simulate the transaction against the Soroban RPC endpoint.",
  },
  submission: {
    failureCode: "soroban_submission_failed",
    logMessage: "Soroban sendTransaction call failed.",
    failureMessage: "Failed to submit the transaction to the Soroban RPC endpoint.",
  },
} as const;

type RpcOperation = keyof typeof RPC_OPERATIONS;
const MAX_I128 = (1n << 127n) - 1n;

export class InvoiceEscrowContractError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly cause?: unknown
  ) {
    super(message);
    this.name = "InvoiceEscrowContractError";
  }
}

export interface InvoiceEscrowContractServiceDependencies {
  contractId: string;
  rpcUrl?: string;
  networkPassphrase?: string;
  platformSecretKey?: string;
  server?: SorobanRpc.Server;
  logger?: AppLogger;
  rpcTimeoutMs?: number;
  confirmationPollMs?: number;
  confirmationAttempts?: number;
}

export class InvoiceEscrowContractService {
  private readonly contract: Contract;
  readonly contractId: string;
  private readonly rpcServer?: SorobanRpc.Server;
  private readonly networkPassphrase?: string;
  private readonly platformSecretKey?: string;
  private readonly logger: AppLogger;
  private readonly rpcTimeoutMs: number;
  private readonly confirmationPollMs: number;
  private readonly confirmationAttempts: number;

  constructor(
    dependenciesOrContractId: string | InvoiceEscrowContractServiceDependencies,
    logger?: AppLogger
  ) {
    if (typeof dependenciesOrContractId === "string") {
      if (!dependenciesOrContractId || !dependenciesOrContractId.trim()) {
        throw new Error("contractId is required.");
      }
      this.contractId = dependenciesOrContractId.trim();
      this.contract = new Contract(this.contractId);
      this.logger = logger ?? globalLogger;
      this.rpcTimeoutMs = DEFAULT_RPC_TIMEOUT_MS;
      this.confirmationPollMs = DEFAULT_CONFIRMATION_POLL_MS;
      this.confirmationAttempts = DEFAULT_CONFIRMATION_ATTEMPTS;
    } else {
      if (!dependenciesOrContractId.contractId || !dependenciesOrContractId.contractId.trim()) {
        throw new Error("contractId is required.");
      }
      this.contractId = dependenciesOrContractId.contractId.trim();
      this.contract = new Contract(this.contractId);
      this.networkPassphrase = dependenciesOrContractId.networkPassphrase;
      this.platformSecretKey = dependenciesOrContractId.platformSecretKey;
      if (dependenciesOrContractId.server) {
        this.rpcServer = dependenciesOrContractId.server;
      } else if (dependenciesOrContractId.rpcUrl) {
        this.rpcServer = new SorobanRpc.Server(dependenciesOrContractId.rpcUrl, {
          allowHttp: dependenciesOrContractId.rpcUrl.startsWith("http://"),
        });
      }
      this.logger = dependenciesOrContractId.logger ?? logger ?? globalLogger;
      const rpcTimeoutMs = dependenciesOrContractId.rpcTimeoutMs ?? DEFAULT_RPC_TIMEOUT_MS;
      if (!Number.isSafeInteger(rpcTimeoutMs) || rpcTimeoutMs <= 0) {
        throw new Error("rpcTimeoutMs must be a positive integer.");
      }
      this.rpcTimeoutMs = rpcTimeoutMs;
      this.confirmationPollMs =
        dependenciesOrContractId.confirmationPollMs ?? DEFAULT_CONFIRMATION_POLL_MS;
      this.confirmationAttempts =
        dependenciesOrContractId.confirmationAttempts ?? DEFAULT_CONFIRMATION_ATTEMPTS;
    }
  }

  private normalizeInvoiceId(invoiceId: string): string {
    const normalized = invoiceId?.trim();
    if (!normalized) {
      throw new InvoiceEscrowContractError("invalid_invoice_id", "invoiceId is required.");
    }
    if (normalized.length > 64) {
      throw new InvoiceEscrowContractError(
        "invalid_invoice_id",
        "invoiceId must not exceed 64 characters."
      );
    }
    return normalized;
  }

  private normalizeAmount(amount: bigint | number | string): bigint {
    let normalized: bigint;
    try {
      if (typeof amount === "number" && (!Number.isSafeInteger(amount) || amount <= 0)) {
        throw new Error("unsafe numeric amount");
      }
      if (typeof amount === "string" && !/^\d+$/.test(amount.trim())) {
        throw new Error("invalid amount string");
      }
      normalized = typeof amount === "bigint" ? amount : BigInt(amount);
    } catch (error) {
      throw new InvoiceEscrowContractError(
        "invalid_amount",
        "amountStroops must be a positive integer.",
        error
      );
    }

    if (normalized <= 0n || normalized > MAX_I128) {
      throw new InvoiceEscrowContractError(
        "invalid_amount",
        "amountStroops must be a positive i128 integer."
      );
    }
    return normalized;
  }

  private normalizeDueDate(dueDateTimestamp: number): number {
    if (!Number.isSafeInteger(dueDateTimestamp) || dueDateTimestamp <= 0) {
      throw new InvoiceEscrowContractError(
        "invalid_due_date",
        "dueDateTimestamp must be a positive integer."
      );
    }
    return dueDateTimestamp;
  }

  private toAddressScVal(value: string, field: string): xdr.ScVal {
    const normalized = value?.trim();
    if (!normalized) {
      throw new InvoiceEscrowContractError("invalid_address", `${field} is required.`);
    }
    try {
      return new Address(normalized).toScVal();
    } catch (error) {
      throw new InvoiceEscrowContractError(
        "invalid_address",
        `${field} must be a valid Stellar address.`,
        error
      );
    }
  }

  private async executeRpc<T>(operation: RpcOperation, work: () => Promise<T>): Promise<T> {
    const { failureCode, logMessage, failureMessage } = RPC_OPERATIONS[operation];
    let timeout: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        work(),
        new Promise<T>((_resolve, reject) => {
          timeout = setTimeout(() => {
            reject(
              new ServiceError(
                "soroban_rpc_timeout",
                `Soroban RPC ${operation} timed out after ${this.rpcTimeoutMs}ms.`,
                504
              )
            );
          }, this.rpcTimeoutMs);
        }),
      ]);
    } catch (error) {
      this.logger.error(logMessage, {
        operation,
        sorobanContractId: this.contractId,
        error: error instanceof Error ? error.message : "Unknown error",
      });
      if (error instanceof ServiceError) throw error;
      throw new ServiceError(failureCode, failureMessage, 502);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }

  /**
   * Build the Soroban contract invocation operation for creating an escrow.
   */
  public buildCreateEscrowTx(
    invoiceId: string,
    sellerAddress: string,
    amountStroops: bigint | number | string,
    dueDateTimestamp: number,
    paymentTokenAddress: string
  ): xdr.Operation {
    const normalizedInvoiceId = this.normalizeInvoiceId(invoiceId);
    const amountBigInt = this.normalizeAmount(amountStroops);
    const dueDate = this.normalizeDueDate(dueDateTimestamp);

    return this.contract.call(
      "create_escrow",
      nativeToScVal(normalizedInvoiceId, { type: "symbol" }),
      this.toAddressScVal(sellerAddress, "sellerAddress"),
      nativeToScVal(amountBigInt, { type: "i128" }),
      nativeToScVal(dueDate, { type: "u64" }),
      this.toAddressScVal(paymentTokenAddress, "paymentTokenAddress")
    );
  }

  /**
   * Build the Soroban contract invocation operation for funding an escrow.
   */
  public buildFundEscrowTx(
    invoiceId: string,
    investorAddress: string,
    amountStroops: bigint | number | string
  ): xdr.Operation {
    const normalizedInvoiceId = this.normalizeInvoiceId(invoiceId);
    const amountBigInt = this.normalizeAmount(amountStroops);

    return this.contract.call(
      "fund_escrow",
      nativeToScVal(normalizedInvoiceId, { type: "symbol" }),
      this.toAddressScVal(investorAddress, "investorAddress"),
      nativeToScVal(amountBigInt, { type: "i128" })
    );
  }

  /**
   * Build the Soroban contract invocation operation for recording a payment.
   */
  public buildRecordPaymentTx(
    invoiceId: string,
    payerAddress: string,
    amountStroops: bigint | number | string
  ): xdr.Operation {
    const normalizedInvoiceId = this.normalizeInvoiceId(invoiceId);
    const amountBigInt = this.normalizeAmount(amountStroops);

    return this.contract.call(
      "record_payment",
      nativeToScVal(normalizedInvoiceId, { type: "symbol" }),
      this.toAddressScVal(payerAddress, "payerAddress"),
      nativeToScVal(amountBigInt, { type: "i128" })
    );
  }

  /**
   * Build the Soroban contract invocation operation for settling an escrow.
   */
  public buildSettleEscrowTx(invoiceId: string): xdr.Operation {
    return this.contract.call(
      "settle_escrow",
      nativeToScVal(this.normalizeInvoiceId(invoiceId), { type: "symbol" })
    );
  }

  /**
   * Simulates a transaction against the Soroban RPC endpoint to verify resource limits and auth footprint.
   */
  public async simulateTransaction(
    transaction: Transaction | FeeBumpTransaction
  ): Promise<SimulateTransactionResult> {
    if (!this.rpcServer) {
      throw new Error("Soroban RPC server is not configured for simulation.");
    }

    const simResponse = await this.executeRpc("simulation", () =>
      this.rpcServer!.simulateTransaction(transaction)
    );
    const successResponse = simResponse as unknown as {
      minResourceFee?: string;
      cost?: { cpuInsns?: string; memBytes?: string };
      results?: Array<{ auth?: xdr.SorobanAuthorizationEntry[]; xdr: string }>;
      transactionData?: xdr.SorobanTransactionData;
      error?: string;
    };

    return {
      minResourceFee: successResponse.minResourceFee ?? "0",
      cost: {
        cpuInsns: successResponse.cost?.cpuInsns ?? "0",
        memBytes: successResponse.cost?.memBytes ?? "0",
      },
      results: successResponse.results?.map((r) => ({
        auth: r.auth,
        xdr: r.xdr,
      })),
      transactionData: successResponse.transactionData,
      error: successResponse.error,
    };
  }

  /**
   * Submits a transaction to the Stellar network via Soroban RPC sendTransaction.
   */
  public async submitTransaction(
    transaction: Transaction | FeeBumpTransaction
  ): Promise<SendTransactionResult> {
    if (!this.rpcServer) {
      throw new Error("Soroban RPC server is not configured for submission.");
    }

    const response = await this.executeRpc("submission", () =>
      this.rpcServer!.sendTransaction(transaction)
    );
    return {
      status: response.status,
      txHash: response.hash,
      errorResult: response.errorResult,
    };
  }

  /**
   * Polls for transaction confirmation until it reaches SUCCESS, FAILED, or times out.
   */
  public async waitForTransactionConfirmation(
    txHash: string,
  ): Promise<{ status: "SUCCESS" | "FAILED" | "NOT_FOUND"; ledger: number | null }> {
    if (!this.rpcServer) {
      throw new Error("Soroban RPC server is not configured for transaction confirmation polling.");
    }
    if (!txHash || !txHash.trim()) {
      throw new Error("txHash is required.");
    }

    for (let attempt = 0; attempt < this.confirmationAttempts; attempt++) {
      try {
        const result = await this.rpcServer.getTransaction(txHash);
        if (result.status === "SUCCESS") {
          this.logger.info("Soroban transaction confirmed on-chain.", {
            txHash,
            sorobanContractId: this.contractId,
            ledger: "ledger" in result ? Number(result.ledger) : null,
          });
          return {
            status: "SUCCESS",
            ledger: "ledger" in result ? Number(result.ledger) : null,
          };
        }
        if (result.status === "FAILED") {
          this.logger.error("Soroban transaction reverted on-chain.", {
            txHash,
            sorobanContractId: this.contractId,
          });
          return { status: "FAILED", ledger: null };
        }
      } catch (error) {
        this.logger.warn("Transient error while checking transaction status", {
          txHash,
          attempt: attempt + 1,
          error: error instanceof Error ? error.message : String(error),
        });
      }

      await new Promise((resolve) => setTimeout(resolve, this.confirmationPollMs));
    }

    this.logger.error("Timed out waiting for transaction confirmation.", {
      txHash,
      sorobanContractId: this.contractId,
      attempts: this.confirmationAttempts,
    });
    throw new ServiceError(
      "transaction_confirmation_timeout",
      "Timed out waiting for transaction confirmation on-chain.",
      504,
    );
  }

  /**
   * Creates/initializes an escrow on-chain and logs the structured completion event.
   * Ensures that only sanitized metadata (invoiceId, sorobanContractId, sellerAddress, amountStroops)
   * is logged without leaking any secret keys, signing seeds, or auth tokens.
   */
  public async createEscrowOnChain(input: CreateEscrowInput): Promise<CreateEscrowResult> {
    const invoiceId = this.normalizeInvoiceId(input.invoiceId);
    const sellerAddress = input.sellerAddress?.trim();

    try {
      const amountBigInt = this.normalizeAmount(input.amountStroops);
      const operation = this.buildCreateEscrowTx(
        invoiceId,
        sellerAddress,
        amountBigInt,
        input.dueDateTimestamp,
        input.paymentTokenAddress
      );

      const amountStroopsStr = amountBigInt.toString();

      // Log structured event on successful escrow creation
      this.logger.info("Soroban escrow created successfully on-chain.", {
        invoiceId,
        sorobanContractId: this.contractId,
        sellerAddress,
        amountStroops: amountStroopsStr,
      });

      return {
        contractId: this.contractId,
        invoiceId,
        sellerAddress,
        amountStroops: amountStroopsStr,
        operation,
      };
    } catch (error) {
      this.logger.error("Failed to create Soroban escrow operation.", {
        invoiceId,
        sorobanContractId: this.contractId,
        error: error instanceof Error ? error.message : "Unknown error",
      });
      if (error instanceof InvoiceEscrowContractError) throw error;
      throw new InvoiceEscrowContractError(
        "create_escrow_failed",
        "Failed to create Soroban escrow operation.",
        error
      );
    }
  }
}
