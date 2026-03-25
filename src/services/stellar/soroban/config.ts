/**
 * Environment configuration for Soroban Escrow operations
 * 
 * Reads configuration from environment variables with validation.
 * Throws structured errors if misconfigured.
 */

import { SorobanRpcConfig, EscrowContractConfig, NetworkType } from "./types";
import {
  MissingEnvironmentError,
  InvalidContractIdError,
  InvalidRpcUrlError,
} from "./errors";

// ============================================================================
// Network Configurations
// ============================================================================

const NETWORK_CONFIGS: Record<NetworkType, Omit<SorobanRpcConfig, "url" | "timeout">> = {
  testnet: {
    networkPassphrase: "Test SDF Network ; September 2015",
    networkType: "testnet",
  },
  mainnet: {
    networkPassphrase: "Public Global Stellar Network ; September 2015",
    networkType: "mainnet",
  },
  standalone: {
    networkPassphrase: "Standalone Network ; February 2017",
    networkType: "standalone",
  },
};

const DEFAULT_RPC_URLS: Record<NetworkType, string> = {
  testnet: "https://soroban-testnet.stellar.org:443",
  mainnet: "https://soroban.stellar.org:443",
  standalone: "http://localhost:8000",
};

// ============================================================================
// Environment Variable Names
// ============================================================================

const ENV_VARS = {
  ESCROW_CONTRACT_ID: "ESCROW_CONTRACT_ID",
  TOKEN_CONTRACT_ID: "TOKEN_CONTRACT_ID",
  STELLAR_NETWORK: "STELLAR_NETWORK",
  SOROBAN_RPC_URL: "SOROBAN_RPC_URL",
  SOROBAN_RPC_TIMEOUT: "SOROBAN_RPC_TIMEOUT",
} as const;

// ============================================================================
// Validation Functions
// ============================================================================

/**
 * Validate contract ID format (starts with C and is 56 characters)
 */
export function isValidContractId(contractId: string | undefined): boolean {
  if (!contractId || typeof contractId !== "string") {
    return false;
  }
  // Contract IDs on Stellar are base32-encoded and start with 'C'
  // They are 56 characters long
  return /^[C][A-Z0-9]{55}$/.test(contractId);
}

/**
 * Validate Stellar address format
 */
export function isValidStellarAddress(address: string | undefined): boolean {
  if (!address || typeof address !== "string") {
    return false;
  }
  // G... or M... for muxed accounts
  return /^(G|M)[A-Z0-9]{55}$/.test(address);
}

/**
 * Validate RPC URL format
 */
export function isValidRpcUrl(url: string | undefined): boolean {
  if (!url || typeof url !== "string") {
    return false;
  }
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * Parse and validate network type from string
 */
export function parseNetworkType(value: string | undefined): NetworkType {
  if (!value) {
    return "testnet"; // Default to testnet
  }
  const normalized = value.toLowerCase().trim();
  if (normalized === "mainnet" || normalized === "main") {
    return "mainnet";
  }
  if (normalized === "standalone" || normalized === "local") {
    return "standalone";
  }
  return "testnet";
}

/**
 * Parse timeout value from environment
 */
export function parseTimeout(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }
  const parsed = parseInt(value, 10);
  if (isNaN(parsed) || parsed <= 0) {
    return undefined;
  }
  return Math.min(parsed, 60000); // Cap at 60 seconds
}

// ============================================================================
// Configuration Builders
// ============================================================================

/**
 * Build RPC configuration from environment
 */
export function buildRpcConfig(): SorobanRpcConfig {
  const networkType = parseNetworkType(process.env[ENV_VARS.STELLAR_NETWORK]);
  const networkConfig = NETWORK_CONFIGS[networkType];
  
  // Get RPC URL - either from explicit env var or default for network
  const rpcUrl = process.env[ENV_VARS.SOROBAN_RPC_URL];
  const finalRpcUrl = rpcUrl?.trim() || DEFAULT_RPC_URLS[networkType];
  
  // Validate RPC URL
  if (!isValidRpcUrl(finalRpcUrl)) {
    throw new InvalidRpcUrlError(finalRpcUrl, "RPC URL format is invalid");
  }
  
  // Parse timeout
  const timeout = parseTimeout(process.env[ENV_VARS.SOROBAN_RPC_TIMEOUT]);
  
  return {
    url: finalRpcUrl,
    networkPassphrase: networkConfig.networkPassphrase,
    networkType,
    timeout,
  };
}

/**
 * Build full escrow contract configuration from environment
 */
export function buildEscrowConfig(): EscrowContractConfig {
  const contractId = process.env[ENV_VARS.ESCROW_CONTRACT_ID];
  const tokenContractId = process.env[ENV_VARS.TOKEN_CONTRACT_ID];
  
  // Validate escrow contract ID
  if (!contractId) {
    throw new MissingEnvironmentError(ENV_VARS.ESCROW_CONTRACT_ID);
  }
  if (!isValidContractId(contractId)) {
    throw new InvalidContractIdError(contractId, "ESCROW_CONTRACT_ID format is invalid");
  }
  
  // Validate token contract ID (optional warning)
  if (tokenContractId && !isValidContractId(tokenContractId)) {
    throw new InvalidContractIdError(tokenContractId, "TOKEN_CONTRACT_ID format is invalid");
  }
  
  // Build RPC config
  const rpc = buildRpcConfig();
  
  return {
    contractId,
    tokenContractId: tokenContractId || "", // Optional
    rpc,
  };
}

// ============================================================================
// Configuration Validation
// ============================================================================

export interface ValidationResult {
  isValid: boolean;
  errors: string[];
  warnings: string[];
}

/**
 * Validate complete configuration and return detailed results
 */
export function validateConfig(): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  
  // Check required variables
  if (!process.env[ENV_VARS.ESCROW_CONTRACT_ID]) {
    errors.push(`Missing required: ${ENV_VARS.ESCROW_CONTRACT_ID}`);
  } else if (!isValidContractId(process.env[ENV_VARS.ESCROW_CONTRACT_ID])) {
    errors.push(`${ENV_VARS.ESCROW_CONTRACT_ID} format is invalid`);
  }
  
  // Check optional variables and warn
  if (!process.env[ENV_VARS.TOKEN_CONTRACT_ID]) {
    warnings.push(`${ENV_VARS.TOKEN_CONTRACT_ID} not set - some features may be unavailable`);
  } else if (!isValidContractId(process.env[ENV_VARS.TOKEN_CONTRACT_ID])) {
    warnings.push(`${ENV_VARS.TOKEN_CONTRACT_ID} format looks incorrect`);
  }
  
  // Check RPC URL
  const networkType = parseNetworkType(process.env[ENV_VARS.STELLAR_NETWORK]);
  const rpcUrl = process.env[ENV_VARS.SOROBAN_RPC_URL] || DEFAULT_RPC_URLS[networkType];
  
  if (!isValidRpcUrl(rpcUrl)) {
    errors.push(`RPC URL format is invalid: ${rpcUrl}`);
  }
  
  // Warn about testnet usage in production
  if (process.env.NODE_ENV === "production" && networkType !== "mainnet") {
    warnings.push(
      `Using ${networkType} in production environment - ensure this is intentional`
    );
  }
  
  // Warn about missing platform secret key
  if (!process.env.PLATFORM_SECRET_KEY) {
    warnings.push("PLATFORM_SECRET_KEY not set - cannot sign transactions");
  }
  
  return {
    isValid: errors.length === 0,
    errors,
    warnings,
  };
}

// ============================================================================
// Convenience Exports
// ============================================================================

export { ENV_VARS, NETWORK_CONFIGS, DEFAULT_RPC_URLS };
