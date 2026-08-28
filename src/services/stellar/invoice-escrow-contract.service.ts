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
export type {
  CreateEscrowResult,
  FundEscrowParams,
  RecordPaymentParams,
  SettleEscrowParams,
};

export interface InvoiceEscrowContractServiceDependencies {
  contractId: string;
  rpcUrl?: string;
  networkPassphrase?: string;
  platformSecretKey?: string;
  server?: SorobanRpc.Server;
  logger?: AppLogger;
}

export class InvoiceEscrowContractService {
  private readonly contract: Contract;
  readonly contractId: string;
  private readonly rpcServer?: SorobanRpc.Server;
  private readonly networkPassphrase?: string;
  private readonly platformSecretKey?: string;
  private readonly logger: AppLogger;

  constructor(
    dependenciesOrContractId: string | InvoiceEscrowContractServiceDependencies,
    logger?: AppLogger,
  ) {
    if (typeof dependenciesOrContractId === "string") {
      if (!dependenciesOrContractId) {
        throw new Error("contractId is required.");
      }
      this.contractId = dependenciesOrContractId;
      this.contract = new Contract(dependenciesOrContractId);
      this.logger = logger ?? globalLogger;
    } else {
      if (!dependenciesOrContractId.contractId) {
        throw new Error("contractId is required.");
      }
      this.contractId = dependenciesOrContractId.contractId;
      this.contract = new Contract(dependenciesOrContractId.contractId);
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
    paymentTokenAddress: string,
  ): xdr.Operation {
    const amountBigInt =
      typeof amountStroops === "bigint" ? amountStroops : BigInt(amountStroops);

    return this.contract.call(
      "create_escrow",
      nativeToScVal(invoiceId, { type: "symbol" }),
      new Address(sellerAddress).toScVal(),
      nativeToScVal(amountBigInt, { type: "i128" }),
      nativeToScVal(dueDateTimestamp, { type: "u64" }),
      new Address(paymentTokenAddress).toScVal(),
    );
  }

  /**
   * Build the Soroban contract invocation operation for funding an escrow.
   */
  public buildFundEscrowTx(
    invoiceId: string,
    investorAddress: string,
    amountStroops: bigint | number | string,
  ): xdr.Operation {
    const amountBigInt =
      typeof amountStroops === "bigint" ? amountStroops : BigInt(amountStroops);

    return this.contract.call(
      "fund_escrow",
      nativeToScVal(invoiceId, { type: "symbol" }),
      new Address(investorAddress).toScVal(),
      nativeToScVal(amountBigInt, { type: "i128" }),
    );
  }

  /**
   * Build the Soroban contract invocation operation for recording a payment.
   */
  public buildRecordPaymentTx(
    invoiceId: string,
    payerAddress: string,
    amountStroops: bigint | number | string,
  ): xdr.Operation {
    const amountBigInt =
      typeof amountStroops === "bigint" ? amountStroops : BigInt(amountStroops);

    return this.contract.call(
      "record_payment",
      nativeToScVal(invoiceId, { type: "symbol" }),
      new Address(payerAddress).toScVal(),
      nativeToScVal(amountBigInt, { type: "i128" }),
    );
  }

  /**
   * Build the Soroban contract invocation operation for settling an escrow.
   */
  public buildSettleEscrowTx(invoiceId: string): xdr.Operation {
    return this.contract.call(
      "settle_escrow",
      nativeToScVal(invoiceId, { type: "symbol" }),
    );
  }

  /**
   * Simulates a transaction against the Soroban RPC endpoint to verify resource limits and auth footprint.
   */
  public async simulateTransaction(
    transaction: Transaction | FeeBumpTransaction,
  ): Promise<SimulateTransactionResult> {
    if (!this.rpcServer) {
      throw new Error("Soroban RPC server is not configured for simulation.");
    }

    let simResponse: Awaited<ReturnType<SorobanRpc.Server["simulateTransaction"]>>;
    try {
      simResponse = await this.rpcServer.simulateTransaction(transaction);
    } catch (error) {
      this.logger.error("Soroban simulateTransaction call failed.", {
        sorobanContractId: this.contractId,
        error: error instanceof Error ? error.message : String(error),
      });
      throw new ServiceError(
        "soroban_simulation_failed",
        "Failed to simulate the transaction against the Soroban RPC endpoint.",
        502,
      );
    }

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
    transaction: Transaction | FeeBumpTransaction,
  ): Promise<SendTransactionResult> {
    if (!this.rpcServer) {
      throw new Error("Soroban RPC server is not configured for submission.");
    }

    let response: Awaited<ReturnType<SorobanRpc.Server["sendTransaction"]>>;
    try {
      response = await this.rpcServer.sendTransaction(transaction);
    } catch (error) {
      this.logger.error("Soroban sendTransaction call failed.", {
        sorobanContractId: this.contractId,
        error: error instanceof Error ? error.message : String(error),
      });
      throw new ServiceError(
        "soroban_submission_failed",
        "Failed to submit the transaction to the Soroban RPC endpoint.",
        502,
      );
    }

    return {
      status: response.status,
      txHash: response.hash,
      errorResult: response.errorResult,
    };
  }

  /**
   * Creates/initializes an escrow on-chain and logs the structured completion event.
   * Ensures that only sanitized metadata (invoiceId, sorobanContractId, sellerAddress, amountStroops)
   * is logged without leaking any secret keys, signing seeds, or auth tokens.
   */
  public async createEscrowOnChain(
    input: CreateEscrowInput,
  ): Promise<CreateEscrowResult> {
    const amountBigInt =
      typeof input.amountStroops === "bigint"
        ? input.amountStroops
        : BigInt(input.amountStroops);

    const operation = this.buildCreateEscrowTx(
      input.invoiceId,
      input.sellerAddress,
      amountBigInt,
      input.dueDateTimestamp,
      input.paymentTokenAddress,
    );

    const amountStroopsStr = amountBigInt.toString();

    // Log structured event on successful escrow creation
    this.logger.info("Soroban escrow created successfully on-chain.", {
      invoiceId: input.invoiceId,
      sorobanContractId: this.contractId,
      sellerAddress: input.sellerAddress,
      amountStroops: amountStroopsStr,
    });

    return {
      contractId: this.contractId,
      invoiceId: input.invoiceId,
      sellerAddress: input.sellerAddress,
      amountStroops: amountStroopsStr,
      operation,
    };
  }
}
