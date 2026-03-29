export interface PaymentVerificationConfig {
  horizonUrl: string;
  usdcAssetCode: string;
  usdcAssetIssuer: string;
  escrowPublicKey: string;
  allowedAmountDelta: string;
  retryAttempts: number;
  retryBaseDelayMs: number;
}

const DEFAULT_ALLOWED_AMOUNT_DELTA = "0.0001";
const DEFAULT_RETRY_ATTEMPTS = 3;
const DEFAULT_RETRY_BASE_DELAY_MS = 250;

function requireEnv(value: string | undefined, name: string): string {
  if (!value) {
    throw new Error(`${name} is required.`);
  }

  return value;
}

function parsePositiveInteger(value: string | undefined, fallback: number, name: string): number {
  if (!value) {
    return fallback;
  }

  const parsed = Number(value);

  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }

  return parsed;
}

export function getPaymentVerificationConfig(): PaymentVerificationConfig {
  return {
    horizonUrl: requireEnv(process.env.STELLAR_HORIZON_URL, "STELLAR_HORIZON_URL"),
    usdcAssetCode: requireEnv(
      process.env.STELLAR_USDC_ASSET_CODE,
      "STELLAR_USDC_ASSET_CODE",
    ),
    usdcAssetIssuer: requireEnv(
      process.env.STELLAR_USDC_ASSET_ISSUER,
      "STELLAR_USDC_ASSET_ISSUER",
    ),
    escrowPublicKey: requireEnv(
      process.env.STELLAR_ESCROW_PUBLIC_KEY,
      "STELLAR_ESCROW_PUBLIC_KEY",
    ),
    allowedAmountDelta:
      process.env.STELLAR_VERIFY_ALLOWED_AMOUNT_DELTA ?? DEFAULT_ALLOWED_AMOUNT_DELTA,
    retryAttempts: parsePositiveInteger(
      process.env.STELLAR_VERIFY_RETRY_ATTEMPTS,
      DEFAULT_RETRY_ATTEMPTS,
      "STELLAR_VERIFY_RETRY_ATTEMPTS",
    ),
    retryBaseDelayMs: parsePositiveInteger(
      process.env.STELLAR_VERIFY_RETRY_BASE_DELAY_MS,
      DEFAULT_RETRY_BASE_DELAY_MS,
      "STELLAR_VERIFY_RETRY_BASE_DELAY_MS",
    ),
  };
}
