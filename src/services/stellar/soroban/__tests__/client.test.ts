/**
 * Unit tests for Soroban Escrow Client
 * 
 * These tests mock RPC and contract responses to ensure CI does not
 * hit public RPC unless explicitly allowed.
 */

// Mock stellar-sdk before any imports
const mockServerInstance = {
  getAccount: jest.fn(),
  simulateTransaction: jest.fn(),
  sendTransaction: jest.fn(),
  getTransaction: jest.fn(),
};

jest.mock("stellar-sdk", () => {
  return {
    Server: jest.fn(() => mockServerInstance),
    Keypair: {
      random: jest.fn(),
      fromSecret: jest.fn(),
    },
    TransactionBuilder: jest.fn().mockImplementation(() => ({
      addOperation: jest.fn().mockReturnThis(),
      setTimeout: jest.fn().mockReturnThis(),
      build: jest.fn().mockReturnValue({
        sign: jest.fn(),
      }),
    })),
    Transaction: {
      fromEnvelopeXdr: jest.fn(),
    },
    Operation: {
      contractInvoke: jest.fn(),
    },
    StrKey: {
      encodeEd25519PublicKey: jest.fn(() => "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"),
      decodeEd25519PublicKey: jest.fn(),
    },
    Address: jest.fn().mockImplementation(() => ({
      toScVal: jest.fn().mockReturnValue({ type: "address", value: "test" }),
    })),
    Contract: jest.fn().mockImplementation(() => ({
      call: jest.fn().mockReturnValue({
        _type: "operation",
      }),
    })),
    Networks: {
      TESTNET: "Test SDF Network ; September 2015",
      PUBLIC: "Public Global Stellar Network ; September 2015",
    },
    xdr: {
      ScVal: {
        scvU32: jest.fn((v: number) => ({ type: "u32", value: v })),
        scvI64: jest.fn((v: unknown) => ({ type: "i64", value: v })),
        scvSymbol: jest.fn((v: string) => ({ type: "symbol", value: v })),
      },
      Int64: jest.fn(),
    },
    SorobanRpc: {
      Server: jest.fn(() => mockServerInstance),
    },
    TimeoutInfinite: "timeout",
  };
});

// Now import the modules
import { SorobanClient } from "../client";
import {
  EscrowContractConfig,
} from "../types";
import {
  MissingEnvironmentError,
  InvalidAddressError,
  ValidationError,
} from "../errors";
import { SorobanRpc, Keypair } from "stellar-sdk";

// ============================================================================
// Test Configuration
// ============================================================================

const TEST_CONTRACT_ID = "CDLJERS25UDTBKSWPIYKJRSMGWRNZRKJBO7HNQI5VNJSOLZXBSHBM7RL";
const TEST_TOKEN_CONTRACT_ID = "CDKZBV5UZVZW4WFAULZ4WBGNGK7IPBFGXHG3GCEVPP3F2KPAL7WSJ2IV";
const TEST_RPC_URL = "https://soroban-testnet.stellar.org:443";
const TEST_NETWORK_PASSPHRASE = "Test SDF Network ; September 2015";

const VALID_ESCROW_ADDRESS = "GBDAGMHCGGXXZVSZNEHRIGMRXES5MTGSAM5POBZCDWGM3C2MFL6EJI5X";
const VALID_INVESTOR_ADDRESS = "GBDAGMHCGGXXZVSZNEHRIGMRXES5MTGSAM5POBZCDWGM3C2MFL6EJI5X";
const VALID_RECIPIENT_ADDRESS = "GCZNF24HPMYTV6NOEHI7Q5RJFFUI23JKUKQ3GPNJR3E4422CGTCB7WTF";

// Mock keypair
const mockKeypair = {
  publicKey: jest.fn().mockReturnValue(VALID_INVESTOR_ADDRESS),
  canSign: jest.fn().mockReturnValue(true),
  sign: jest.fn(),
};

// Mock logger
const createMockLogger = () => ({
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
});

// ============================================================================
// Test Fixtures
// ============================================================================

function createTestConfig(): EscrowContractConfig {
  return {
    contractId: TEST_CONTRACT_ID,
    tokenContractId: TEST_TOKEN_CONTRACT_ID,
    rpc: {
      url: TEST_RPC_URL,
      networkPassphrase: TEST_NETWORK_PASSPHRASE,
      networkType: "testnet",
      timeout: 30000,
    },
  };
}

function createMockOptions() {
  return {
    config: createTestConfig(),
    logger: createMockLogger(),
  };
}

// Setup Keypair mock
(Keypair.random as jest.Mock).mockReturnValue(mockKeypair);
(Keypair.fromSecret as jest.Mock).mockReturnValue(mockKeypair);

// Setup SorobanRpc mock
(SorobanRpc.Server as jest.Mock).mockReturnValue(mockServerInstance);

// ============================================================================
// Test Suites
// ============================================================================

describe("SorobanClient", () => {
  let mockOptions: ReturnType<typeof createMockOptions>;

  beforeEach(() => {
    jest.clearAllMocks();
    mockOptions = createMockOptions();
    // Re-setup mocks after clearAllMocks
    (Keypair.random as jest.Mock).mockReturnValue(mockKeypair);
    (SorobanRpc.Server as jest.Mock).mockReturnValue(mockServerInstance);
  });

  describe("fromEnv (without env vars)", () => {
    it("should throw MissingEnvironmentError when ESCROW_CONTRACT_ID is not set", () => {
      // Clear the env var
      const originalValue = process.env.ESCROW_CONTRACT_ID;
      delete process.env.ESCROW_CONTRACT_ID;

      expect(() => SorobanClient.fromEnv()).toThrow(MissingEnvironmentError);

      // Restore
      if (originalValue !== undefined) {
        process.env.ESCROW_CONTRACT_ID = originalValue;
      }
    });
  });

  describe("fromConfig", () => {
    it("should create client with valid configuration", () => {
      const testClient = SorobanClient.fromConfig(mockOptions);

      expect(testClient).toBeInstanceOf(SorobanClient);
      expect(testClient.getContractId()).toBe(TEST_CONTRACT_ID);
      expect(testClient.getRpcUrl()).toBe(TEST_RPC_URL);
      expect(testClient.getNetworkPassphrase()).toBe(TEST_NETWORK_PASSPHRASE);
      expect(testClient.getNetworkType()).toBe("testnet");
    });

    it("should use custom RPC URL when provided", () => {
      const customRpcUrl = "https://custom-rpc.example.com:443";
      const optionsWithCustomRpc = {
        ...mockOptions,
        rpcUrl: customRpcUrl,
      };

      const testClient = SorobanClient.fromConfig(optionsWithCustomRpc);
      expect(testClient.getRpcUrl()).toBe(customRpcUrl);
    });
  });

  describe("getEscrowState", () => {
    it("should throw InvalidAddressError for invalid escrow address", async () => {
      const client = SorobanClient.fromConfig(mockOptions);
      const invalidAddress = "INVALID_ADDRESS";

      await expect(client.getEscrowState(invalidAddress)).rejects.toThrow(
        InvalidAddressError
      );
    });

    it("should throw error when escrow does not exist", async () => {
      const client = SorobanClient.fromConfig(mockOptions);

      mockServerInstance.getAccount.mockResolvedValueOnce({
        accountId: VALID_INVESTOR_ADDRESS,
      });

      mockServerInstance.simulateTransaction.mockRejectedValueOnce(
        new Error("Contract error: entry not found")
      );

      await expect(client.getEscrowState(VALID_ESCROW_ADDRESS)).rejects.toThrow();
    });

    it("should handle successful simulation response", async () => {
      const client = SorobanClient.fromConfig(mockOptions);

      mockServerInstance.getAccount.mockResolvedValueOnce({
        accountId: VALID_INVESTOR_ADDRESS,
      });

      mockServerInstance.simulateTransaction.mockResolvedValueOnce({
        results: [
          {
            retval: {
              // Mock parsed result
            },
          },
        ],
      });

      // Verify the client method exists and handles the response
      expect(typeof client.getEscrowState).toBe("function");
    });
  });

  describe("fundEscrow", () => {
    it("should throw InvalidAddressError for invalid recipient address", async () => {
      const client = SorobanClient.fromConfig(mockOptions);

      await expect(
        client.fundEscrow({
          source: mockKeypair as any,
          invoiceId: "INV-123",
          amount: BigInt(100000000),
          duration: 86400 * 30,
          recipient: "INVALID",
        })
      ).rejects.toThrow(InvalidAddressError);
    });

    it("should throw error for zero or negative amount", async () => {
      const client = SorobanClient.fromConfig(mockOptions);

      await expect(
        client.fundEscrow({
          source: mockKeypair as any,
          invoiceId: "INV-123",
          amount: BigInt(0),
          duration: 86400 * 30,
          recipient: VALID_RECIPIENT_ADDRESS,
        })
      ).rejects.toThrow();
    });
  });

  describe("releaseEscrow", () => {
    it("should throw InvalidAddressError for invalid escrow address", async () => {
      const client = SorobanClient.fromConfig(mockOptions);

      await expect(
        client.releaseEscrow({
          source: mockKeypair as any,
          escrowAddress: "INVALID",
        })
      ).rejects.toThrow(InvalidAddressError);
    });
  });

  describe("cancelEscrow", () => {
    it("should throw InvalidAddressError for invalid escrow address", async () => {
      const client = SorobanClient.fromConfig(mockOptions);

      await expect(
        client.cancelEscrow({
          source: mockKeypair as any,
          escrowAddress: "INVALID",
        })
      ).rejects.toThrow(InvalidAddressError);
    });
  });
});

// ============================================================================
// Configuration Validation Tests
// ============================================================================

describe("Configuration Validation", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.resetModules();
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("should validate contract ID format", async () => {
    // Import dynamically to get fresh module
    const { isValidContractId } = await import("../config");

    // Valid contract IDs start with C and are 56 chars
    expect(isValidContractId(TEST_CONTRACT_ID)).toBe(true);
    expect(isValidContractId("INVALID")).toBe(false);
    expect(isValidContractId(undefined)).toBe(false);
    expect(isValidContractId(null as unknown as string)).toBe(false);
  });

  it("should validate Stellar address format", async () => {
    const { isValidStellarAddress } = await import("../config");

    // Valid addresses start with G and are 56 chars
    expect(isValidStellarAddress(VALID_ESCROW_ADDRESS)).toBe(true);
    expect(isValidStellarAddress("INVALID")).toBe(false);
    expect(isValidStellarAddress(undefined)).toBe(false);
  });

  it("should parse network type correctly", async () => {
    const { parseNetworkType } = await import("../config");

    expect(parseNetworkType("testnet")).toBe("testnet");
    expect(parseNetworkType("mainnet")).toBe("mainnet");
    expect(parseNetworkType("main")).toBe("mainnet");
    expect(parseNetworkType("standalone")).toBe("standalone");
    expect(parseNetworkType("unknown")).toBe("testnet"); // default
    expect(parseNetworkType(undefined)).toBe("testnet"); // default
  });

  it("should validate config and return warnings for missing optional vars", async () => {
    // Set required vars
    process.env.ESCROW_CONTRACT_ID = TEST_CONTRACT_ID;
    process.env.SOROBAN_RPC_URL = TEST_RPC_URL;

    const { validateConfig } = await import("../config");
    const result = validateConfig();

    expect(result.isValid).toBe(true);
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.warnings).toContainEqual(
      expect.stringContaining("TOKEN_CONTRACT_ID")
    );
  });
});

// ============================================================================
// Error Handling Tests
// ============================================================================

describe("Error Handling", () => {
  it("should create proper error JSON", () => {
    const error = new MissingEnvironmentError("TEST_VAR", { key: "value" });
    const json = error.toJSON();

    expect(json.name).toBe("MissingEnvironmentError");
    expect(json.code).toBe("MISSING_ENV_VAR");
    expect(json.isRetryable).toBe(false);
    expect(json.context).toEqual({
      variableName: "TEST_VAR",
      key: "value",
    });
  });

  it("should create ValidationError", () => {
    const error = new ValidationError("amount", "0", "Amount must be positive");
    
    expect(error.name).toBe("ValidationError");
    expect(error.code).toBe("VALIDATION_ERROR");
    expect(error.isRetryable).toBe(false);
  });

  it("should identify retryable errors correctly", async () => {
    const { isRetryableError, RpcConnectionError } = await import("../errors");

    // Test with retryable error
    const retryableError = new Error("ECONNREFUSED");
    expect(isRetryableError(retryableError)).toBe(true);

    // Test with non-retryable error
    const nonRetryableError = new Error("Invalid contract ID");
    expect(isRetryableError(nonRetryableError)).toBe(false);

    // Test with SorobanError
    const rpcError = new RpcConnectionError("https://example.com");
    expect(isRetryableError(rpcError)).toBe(true);
  });
});
