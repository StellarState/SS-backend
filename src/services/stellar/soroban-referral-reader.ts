import {
  Address,
  Contract,
  Transaction,
  xdr,
  scValToNative,
  rpc as SorobanRpc,
} from "@stellar/stellar-sdk";

import { logger as globalLogger } from "../../observability/logger";
import type { AppLogger } from "../../observability/logger";

export interface ReferralBalanceReader {
  getUnclaimedBalance(wallet: string): Promise<string>;
}

export interface SorobanReferralReaderDependencies {
  /** Referral reward contract ID */
  contractId: string;
  rpcUrl?: string;
  server?: SorobanRpc.Server;
  logger?: AppLogger;
  /** Contract read-only function name for unclaimed balance (default: "unclaimed_balance") */
  functionName?: string;
}

const DEFAULT_UNCLAIMED_BALANCE_FN = "unclaimed_balance";

/**
 * Reads live unclaimed referral reward balances directly from the Soroban
 * referral contract via read-only `simulateTransaction` calls.
 */
export class SorobanReferralReader implements ReferralBalanceReader {
  private readonly contract: Contract;
  private readonly rpcServer?: SorobanRpc.Server;
  private readonly logger: AppLogger;
  private readonly functionName: string;

  constructor(dependencies: SorobanReferralReaderDependencies) {
    if (!dependencies.contractId) {
      throw new Error("contractId is required.");
    }
    this.contract = new Contract(dependencies.contractId);
    this.logger = dependencies.logger ?? globalLogger;
    this.functionName = dependencies.functionName ?? DEFAULT_UNCLAIMED_BALANCE_FN;

    if (dependencies.server) {
      this.rpcServer = dependencies.server;
    } else if (dependencies.rpcUrl) {
      this.rpcServer = new SorobanRpc.Server(dependencies.rpcUrl, {
        allowHttp: dependencies.rpcUrl.startsWith("http://"),
      });
    }
  }

  async getUnclaimedBalance(wallet: string): Promise<string> {
    if (!this.rpcServer) {
      throw new Error("Soroban RPC server is not configured for referral balance reads.");
    }

    const operation = this.contract.call(this.functionName, new Address(wallet).toScVal());
    const stubTx = { toXDR: () => operation.toXDR("base64") } as unknown as Transaction;

    try {
      const simulation = (await this.rpcServer.simulateTransaction(stubTx)) as unknown as {
        results?: Array<{ xdr: string }>;
        result?: { retval?: xdr.ScVal };
      };

      const returnValue =
        simulation.results?.[0]?.xdr !== undefined
          ? xdr.ScVal.fromXDR(simulation.results[0].xdr, "base64")
          : simulation.result?.retval;

      if (!returnValue) return "0";

      const native = scValToNative(returnValue);
      if (native === null || native === undefined || typeof native === "object") {
        return "0";
      }
      return String(native);
    } catch (error) {
      this.logger.warn("Referral unclaimed balance contract read failed", {
        function_name: this.functionName,
        wallet,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }
}

export function createSorobanReferralReader(
  dependencies: SorobanReferralReaderDependencies
): SorobanReferralReader {
  return new SorobanReferralReader(dependencies);
}
