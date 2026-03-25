/**
 * Soroban Escrow Client Module
 * 
 * This module provides a typed interface for interacting with the Soroban
 * escrow smart contract on Stellar.
 * 
 * ## Environment Variables
 * 
 * Required:
 * - `ESCROW_CONTRACT_ID` - The contract ID of the escrow contract
 * 
 * Optional:
 * - `TOKEN_CONTRACT_ID` - The contract ID of the token contract
 * - `STELLAR_NETWORK` - Network type: testnet (default), mainnet, standalone
 * - `SOROBAN_RPC_URL` - Soroban RPC URL (defaults based on network)
 * - `SOROBAN_RPC_TIMEOUT` - RPC timeout in milliseconds
 * 
 * ## Usage
 * 
 * ```typescript
 * import { 
 *   SorobanClient, 
 *   EscrowContractConfig,
 *   validateConfig 
 * } from './services/stellar/soroban';
 * 
 * // Validate configuration on startup
 * const validation = validateConfig();
 * if (!validation.isValid) {
 *   console.error('Configuration errors:', validation.errors);
 * }
 * 
 * // Initialize client
 * const client = SorobanClient.fromEnv();
 * 
 * // Read escrow state
 * const state = await client.getEscrowState('GXXX...');
 * 
 * // Fund escrow
 * const result = await client.fundEscrow({
 *   source: platformKeypair,
 *   invoiceId: 'INV-123',
 *   amount: BigInt(100000000),
 *   duration: 86400 * 30,
 *   recipient: 'GXXX...',
 * });
 * ```
 * 
 * ## Security Assumptions
 * 
 * - Admin operations require a trusted platform keypair
 * - The contract itself enforces fund release conditions
 * - Price/oracle data is trusted and validated by contract logic
 * 
 * @module stellar/soroban
 */

// Re-export all public types and classes
export { SorobanClient } from "./client";
export { SorobanError, isRetryableError } from "./errors";

// Configuration
export {
  buildEscrowConfig,
  buildRpcConfig,
  validateConfig,
  parseNetworkType,
  isValidContractId,
  isValidStellarAddress,
  isValidRpcUrl,
  type ValidationResult,
} from "./config";

// Types
export type {
  NetworkType,
  SorobanRpcConfig,
  EscrowContractConfig,
  EscrowStatus,
  EscrowState,
  FundEscrowParams,
  ReleaseEscrowParams,
  CancelEscrowParams,
  CreateEscrowParams,
  ContractInvocationResult,
  EscrowCreationResult,
  EscrowFundingResult,
  SorobanClientOptions,
} from "./types";

// Error types for specific error handling
export {
  MissingEnvironmentError,
  InvalidContractIdError,
  InvalidNetworkError,
  InvalidRpcUrlError,
  InvalidNetworkPassphraseError,
  TransactionError,
  SimulationError,
  InsufficientResourcesError,
  TransactionTimeoutError,
  ContractInvocationError,
  ContractError,
  MethodNotFoundError,
  ValidationError,
  InvalidAddressError,
  RpcConnectionError,
  RpcRateLimitError,
  EscrowStateError,
  EscrowExpiredError,
  EscrowNotFoundError,
  createRpcError,
} from "./errors";

// Default configuration for convenience
export { NETWORK_CONFIGS, DEFAULT_RPC_URLS } from "./config";
