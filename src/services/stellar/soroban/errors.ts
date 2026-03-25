/**
 * Structured error classes for Soroban Escrow operations
 * 
 * These errors provide clear, actionable information when misconfiguration
 * or runtime issues occur. All errors include error codes for programmatic handling.
 */

/**
 * Base error class for all Soroban-related errors
 */
export class SorobanError extends Error {
  public readonly code: string;
  public readonly isRetryable: boolean;
  public readonly context?: Record<string, unknown>;

  constructor(
    message: string,
    code: string,
    isRetryable: boolean = false,
    context?: Record<string, unknown>
  ) {
    super(message);
    this.name = this.constructor.name;
    this.code = code;
    this.isRetryable = isRetryable;
    this.context = context;
    // Node.js specific - conditionally capture stack trace
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const captureStackTrace = (Error as any).captureStackTrace;
    if (typeof captureStackTrace === "function") {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      captureStackTrace(this, this.constructor);
    }
  }

  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      isRetryable: this.isRetryable,
      context: this.context,
    };
  }
}

// ============================================================================
// Configuration Errors (Non-retryable)
// ============================================================================

/**
 * Thrown when required environment variables are missing
 */
export class MissingEnvironmentError extends SorobanError {
  constructor(variableName: string, context?: Record<string, unknown>) {
    super(
      `Missing required environment variable: ${variableName}`,
      "MISSING_ENV_VAR",
      false,
      { variableName, ...context }
    );
  }
}

/**
 * Thrown when contract ID is not configured or invalid
 */
export class InvalidContractIdError extends SorobanError {
  constructor(contractId: string | undefined, reason?: string) {
    super(
      reason || `Invalid or missing escrow contract ID: ${contractId || "undefined"}`,
      "INVALID_CONTRACT_ID",
      false,
      { contractId, reason }
    );
  }
}

/**
 * Thrown when network configuration is invalid
 */
export class InvalidNetworkError extends SorobanError {
  constructor(expected: string, actual: string, context?: Record<string, unknown>) {
    super(
      `Network mismatch: expected ${expected}, got ${actual}`,
      "INVALID_NETWORK",
      false,
      { expected, actual, ...context }
    );
  }
}

/**
 * Thrown when RPC URL is not properly configured
 */
export class InvalidRpcUrlError extends SorobanError {
  constructor(rpcUrl: string | undefined, reason?: string) {
    super(
      reason || `Invalid or missing RPC URL: ${rpcUrl || "undefined"}`,
      "INVALID_RPC_URL",
      false,
      { rpcUrl, reason }
    );
  }
}

/**
 * Thrown when network passphrase is invalid or missing
 */
export class InvalidNetworkPassphraseError extends SorobanError {
  constructor(networkType: string) {
    super(
      `Invalid or missing network passphrase for network type: ${networkType}`,
      "INVALID_NETWORK_PASSPHRASE",
      false,
      { networkType }
    );
  }
}

// ============================================================================
// Transaction Errors
// ============================================================================

/**
 * Thrown when a transaction fails
 */
export class TransactionError extends SorobanError {
  public readonly txHash?: string;
  public readonly status?: string;
  public readonly resultXdr?: string;

  constructor(
    message: string,
    txHash?: string,
    status?: string,
    resultXdr?: string,
    context?: Record<string, unknown>
  ) {
    super(message, "TRANSACTION_FAILED", false, { txHash, status, resultXdr, ...context });
    this.txHash = txHash;
    this.status = status;
    this.resultXdr = resultXdr;
  }
}

/**
 * Thrown when simulation fails
 */
export class SimulationError extends SorobanError {
  constructor(message: string, context?: Record<string, unknown>) {
    super(message, "SIMULATION_FAILED", true, context);
  }
}

/**
 * Thrown when there are insufficient resources for a transaction
 */
export class InsufficientResourcesError extends SorobanError {
  constructor(
    resourceType: string,
    required: bigint,
    available: bigint,
    context?: Record<string, unknown>
  ) {
    super(
      `Insufficient ${resourceType}: required ${required}, available ${available}`,
      "INSUFFICIENT_RESOURCES",
      false,
      { resourceType, required: String(required), available: String(available), ...context }
    );
  }
}

/**
 * Thrown when transaction is not yet confirmed within timeout
 */
export class TransactionTimeoutError extends SorobanError {
  constructor(txHash: string, timeoutMs: number) {
    super(
      `Transaction not confirmed within timeout of ${timeoutMs}ms`,
      "TRANSACTION_TIMEOUT",
      true,
      { txHash, timeoutMs }
    );
  }
}

// ============================================================================
// Contract Invocation Errors
// ============================================================================

/**
 * Thrown when contract invocation fails
 */
export class ContractInvocationError extends SorobanError {
  public readonly contractId: string;
  public readonly methodName: string;
  public readonly errorCode?: number;

  constructor(
    contractId: string,
    methodName: string,
    message: string,
    errorCode?: number,
    context?: Record<string, unknown>
  ) {
    super(
      `Contract invocation failed: ${message}`,
      "CONTRACT_INVOCATION_FAILED",
      false,
      { contractId, methodName, errorCode, ...context }
    );
    this.contractId = contractId;
    this.methodName = methodName;
    this.errorCode = errorCode;
  }
}

/**
 * Thrown when contract returns an error value
 */
export class ContractError extends SorobanError {
  public readonly contractId: string;
  public readonly methodName: string;
  public readonly errorMessage: string;

  constructor(
    contractId: string,
    methodName: string,
    errorMessage: string,
    context?: Record<string, unknown>
  ) {
    super(
      `Contract error in ${methodName}: ${errorMessage}`,
      "CONTRACT_ERROR",
      false,
      { contractId, methodName, errorMessage, ...context }
    );
    this.contractId = contractId;
    this.methodName = methodName;
    this.errorMessage = errorMessage;
  }
}

/**
 * Thrown when contract method is not found
 */
export class MethodNotFoundError extends SorobanError {
  constructor(contractId: string, methodName: string) {
    super(
      `Method '${methodName}' not found on contract ${contractId}`,
      "METHOD_NOT_FOUND",
      false,
      { contractId, methodName }
    );
  }
}

// ============================================================================
// Validation Errors
// ============================================================================

/**
 * Thrown when input validation fails
 */
export class ValidationError extends SorobanError {
  constructor(field: string, value: unknown, reason: string) {
    super(
      `Validation failed for ${field}: ${reason}`,
      "VALIDATION_ERROR",
      false,
      { field, value: String(value), reason }
    );
  }
}

/**
 * Thrown when an address is invalid
 */
export class InvalidAddressError extends SorobanError {
  constructor(address: string, reason?: string) {
    super(
      reason || `Invalid Stellar address: ${address}`,
      "INVALID_ADDRESS",
      false,
      { address, reason }
    );
  }
}

// ============================================================================
// Connection Errors (Retryable)
// ============================================================================

/**
 * Thrown when RPC connection fails
 */
export class RpcConnectionError extends SorobanError {
  constructor(rpcUrl: string, originalError?: Error) {
    super(
      `Failed to connect to RPC at ${rpcUrl}`,
      "RPC_CONNECTION_ERROR",
      true,
      { rpcUrl, originalError: originalError?.message }
    );
  }
}

/**
 * Thrown when there's a rate limit error from RPC
 */
export class RpcRateLimitError extends SorobanError {
  constructor(retryAfterMs?: number) {
    super(
      "RPC rate limit exceeded",
      "RPC_RATE_LIMIT",
      true,
      { retryAfterMs }
    );
  }
}

// ============================================================================
// Escrow-Specific Errors
// ============================================================================

/**
 * Thrown when escrow is not in expected state for operation
 */
export class EscrowStateError extends SorobanError {
  public readonly currentStatus: string;
  public readonly expectedStatus: string | string[];

  constructor(
    escrowAddress: string,
    currentStatus: string,
    expectedStatus: string | string[]
  ) {
    const expected = Array.isArray(expectedStatus) 
      ? expectedStatus.join(" or ") 
      : expectedStatus;
    super(
      `Escrow ${escrowAddress} is in '${currentStatus}' state, expected '${expected}'`,
      "ESCROW_STATE_ERROR",
      false,
      { escrowAddress, currentStatus, expectedStatus }
    );
    this.currentStatus = currentStatus;
    this.expectedStatus = expectedStatus;
  }
}

/**
 * Thrown when escrow has expired
 */
export class EscrowExpiredError extends SorobanError {
  constructor(escrowAddress: string, expiredAt: number) {
    super(
      `Escrow ${escrowAddress} expired at ${new Date(expiredAt * 1000).toISOString()}`,
      "ESCROW_EXPIRED",
      false,
      { escrowAddress, expiredAt }
    );
  }
}

/**
 * Thrown when escrow is not found
 */
export class EscrowNotFoundError extends SorobanError {
  constructor(escrowAddress: string) {
    super(
      `Escrow not found: ${escrowAddress}`,
      "ESCROW_NOT_FOUND",
      false,
      { escrowAddress }
    );
  }
}

// ============================================================================
// Error Factory Functions
// ============================================================================

/**
 * Generic RPC error for unclassified RPC failures
 */
export class GenericRpcError extends SorobanError {
  constructor(rpcUrl: string, rawError: string) {
    super(
      `RPC error: ${rawError}`,
      "RPC_ERROR",
      true,
      { rpcUrl, rawError }
    );
  }
}

/**
 * Create appropriate error from RPC error response
 */
export function createRpcError(rpcUrl: string, error: unknown): SorobanError {
  if (error instanceof Error) {
    if (error.message.includes("ECONNREFUSED") || error.message.includes("ETIMEDOUT")) {
      return new RpcConnectionError(rpcUrl, error);
    }
    if (error.message.includes("rate limit")) {
      return new RpcRateLimitError();
    }
  }
  
  return new GenericRpcError(rpcUrl, String(error));
}

/**
 * Check if an error is retryable
 */
export function isRetryableError(error: unknown): boolean {
  if (error instanceof SorobanError) {
    return error.isRetryable;
  }
  if (error instanceof Error) {
    const retryablePatterns = [
      /ECONNREFUSED/i,
      /ETIMEDOUT/i,
      /rate limit/i,
      /429/i,
      /503/i,
      /timeout/i,
    ];
    return retryablePatterns.some((pattern) => pattern.test(error.message));
  }
  return false;
}
