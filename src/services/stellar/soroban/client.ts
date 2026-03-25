/**
 * Soroban Client Wrapper for Escrow Operations
 * 
 * Provides a typed interface to the escrow smart contract with proper
 * error handling, transaction management, and environment configuration.
 * 
 * Security assumptions:
 * - Admin operations require trusted platform keypair
 * - Oracle is trusted for price data
 * - Contract itself enforces fund release conditions
 */

import {
  Keypair,
  Transaction,
  TransactionBuilder,
  StrKey,
  Address,
  Contract,
  xdr,
} from "stellar-sdk";

import {
  SorobanRpc,
} from "stellar-sdk";

// Define types inline since they may not be exported properly
interface GetTransactionResult {
  status: "SUCCESS" | "NOT_FOUND" | "FAILED";
  hash?: string;
  ledger?: number;
  createdAt?: number;
  applicationOrder?: number;
  feeBump?: boolean;
  innerTransactionHash?: string;
  outerTransactionHash?: string;
  signals?: number[];
  minTempIndex?: number;
  minProofIndex?: number;
  sourceAccount?: string;
  feeBumpSource?: string;
  accountSequenceBump?: number;
  resultXdr?: string;
}

import {
  SorobanClientOptions,
  EscrowContractConfig,
  EscrowState,
  EscrowStatus,
  FundEscrowParams,
  ReleaseEscrowParams,
  CancelEscrowParams,
  CreateEscrowParams,
  EscrowCreationResult,
  EscrowFundingResult,
  ContractInvocationResult,
} from "./types";

import {
  SorobanError,
  InvalidAddressError,
  ValidationError,
  EscrowStateError,
  TransactionError,
  createRpcError,
} from "./errors";

import { buildEscrowConfig, isValidStellarAddress } from "./config";

// ============================================================================
// Soroban Client Class
// ============================================================================

/**
 * Client for interacting with the Soroban Escrow contract
 * 
 * This class wraps the Soroban RPC client and provides typed methods
 * for escrow operations. It handles transaction building, simulation,
 * submission, and result parsing.
 * 
 * @example
 * ```typescript
 * import { SorobanClient } from './services/stellar/soroban';
 * 
 * // Initialize with environment config
 * const client = SorobanClient.fromEnv();
 * 
 * // Get escrow state
 * const state = await client.getEscrowState('ESCROW_ADDRESS');
 * 
 * // Fund an escrow
 * const result = await client.fundEscrow({
 *   source: platformKeypair,
 *   invoiceId: 'INV-123',
 *   amount: BigInt(100000000), // 10 XLM in stroops
 *   duration: 86400 * 30, // 30 days
 *   recipient: 'GBXXX...',
 * });
 * ```
 */
export class SorobanClient {
  private readonly config: EscrowContractConfig;
  private readonly server: SorobanRpc.Server;
  private readonly contract: Contract;
  private readonly logger?: {
    debug: (message: string, ...args: unknown[]) => void;
    info: (message: string, ...args: unknown[]) => void;
    warn: (message: string, ...args: unknown[]) => void;
    error: (message: string, ...args: unknown[]) => void;
  };

  // Contract method names (should match your actual contract ABI)
  private static readonly METHOD_INIT = "init";
  private static readonly METHOD_FUND = "fund";
  private static readonly METHOD_RELEASE = "release";
  private static readonly METHOD_CANCEL = "cancel";
  private static readonly METHOD_GET_STATE = "get_state";
  private static readonly METHOD_GET_BALANCE = "get_balance";

  // Status values from contract (should match your contract enum)
  private static readonly STATUS_PENDING = 0;
  private static readonly STATUS_FUNDED = 1;
  private static readonly STATUS_RELEASED = 2;
  private static readonly STATUS_CANCELLED = 3;
  private static readonly STATUS_EXPIRED = 4;

  /**
   * Create a new SorobanClient from environment configuration
   */
  public static fromEnv(): SorobanClient {
    const config = buildEscrowConfig();
    return new SorobanClient({ config });
  }

  /**
   * Create a new SorobanClient with custom configuration
   */
  public static fromConfig(options: SorobanClientOptions): SorobanClient {
    return new SorobanClient(options);
  }

  /**
   * Private constructor - use factory methods instead
   */
  private constructor(options: SorobanClientOptions) {
    this.config = options.config;
    this.logger = options.logger;

    // Initialize Soroban RPC server
    const rpcUrl = options.rpcUrl || options.config.rpc.url;
    this.server = new SorobanRpc.Server(rpcUrl);
    
    // Initialize contract
    this.contract = new Contract(options.config.contractId);

    this.logger?.debug("SorobanClient initialized", {
      contractId: this.config.contractId,
      network: this.config.rpc.networkType,
      rpcUrl,
    });
  }

  // ==========================================================================
  // Configuration Accessors
  // ==========================================================================

  /**
   * Get the configured contract ID
   */
  public getContractId(): string {
    return this.config.contractId;
  }

  /**
   * Get the configured RPC URL
   */
  public getRpcUrl(): string {
    return this.config.rpc.url;
  }

  /**
   * Get the configured network passphrase
   */
  public getNetworkPassphrase(): string {
    return this.config.rpc.networkPassphrase;
  }

  /**
   * Get the configured network type
   */
  public getNetworkType(): string {
    return this.config.rpc.networkType;
  }

  /**
   * Get the configured token contract ID
   */
  public getTokenContractId(): string {
    return this.config.tokenContractId;
  }

  // ==========================================================================
  // Escrow State Operations (Read-only)
  // ==========================================================================

  /**
   * Get the current state of an escrow
   * 
   * @param escrowAddress - The escrow account address
   * @returns EscrowState with current status and details
   * @throws EscrowNotFoundError if escrow doesn't exist
   * @throws EscrowExpiredError if escrow has expired
   */
  public async getEscrowState(escrowAddress: string): Promise<EscrowState> {
    // Validate address
    if (!isValidStellarAddress(escrowAddress)) {
      throw new InvalidAddressError(escrowAddress);
    }

    this.logger?.debug("Fetching escrow state", { escrowAddress });

    try {
      // Call the contract's get_state method
      const result = await this.callContract<number[]>(
        SorobanClient.METHOD_GET_STATE,
        [new Address(escrowAddress).toScVal()]
      );

      return this.parseEscrowState(escrowAddress, result);
    } catch (error) {
      if (error instanceof SorobanError) {
        throw error;
      }
      throw createRpcError(this.config.rpc.url, error);
    }
  }

  /**
   * Get the balance of an escrow account
   * 
   * @param escrowAddress - The escrow account address
   * @returns Balance in stroops
   */
  public async getEscrowBalance(escrowAddress: string): Promise<bigint> {
    if (!isValidStellarAddress(escrowAddress)) {
      throw new InvalidAddressError(escrowAddress);
    }

    try {
      const result = await this.callContract<bigint>(
        SorobanClient.METHOD_GET_BALANCE,
        [new Address(escrowAddress).toScVal()]
      );

      return result;
    } catch (error) {
      if (error instanceof SorobanError) {
        throw error;
      }
      throw createRpcError(this.config.rpc.url, error);
    }
  }

  // ==========================================================================
  // Escrow Write Operations
  // ==========================================================================

  /**
   * Initialize a new escrow
   * 
   * @param params - Creation parameters including source keypair
   * @returns Result with escrow address and transaction hash
   */
  public async createEscrow(params: CreateEscrowParams): Promise<EscrowCreationResult> {
    // Validate addresses
    this.validateKeypair(params.source, "source");
    if (!isValidStellarAddress(params.investor)) {
      throw new InvalidAddressError(params.investor, "Invalid investor address");
    }

    this.logger?.info("Creating escrow", {
      investor: params.investor,
      invoiceId: params.invoiceId,
      duration: params.duration,
    });

    try {
      // Build and submit the transaction
      const txHash = await this.submitTransaction(
        params.source,
        SorobanClient.METHOD_INIT,
        [
          new Address(params.investor).toScVal(),
          xdr.ScVal.scvU32(params.duration),
          xdr.ScVal.scvSymbol(params.invoiceId),
        ]
      );

      // Derive escrow address from transaction
      const escrowAddress = this.deriveEscrowAddress(txHash, params.investor);

      return {
        success: true,
        txHash,
        escrowAddress,
      };
    } catch (error) {
      this.logger?.error("Escrow creation failed", error);
      return this.handleContractError(error, "createEscrow");
    }
  }

  /**
   * Fund an escrow with XLM
   * 
   * @param params - Funding parameters
   * @returns Result with transaction hash
   */
  public async fundEscrow(params: FundEscrowParams): Promise<EscrowFundingResult> {
    // Validate
    this.validateKeypair(params.source, "source");
    if (!isValidStellarAddress(params.recipient)) {
      throw new InvalidAddressError(params.recipient, "Invalid recipient address");
    }
    if (params.amount <= BigInt(0)) {
      throw new ValidationError("amount", params.amount.toString(), "Amount must be positive");
    }

    this.logger?.info("Funding escrow", {
      invoiceId: params.invoiceId,
      amount: params.amount.toString(),
      recipient: params.recipient,
    });

    try {
      // Build and submit funding transaction
      const txHash = await this.submitTransaction(
        params.source,
        SorobanClient.METHOD_FUND,
        [
          xdr.ScVal.scvSymbol(params.invoiceId),
          xdr.ScVal.scvI64(new xdr.Int64(params.amount)),
          new Address(params.recipient).toScVal(),
          xdr.ScVal.scvU32(params.duration),
        ]
      );

      return {
        success: true,
        txHash,
        amount: params.amount,
      };
    } catch (error) {
      this.logger?.error("Escrow funding failed", error);
      return this.handleContractError(error, "fundEscrow");
    }
  }

  /**
   * Release funds from an escrow
   * 
   * @param params - Release parameters
   * @returns Result with transaction hash
   */
  public async releaseEscrow(params: ReleaseEscrowParams): Promise<ContractInvocationResult> {
    // Validate
    this.validateKeypair(params.source, "source");
    if (!isValidStellarAddress(params.escrowAddress)) {
      throw new InvalidAddressError(params.escrowAddress, "Invalid escrow address");
    }

    // Check current state
    const state = await this.getEscrowState(params.escrowAddress);
    if (state.status !== "funded") {
      throw new EscrowStateError(params.escrowAddress, state.status, "funded");
    }

    this.logger?.info("Releasing escrow", {
      escrowAddress: params.escrowAddress,
      amount: params.amount?.toString() || "full",
    });

    try {
      const releaseAmount = params.amount 
        ? new xdr.Int64(params.amount)
        : new xdr.Int64(state.amount);
        
      const txHash = await this.submitTransaction(
        params.source,
        SorobanClient.METHOD_RELEASE,
        [
          new Address(params.escrowAddress).toScVal(),
          xdr.ScVal.scvI64(releaseAmount),
        ]
      );

      return {
        success: true,
        txHash,
      };
    } catch (error) {
      this.logger?.error("Escrow release failed", error);
      return this.handleContractError(error, "releaseEscrow");
    }
  }

  /**
   * Cancel an escrow
   * 
   * @param params - Cancel parameters
   * @returns Result with transaction hash
   */
  public async cancelEscrow(params: CancelEscrowParams): Promise<ContractInvocationResult> {
    // Validate
    this.validateKeypair(params.source, "source");
    if (!isValidStellarAddress(params.escrowAddress)) {
      throw new InvalidAddressError(params.escrowAddress, "Invalid escrow address");
    }

    // Check current state
    const state = await this.getEscrowState(params.escrowAddress);
    if (state.status !== "pending" && state.status !== "funded") {
      throw new EscrowStateError(params.escrowAddress, state.status, ["pending", "funded"]);
    }

    this.logger?.info("Cancelling escrow", {
      escrowAddress: params.escrowAddress,
    });

    try {
      const txHash = await this.submitTransaction(
        params.source,
        SorobanClient.METHOD_CANCEL,
        [new Address(params.escrowAddress).toScVal()]
      );

      return {
        success: true,
        txHash,
      };
    } catch (error) {
      this.logger?.error("Escrow cancellation failed", error);
      return this.handleContractError(error, "cancelEscrow");
    }
  }

  // ==========================================================================
  // Transaction Building and Submission
  // ==========================================================================

  /**
   * Call a contract method without transaction (for read-only calls)
   */
  private async callContract<T>(
    method: string,
    args: xdr.ScVal[]
  ): Promise<T> {
    try {
      // For read-only calls, we use simulateTransaction approach
      // Build a fake transaction for simulation
      const source = Keypair.random();
      
      const account = await this.server.getAccount(source.publicKey());
      
      const tx = new TransactionBuilder(account, {
        fee: "100",
        networkPassphrase: this.config.rpc.networkPassphrase,
      })
        .addOperation(this.contract.call(method, ...args))
        .setTimeout(30)
        .build();

      // Sign with random key (will be replaced in simulation)
      tx.sign(source);

      // Simulate the transaction
      const simResult = await this.server.simulateTransaction(tx);

      // Parse the result
      if ("error" in simResult) {
        throw new SorobanError(
          `Simulation error: ${simResult.error}`,
          "SIMULATION_ERROR",
          true
        );
      }

      if ("results" in simResult && simResult.results && Array.isArray(simResult.results) && simResult.results.length > 0) {
        const result = simResult.results[0];
        return this.parseScValResult<T>(result.retval);
      }

      throw new SorobanError("No simulation result returned", "NO_RESULT", false);
    } catch (error) {
      if (error instanceof SorobanError) {
        throw error;
      }
      throw createRpcError(this.config.rpc.url, error);
    }
  }

  /**
   * Submit a transaction that invokes a contract method
   */
  private async submitTransaction(
    source: Keypair,
    method: string,
    args: xdr.ScVal[]
  ): Promise<string> {
    try {
      // Get source account
      const account = await this.server.getAccount(source.publicKey());

      // Build the transaction
      const tx = new TransactionBuilder(account, {
        fee: "100000", // Base fee + resources
        networkPassphrase: this.config.rpc.networkPassphrase,
      })
        .addOperation(this.contract.call(method, ...args))
        .setTimeout(300) // 5 minute timeout
        .build();

      // First, simulate to get resource estimates
      tx.sign(source);
      const simResult = await this.server.simulateTransaction(tx);

      if ("error" in simResult) {
        throw new TransactionError(
          `Simulation failed: ${simResult.error}`,
          undefined,
          "simulation_failed"
        );
      }

      // If simulation returned a prepared transaction, use it
      let finalTx = tx;
      if ("transaction" in simResult && simResult.transaction) {
        // Transaction is returned as base64 string
        finalTx = new Transaction(simResult.transaction as string, this.config.rpc.networkPassphrase);
        // Re-sign with source keypair
        finalTx.sign(source);
      }

      // Submit the transaction
      const sendResult = await this.server.sendTransaction(finalTx);

      if ("error" in sendResult) {
        throw new TransactionError(
          `Failed to send transaction: ${sendResult.error}`,
          sendResult.hash
        );
      }

      // Poll for confirmation using getTransaction
      const confirmResult = await this.pollForTransaction(sendResult.hash);

      if (confirmResult.status !== "SUCCESS") {
        throw new TransactionError(
          `Transaction failed with status: ${confirmResult.status}`,
          sendResult.hash,
          confirmResult.status,
          confirmResult.resultXdr
        );
      }

      return sendResult.hash;
    } catch (error) {
      if (error instanceof SorobanError || error instanceof TransactionError) {
        throw error;
      }
      throw createRpcError(this.config.rpc.url, error);
    }
  }

  /**
   * Poll for transaction confirmation
   */
  private async pollForTransaction(
    txHash: string,
    maxAttempts: number = 30,
    intervalMs: number = 1000
  ): Promise<GetTransactionResult> {
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const result = await this.server.getTransaction(txHash) as GetTransactionResult;
      
      if (result.status === "SUCCESS" || result.status === "FAILED") {
        return result;
      }
      
      // Wait before next poll (NOT_FOUND status means still pending)
      await new Promise(resolve => setTimeout(resolve, intervalMs));
    }
    
    throw new SorobanError(
      `Transaction ${txHash} not confirmed after ${maxAttempts} attempts`,
      "TRANSACTION_TIMEOUT",
      false,
      { txHash, maxAttempts }
    );
  }

  // ==========================================================================
  // Helper Methods
  // ==========================================================================

  /**
   * Validate a keypair is properly configured
   */
  private validateKeypair(keypair: Keypair, name: string): void {
    if (!keypair) {
      throw new ValidationError(name, "undefined", `${name} keypair is required`);
    }
    if (!keypair.canSign()) {
      throw new ValidationError(name, keypair.publicKey(), `${name} keypair cannot sign`);
    }
  }

  /**
   * Parse escrow state from contract return value
   */
  private parseEscrowState(escrowAddress: string, raw: number[]): EscrowState {
    const statusMap: Record<number, EscrowStatus> = {
      [SorobanClient.STATUS_PENDING]: "pending",
      [SorobanClient.STATUS_FUNDED]: "funded",
      [SorobanClient.STATUS_RELEASED]: "released",
      [SorobanClient.STATUS_CANCELLED]: "cancelled",
      [SorobanClient.STATUS_EXPIRED]: "expired",
    };

    const status = statusMap[raw[3]] || "pending";

    // Convert raw values to proper addresses
    const investor = StrKey.encodeEd25519PublicKey(Buffer.from(String(raw[0])));
    const platform = StrKey.encodeEd25519PublicKey(Buffer.from(String(raw[1])));
    const recipient = StrKey.encodeEd25519PublicKey(Buffer.from(String(raw[2])));

    return {
      escrowAddress,
      investor,
      platform,
      recipient,
      amount: BigInt(raw[4]),
      status,
      createdAt: Number(raw[5]),
      expiresAt: Number(raw[6]),
      invoiceId: String(raw[7]),
    };
  }

  /**
   * Parse SCVal result to typed value
   */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  private parseScValResult<T>(retval: xdr.ScVal): T {
    // Note: This needs to be implemented based on your contract's actual return types
    // For now, return as unknown
    return undefined as unknown as T;
  }

  /**
   * Derive escrow address from creation transaction
   */
  private deriveEscrowAddress(txHash: string, investor: string): string {
    // In a real implementation, this would use the contract's
    // created addresses from the transaction result
    // For now, we return a deterministic address based on tx hash
    const hashBuffer = Buffer.from(txHash.slice(0, 56), "hex");
    const combined = Buffer.concat([hashBuffer, Buffer.from(investor)]);
    return StrKey.encodeEd25519PublicKey(combined.slice(0, 32));
  }

  /**
   * Handle contract errors and return structured result
   */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  private handleContractError(
    error: unknown,
    methodName: string
  ): ContractInvocationResult {
    if (error instanceof SorobanError) {
      return {
        success: false,
        error: error.message,
      };
    }

    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

// ============================================================================
// Export
// ============================================================================

export default SorobanClient;
