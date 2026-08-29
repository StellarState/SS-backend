import { Address, scValToNative } from "stellar-sdk";
import {
  InvoiceEscrowContractError,
  InvoiceEscrowContractService,
} from "../../../../src/services/stellar/invoice-escrow-contract.service";
import type { AppLogger } from "../../../../src/observability/logger";

describe("InvoiceEscrowContractService", () => {
  const ESCROW_CONTRACT_ID = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM";
  const TEST_SELLER = "GBZXN7PIRZGNMHGA7MUUUF4GWPY5AYPV6LY4UV2GL6VJGIQRXFDNMADI";
  const TEST_TOKEN = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";
  const TEST_INVOICE_ID = "INV-2026-001";
  const TEST_AMOUNT_STROOPS = 500_000_000n;
  const TEST_DUE_DATE = 1770000000;

  let mockLogger: AppLogger;
  let service: InvoiceEscrowContractService;

  beforeEach(() => {
    mockLogger = {
      debug: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      child: jest.fn().mockReturnThis(),
    };

    service = new InvoiceEscrowContractService({
      contractId: ESCROW_CONTRACT_ID,
      logger: mockLogger,
    });
  });

  describe("Constructor & Initialization", () => {
    it("should initialize correctly with options object", () => {
      expect(service.contractId).toBe(ESCROW_CONTRACT_ID);
    });

    it("should initialize correctly with string contract ID", () => {
      const stringInitService = new InvoiceEscrowContractService(ESCROW_CONTRACT_ID, mockLogger);
      expect(stringInitService.contractId).toBe(ESCROW_CONTRACT_ID);
    });

    it("should throw error if contractId is empty", () => {
      expect(() => new InvoiceEscrowContractService("")).toThrow("contractId is required.");
      expect(() => new InvoiceEscrowContractService({ contractId: "" })).toThrow(
        "contractId is required."
      );
    });

    it("should reject an invalid RPC timeout", () => {
      expect(
        () =>
          new InvoiceEscrowContractService({
            contractId: ESCROW_CONTRACT_ID,
            rpcTimeoutMs: 0,
          })
      ).toThrow("rpcTimeoutMs must be a positive integer.");
    });
  });

  describe("buildCreateEscrowTx", () => {
    it("should construct valid create_escrow host function invocation", () => {
      const op = service.buildCreateEscrowTx(
        TEST_INVOICE_ID,
        TEST_SELLER,
        TEST_AMOUNT_STROOPS,
        TEST_DUE_DATE,
        TEST_TOKEN
      );

      expect(op.body().switch().name).toBe("invokeHostFunction");
      const invokeContractArgs = op.body().invokeHostFunctionOp().hostFunction().invokeContract();

      expect(invokeContractArgs.functionName().toString()).toBe("create_escrow");

      const args = invokeContractArgs.args();
      expect(args).toHaveLength(5);

      // Argument 0: invoiceId (Symbol)
      expect(scValToNative(args[0])).toBe(TEST_INVOICE_ID);

      // Argument 1: sellerAddress (Address)
      expect(Address.fromScVal(args[1]).toString()).toBe(TEST_SELLER);

      // Argument 2: amount (i128)
      expect(BigInt(scValToNative(args[2]))).toBe(TEST_AMOUNT_STROOPS);

      // Argument 3: dueDate (u64)
      expect(Number(scValToNative(args[3]))).toBe(TEST_DUE_DATE);

      // Argument 4: paymentTokenAddress (Address)
      expect(Address.fromScVal(args[4]).toString()).toBe(TEST_TOKEN);
    });
  });

  describe("createEscrowOnChain - Structured Logging", () => {
    it("should record a structured log entry on escrow creation success", async () => {
      const result = await service.createEscrowOnChain({
        invoiceId: TEST_INVOICE_ID,
        sellerAddress: TEST_SELLER,
        amountStroops: TEST_AMOUNT_STROOPS,
        dueDateTimestamp: TEST_DUE_DATE,
        paymentTokenAddress: TEST_TOKEN,
      });

      expect(result).toBeDefined();
      expect(result.contractId).toBe(ESCROW_CONTRACT_ID);
      expect(result.invoiceId).toBe(TEST_INVOICE_ID);
      expect(result.sellerAddress).toBe(TEST_SELLER);
      expect(result.amountStroops).toBe(TEST_AMOUNT_STROOPS.toString());

      // Verify logger.info was called with exact structured metadata
      expect(mockLogger.info).toHaveBeenCalledWith(
        "Soroban escrow created successfully on-chain.",
        {
          invoiceId: TEST_INVOICE_ID,
          sorobanContractId: ESCROW_CONTRACT_ID,
          sellerAddress: TEST_SELLER,
          amountStroops: TEST_AMOUNT_STROOPS.toString(),
        }
      );
    });

    it("should never leak secret keys or sensitive tokens into logs", async () => {
      const secretLikeToken = "SXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX";

      await service.createEscrowOnChain({
        invoiceId: TEST_INVOICE_ID,
        sellerAddress: TEST_SELLER,
        amountStroops: "1000000",
        dueDateTimestamp: TEST_DUE_DATE,
        paymentTokenAddress: TEST_TOKEN,
      });

      const logCalls = (mockLogger.info as jest.Mock).mock.calls;
      expect(logCalls.length).toBeGreaterThan(0);

      const loggedMetadata = logCalls[0][1];
      const metadataString = JSON.stringify(loggedMetadata);

      expect(metadataString).not.toContain(secretLikeToken);
      expect(loggedMetadata).toEqual({
        invoiceId: TEST_INVOICE_ID,
        sorobanContractId: ESCROW_CONTRACT_ID,
        sellerAddress: TEST_SELLER,
        amountStroops: "1000000",
      });
    });
  });

  describe("buildFundEscrowTx", () => {
    it("should construct valid fund_escrow host function invocation", () => {
      const op = service.buildFundEscrowTx(TEST_INVOICE_ID, TEST_SELLER, TEST_AMOUNT_STROOPS);
      expect(op.body().switch().name).toBe("invokeHostFunction");
      const invokeContractArgs = op.body().invokeHostFunctionOp().hostFunction().invokeContract();

      expect(invokeContractArgs.functionName().toString()).toBe("fund_escrow");
      const args = invokeContractArgs.args();
      expect(args).toHaveLength(3);
      expect(scValToNative(args[0])).toBe(TEST_INVOICE_ID);
      expect(Address.fromScVal(args[1]).toString()).toBe(TEST_SELLER);
      expect(BigInt(scValToNative(args[2]))).toBe(TEST_AMOUNT_STROOPS);
    });

    it("should reject non-positive and unsafe amounts", () => {
      expect(() => service.buildFundEscrowTx(TEST_INVOICE_ID, TEST_SELLER, 0)).toThrow(
        expect.objectContaining({ code: "invalid_amount" })
      );
      expect(() =>
        service.buildFundEscrowTx(TEST_INVOICE_ID, TEST_SELLER, Number.MAX_SAFE_INTEGER + 1)
      ).toThrow(expect.objectContaining({ code: "invalid_amount" }));
    });
  });

  describe("buildRecordPaymentTx", () => {
    it("should construct valid record_payment host function invocation", () => {
      const op = service.buildRecordPaymentTx(TEST_INVOICE_ID, TEST_SELLER, TEST_AMOUNT_STROOPS);
      const invokeContractArgs = op.body().invokeHostFunctionOp().hostFunction().invokeContract();

      expect(invokeContractArgs.functionName().toString()).toBe("record_payment");
      const args = invokeContractArgs.args();
      expect(args).toHaveLength(3);
      expect(scValToNative(args[0])).toBe(TEST_INVOICE_ID);
    });
  });

  describe("buildSettleEscrowTx", () => {
    it("should construct valid settle_escrow host function invocation", () => {
      const op = service.buildSettleEscrowTx(TEST_INVOICE_ID);
      const invokeContractArgs = op.body().invokeHostFunctionOp().hostFunction().invokeContract();

      expect(invokeContractArgs.functionName().toString()).toBe("settle_escrow");
      const args = invokeContractArgs.args();
      expect(args).toHaveLength(1);
      expect(scValToNative(args[0])).toBe(TEST_INVOICE_ID);
    });

    it("should reject empty invoice ids", () => {
      expect(() => service.buildSettleEscrowTx("  ")).toThrow(
        expect.objectContaining({ code: "invalid_invoice_id" })
      );
    });
  });

  describe("RPC simulation and submission", () => {
    it("should simulate transaction via RPC server", async () => {
      const mockServer = {
        simulateTransaction: jest.fn().mockResolvedValue({
          minResourceFee: "100",
          cost: { cpuInsns: "1000", memBytes: "2000" },
          results: [{ xdr: "AAAA==" }],
        }),
      } as any;

      const rpcService = new InvoiceEscrowContractService({
        contractId: ESCROW_CONTRACT_ID,
        server: mockServer,
      });

      const res = await rpcService.simulateTransaction({} as any);
      expect(res.minResourceFee).toBe("100");
      expect(mockServer.simulateTransaction).toHaveBeenCalled();
    });

    it("should submit transaction via RPC server", async () => {
      const mockServer = {
        sendTransaction: jest.fn().mockResolvedValue({
          status: "PENDING",
          hash: "abc123hash",
        }),
      } as any;

      const rpcService = new InvoiceEscrowContractService({
        contractId: ESCROW_CONTRACT_ID,
        server: mockServer,
      });

      const res = await rpcService.submitTransaction({} as any);
      expect(res.status).toBe("PENDING");
      expect(res.txHash).toBe("abc123hash");
    });

    it("should wrap and log RPC failures without exposing implementation errors", async () => {
      const mockServer = {
        simulateTransaction: jest.fn().mockRejectedValue(new Error("socket reset by peer")),
      } as any;
      const rpcService = new InvoiceEscrowContractService({
        contractId: ESCROW_CONTRACT_ID,
        server: mockServer,
        logger: mockLogger,
      });

      await expect(rpcService.simulateTransaction({} as any)).rejects.toMatchObject({
        code: "rpc_request_failed",
        message: "Soroban RPC simulation failed.",
      });
      expect(mockLogger.error).toHaveBeenCalledWith(
        "Soroban RPC request failed.",
        expect.objectContaining({ operation: "simulation" })
      );
    });

    it("should time out stalled RPC requests", async () => {
      jest.useFakeTimers();
      const mockServer = {
        sendTransaction: jest.fn(() => new Promise(() => undefined)),
      } as any;
      const rpcService = new InvoiceEscrowContractService({
        contractId: ESCROW_CONTRACT_ID,
        server: mockServer,
        logger: mockLogger,
        rpcTimeoutMs: 25,
      });

      const submissionError = rpcService.submitTransaction({} as any).catch((error) => error);
      await jest.advanceTimersByTimeAsync(25);

      const error = await submissionError;
      expect(error).toBeInstanceOf(InvoiceEscrowContractError);
      expect(error).toMatchObject({ code: "rpc_timeout" });
      jest.useRealTimers();
    });
  });
});
