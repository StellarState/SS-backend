/**
 * TypeScript interfaces for Soroban Escrow Contract
 * 
 * These types define the contract surface for wave 1 operations.
 * Align with your actual contract ABI and interface spec.
 */

import { Keypair, xdr } from "stellar-sdk";

// ============================================================================
// Network Configuration Types
// ============================================================================

export type NetworkType = "testnet" | "mainnet" | "standalone";

export interface SorobanRpcConfig {
  url: string;
  networkPassphrase: string;
  networkType: NetworkType;
  timeout?: number;
}

export interface EscrowContractConfig {
  contractId: string;
  tokenContractId: string;
  rpc: SorobanRpcConfig;
}

// ============================================================================
// Escrow State Types
// ============================================================================

export type EscrowStatus = "pending" | "funded" | "released" | "cancelled" | "expired";

export interface EscrowState {
  /** Escrow account address */
  escrowAddress: string;
  /** Investor's Stellar address */
  investor: string;
  /** Platform's Stellar address (admin) */
  platform: string;
  /** Invoice recipient's Stellar address */
  recipient: string;
  /** Escrowed amount in stroops (1 XLM = 10,000,000 stroops) */
  amount: bigint;
  /** Status of the escrow */
  status: EscrowStatus;
  /** Unix timestamp when escrow was created */
  createdAt: number;
  /** Unix timestamp when escrow expires (0 if no expiry) */
  expiresAt: number;
  /** Invoice ID associated with this escrow */
  invoiceId: string;
  /** Transaction hash of funding transaction */
  fundingTxHash?: string;
  /** Transaction hash of release transaction */
  releaseTxHash?: string;
}

// ============================================================================
// Contract Method Parameter Types
// ============================================================================

export interface FundEscrowParams {
  /** Source account keypair for signing */
  source: Keypair;
  /** Invoice ID to associate with escrow */
  invoiceId: string;
  /** Amount to fund in stroops */
  amount: bigint;
  /** Duration in seconds until escrow expires */
  duration: number;
  /** Recipient's Stellar address */
  recipient: string;
}

export interface ReleaseEscrowParams {
  /** Source account keypair for signing */
  source: Keypair;
  /** Escrow account address */
  escrowAddress: string;
  /** Optional amount to release (full amount if not specified) */
  amount?: bigint;
}

export interface CancelEscrowParams {
  /** Source account keypair for signing */
  source: Keypair;
  /** Escrow account address */
  escrowAddress: string;
}

export interface CreateEscrowParams {
  /** Source account keypair for signing */
  source: Keypair;
  /** Investor's Stellar address */
  investor: string;
  /** Invoice ID to associate with escrow */
  invoiceId: string;
  /** Duration in seconds until escrow expires */
  duration: number;
}

// ============================================================================
// Contract Method Return Types
// ============================================================================

export interface ContractInvocationResult {
  /** Whether the invocation was successful */
  success: boolean;
  /** Transaction hash if successful */
  txHash?: string;
  /** Return value if any */
  returnValue?: xdr.ScVal;
  /** Error message if failed */
  error?: string;
}

export interface EscrowCreationResult extends ContractInvocationResult {
  /** The new escrow's Stellar address */
  escrowAddress?: string;
}

export interface EscrowFundingResult extends ContractInvocationResult {
  /** The amount funded */
  amount?: bigint;
}

// ============================================================================
// Soroban Client Options
// ============================================================================

export interface SorobanClientOptions {
  /** Contract configuration */
  config: EscrowContractConfig;
  /** Optional logger for debugging */
  logger?: {
    debug: (message: string, ...args: unknown[]) => void;
    info: (message: string, ...args: unknown[]) => void;
    warn: (message: string, ...args: unknown[]) => void;
    error: (message: string, ...args: unknown[]) => void;
  };
  /** Custom RPC URL override */
  rpcUrl?: string;
}

// ============================================================================
// XDR Value Types for Contract Interface
// ============================================================================

export interface EscrowInitParams {
  investor: string;
  platform: string;
  duration: number;
  invoice_id: string;
}

export interface EscrowData {
  investor: string;
  platform: string;
  recipient: string;
  amount: bigint;
  status: EscrowStatus;
  created_at: bigint;
  expires_at: bigint;
  invoice_id: string;
}
