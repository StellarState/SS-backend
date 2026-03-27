import "dotenv/config";
import { Networks } from "stellar-sdk";

type SupportedStellarNetwork = "testnet" | "mainnet" | "futurenet";

export interface AppConfig {
  port: number;
  nodeEnv: string;
  jwt: {
    secret: string;
    expiresIn: string;
  };
  auth: {
    challengeTtlMs: number;
  };
  observability: {
    metricsEnabled: boolean;
  };
  reconciliation: {
    enabled: boolean;
    intervalMs: number;
    batchSize: number;
    gracePeriodMs: number;
    maxRuntimeMs: number;
  };
  stellar: {
    network: SupportedStellarNetwork;
    networkPassphrase: string;
  };
}

const DEFAULT_PORT = 3000;
const DEFAULT_JWT_EXPIRES_IN = "15m";
const DEFAULT_CHALLENGE_TTL_MS = 5 * 60 * 1000;
const DEFAULT_METRICS_ENABLED = true;
const DEFAULT_RECONCILIATION_ENABLED = false;
const DEFAULT_RECONCILIATION_INTERVAL_MS = 30 * 1000;
const DEFAULT_RECONCILIATION_BATCH_SIZE = 25;
const DEFAULT_RECONCILIATION_GRACE_PERIOD_MS = 60 * 1000;
const DEFAULT_RECONCILIATION_MAX_RUNTIME_MS = 10 * 1000;

function parsePort(value: string | undefined): number {
  if (!value) {
    return DEFAULT_PORT;
  }

  const port = Number(value);

  if (!Number.isInteger(port) || port <= 0) {
    throw new Error("PORT must be a positive integer.");
  }

  return port;
}

function parsePositiveInteger(
  value: string | undefined,
  fallback: number,
  name: string,
): number {
  if (!value) {
    return fallback;
  }

  const parsedValue = Number(value);

  if (!Number.isInteger(parsedValue) || parsedValue <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }

  return parsedValue;
}

function parseChallengeTtl(value: string | undefined): number {
  return parsePositiveInteger(
    value,
    DEFAULT_CHALLENGE_TTL_MS,
    "AUTH_CHALLENGE_TTL_MS",
  );
}

function parseBoolean(
  value: string | undefined,
  fallback: boolean,
  name: string,
): boolean {
  if (!value) {
    return fallback;
  }

  switch (value.toLowerCase()) {
    case "true":
    case "1":
    case "yes":
    case "on":
      return true;
    case "false":
    case "0":
    case "no":
    case "off":
      return false;
    default:
      throw new Error(`${name} must be a boolean.`);
  }
}

function resolveNetwork(network: string | undefined): AppConfig["stellar"] {
  switch ((network ?? "testnet").toLowerCase()) {
    case "testnet":
      return {
        network: "testnet",
        networkPassphrase: Networks.TESTNET,
      };
    case "mainnet":
    case "public":
      return {
        network: "mainnet",
        networkPassphrase: Networks.PUBLIC,
      };
    case "futurenet":
      return {
        network: "futurenet",
        networkPassphrase: Networks.FUTURENET,
      };
    default:
      throw new Error(
        "STELLAR_NETWORK must be one of: testnet, mainnet, public, futurenet.",
      );
  }
}

function requireString(value: string | undefined, name: string): string {
  if (!value) {
    throw new Error(`${name} is required.`);
  }

  return value;
}

export function getConfig(): AppConfig {
  return {
    port: parsePort(process.env.PORT),
    nodeEnv: process.env.NODE_ENV ?? "development",
    jwt: {
      secret: requireString(process.env.JWT_SECRET, "JWT_SECRET"),
      expiresIn: process.env.JWT_EXPIRES_IN ?? DEFAULT_JWT_EXPIRES_IN,
    },
    auth: {
      challengeTtlMs: parseChallengeTtl(process.env.AUTH_CHALLENGE_TTL_MS),
    },
    observability: {
      metricsEnabled: parseBoolean(
        process.env.METRICS_ENABLED,
        DEFAULT_METRICS_ENABLED,
        "METRICS_ENABLED",
      ),
    },
    reconciliation: {
      enabled: parseBoolean(
        process.env.STELLAR_RECONCILIATION_ENABLED,
        DEFAULT_RECONCILIATION_ENABLED,
        "STELLAR_RECONCILIATION_ENABLED",
      ),
      intervalMs: parsePositiveInteger(
        process.env.STELLAR_RECONCILIATION_INTERVAL_MS,
        DEFAULT_RECONCILIATION_INTERVAL_MS,
        "STELLAR_RECONCILIATION_INTERVAL_MS",
      ),
      batchSize: parsePositiveInteger(
        process.env.STELLAR_RECONCILIATION_BATCH_SIZE,
        DEFAULT_RECONCILIATION_BATCH_SIZE,
        "STELLAR_RECONCILIATION_BATCH_SIZE",
      ),
      gracePeriodMs: parsePositiveInteger(
        process.env.STELLAR_RECONCILIATION_GRACE_PERIOD_MS,
        DEFAULT_RECONCILIATION_GRACE_PERIOD_MS,
        "STELLAR_RECONCILIATION_GRACE_PERIOD_MS",
      ),
      maxRuntimeMs: parsePositiveInteger(
        process.env.STELLAR_RECONCILIATION_MAX_RUNTIME_MS,
        DEFAULT_RECONCILIATION_MAX_RUNTIME_MS,
        "STELLAR_RECONCILIATION_MAX_RUNTIME_MS",
      ),
    },
    stellar: resolveNetwork(process.env.STELLAR_NETWORK),
  };
}
