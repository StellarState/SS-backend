# Soroban Escrow Client

A typed wrapper for interacting with the Soroban escrow smart contract on Stellar.

## Features

- **Environment-driven configuration**: All settings loaded from environment variables
- **Type-safe contract interface**: Full TypeScript support with typed inputs and outputs
- **Structured error handling**: Detailed, actionable error messages with error codes
- **Isolated and testable**: All Soroban logic contained in service layer, away from Express routes
- **Mock-ready for CI**: Unit tests mock RPC/contract responses; no public RPC hits in CI

## Installation

The module uses the existing `stellar-sdk` package (v11+). No additional dependencies required.

## Environment Variables

### Required

| Variable             | Description                                                   |
| -------------------- | ------------------------------------------------------------- |
| `ESCROW_CONTRACT_ID` | Contract ID of the deployed escrow contract (starts with `C`) |

### Optional

| Variable              | Default         | Description                                         |
| --------------------- | --------------- | --------------------------------------------------- |
| `TOKEN_CONTRACT_ID`   | -               | Contract ID of the token contract                   |
| `STELLAR_NETWORK`     | `testnet`       | Network type: `testnet`, `mainnet`, or `standalone` |
| `SOROBAN_RPC_URL`     | Network default | Soroban RPC endpoint URL                            |
| `SOROBAN_RPC_TIMEOUT` | `30000`         | RPC timeout in milliseconds                         |

### Network Defaults

| Network    | RPC URL                                   |
| ---------- | ----------------------------------------- |
| Testnet    | `https://soroban-testnet.stellar.org:443` |
| Mainnet    | `https://soroban.stellar.org:443`         |
| Standalone | `http://localhost:8000`                   |

## Usage

### Basic Setup

```typescript
import { SorobanClient, validateConfig } from "./services/stellar/soroban";

// Validate configuration on startup
const validation = validateConfig();
if (!validation.isValid) {
  console.error("Configuration errors:", validation.errors);
  console.warn("Warnings:", validation.warnings);
}

// Create client from environment
const client = SorobanClient.fromEnv();

// Or with custom configuration
import { SorobanClient, EscrowContractConfig } from "./services/stellar/soroban";

const config: EscrowContractConfig = {
  contractId: process.env.ESCROW_CONTRACT_ID!,
  tokenContractId: process.env.TOKEN_CONTRACT_ID || "",
  rpc: {
    url: process.env.SOROBAN_RPC_URL || "https://soroban-testnet.stellar.org:443",
    networkPassphrase: "Test SDF Network ; September 2015",
    networkType: "testnet",
  },
};

const client = SorobanClient.fromConfig({ config });
```

### Read Escrow State

```typescript
import { SorobanClient } from "./services/stellar/soroban";

const client = SorobanClient.fromEnv();

try {
  const state = await client.getEscrowState(
    "GXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX"
  );

  console.log("Escrow Status:", state.status);
  console.log("Amount:", (state.amount / BigInt(10000000)).toString(), "XLM");
  console.log("Expires:", new Date(state.expiresAt * 1000).toISOString());
} catch (error) {
  if (error instanceof EscrowNotFoundError) {
    console.log("Escrow not found");
  } else if (error instanceof EscrowExpiredError) {
    console.log("Escrow has expired");
  }
}
```

### Fund an Escrow

```typescript
import { SorobanClient } from "./services/stellar/soroban";
import { Keypair } from "stellar-sdk";

const client = SorobanClient.fromEnv();

// Load platform keypair from secret
const platformKeypair = Keypair.fromSecret(process.env.PLATFORM_SECRET_KEY!);

const result = await client.fundEscrow({
  source: platformKeypair,
  invoiceId: "INV-123",
  amount: BigInt(100000000), // 10 XLM in stroops
  duration: 86400 * 30, // 30 days in seconds
  recipient: "GXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
});

if (result.success) {
  console.log("Funded! TX:", result.txHash);
} else {
  console.error("Funding failed:", result.error);
}
```

### Release Funds

```typescript
const result = await client.releaseEscrow({
  source: platformKeypair,
  escrowAddress: "GXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
  // amount: BigInt(50000000), // Optional: partial release
});

if (result.success) {
  console.log("Released! TX:", result.txHash);
}
```

### Cancel Escrow

```typescript
const result = await client.cancelEscrow({
  source: platformKeypair,
  escrowAddress: "GXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
});
```

## Error Handling

All errors extend `SorobanError` and include:

- `code`: Machine-readable error code (e.g., `MISSING_ENV_VAR`, `ESCROW_STATE_ERROR`)
- `isRetryable`: Whether the operation can be retried
- `context`: Additional debugging information

```typescript
import {
  SorobanError,
  MissingEnvironmentError,
  EscrowStateError,
  isRetryableError,
} from "./services/stellar/soroban";

try {
  await client.fundEscrow(params);
} catch (error) {
  if (error instanceof MissingEnvironmentError) {
    // Configuration issue - fix env vars
  } else if (error instanceof EscrowStateError) {
    // Invalid escrow state for operation
    console.log(`Expected: ${error.expectedStatus}, Got: ${error.currentStatus}`);
  }

  if (isRetryableError(error)) {
    // Retry with backoff
  }
}
```

## Contract Interface

### Contract Methods

| Method        | Description                | Auth Required |
| ------------- | -------------------------- | ------------- |
| `init`        | Initialize a new escrow    | Yes (source)  |
| `fund`        | Fund an escrow with XLM    | Yes (source)  |
| `release`     | Release funds to recipient | Yes (admin)   |
| `cancel`      | Cancel and refund investor | Yes (admin)   |
| `get_state`   | Read current escrow state  | No            |
| `get_balance` | Get escrow balance         | No            |

### Escrow Status Values

- `pending` - Created but not yet funded
- `funded` - Funds are in escrow
- `released` - Funds have been released to recipient
- `cancelled` - Escrow was cancelled, funds returned
- `expired` - Escrow has passed its expiry time

## Security Assumptions

When integrating with this client, be aware of the following security assumptions:

1. **Admin operations**: `fundEscrow`, `releaseEscrow`, and `cancelEscrow` require a trusted platform keypair
2. **Oracle/price data**: Trusted and validated by contract logic (not by this client)
3. **Contract trust**: The contract itself enforces release conditions
4. **Network validation**: The client validates contract IDs but not contract code

## Testing

```bash
# Run unit tests (mocks RPC responses)
npm test

# Run with coverage
npm test -- --coverage

# Run type-check
npm run type-check
```

### Writing Tests

The client is designed to be easily mockable:

```typescript
import { SorobanClient } from "./services/stellar/soroban";
import { EscrowContractConfig } from "./services/stellar/soroban/types";

// Create test configuration
const testConfig: EscrowContractConfig = {
  contractId: "C...",
  tokenContractId: "C...",
  rpc: {
    url: "http://localhost:8000", // Local Futurenet
    networkPassphrase: "Test SDF Network ; September 2015",
    networkType: "testnet",
  },
};

// Use custom logger for test assertions
const mockLogger = {
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
};

const client = SorobanClient.fromConfig({
  config: testConfig,
  logger: mockLogger,
});
```

## Contract Source

The escrow contract source is maintained in a separate repository:

- **Repository**: [StellarState/SS-contracts](https://github.com/StellarState/SS-contracts)
- **Wasm Hash**: See contract deployment documentation
- **ABI**: Available in contract repository

## License

MIT
