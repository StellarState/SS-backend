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
  stellar: {
    network: SupportedStellarNetwork;
    networkPassphrase: string;
  };
}

const DEFAULT_PORT = 3000;
const DEFAULT_JWT_EXPIRES_IN = "15m";
const DEFAULT_CHALLENGE_TTL_MS = 5 * 60 * 1000;

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

function parseChallengeTtl(value: string | undefined): number {
  if (!value) {
    return DEFAULT_CHALLENGE_TTL_MS;
  }

  const ttl = Number(value);

  if (!Number.isInteger(ttl) || ttl <= 0) {
    throw new Error("AUTH_CHALLENGE_TTL_MS must be a positive integer.");
  }

  return ttl;
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
    stellar: resolveNetwork(process.env.STELLAR_NETWORK),
  };
}
