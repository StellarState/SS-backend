import winston from "winston";

const STELLAR_SECRET_KEY_PATTERN = /S[A-Z0-9]{55}/g;

const STELLAR_SECRET_KEY_REDACTED =
  "S*******************************************************";

const JWT_PATTERN =
  /eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+/g;

const BEARER_PATTERN = /Bearer\s+[A-Za-z0-9_\-.~+/]+=*/g;

const SENSITIVE_KEY_NAMES = new Set([
  "password",
  "secret",
  "secretKey",
  "secret_key",
  "privateKey",
  "private_key",
  "platformSecretKey",
  "PLATFORM_SECRET_KEY",
  "jwt",
  "token",
  "accessToken",
  "access_token",
  "refreshToken",
  "refresh_token",
  "authorization",
  "auth",
  "credential",
  "credentials",
  "apiKey",
  "api_key",
  "seed",
]);

function redactStringValue(value: string): string {
  let result = value;
  result = result.replace(STELLAR_SECRET_KEY_PATTERN, STELLAR_SECRET_KEY_REDACTED);
  result = result.replace(BEARER_PATTERN, "Bearer ***");
  result = result.replace(JWT_PATTERN, "eyJ***.eyJ***.***");
  return result;
}

function redactObjectValues(obj: Record<string, unknown>): Record<string, unknown> {
  const redacted: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(obj)) {
    if (SENSITIVE_KEY_NAMES.has(key)) {
      redacted[key] = "[REDACTED]";
    } else if (typeof value === "string") {
      redacted[key] = redactStringValue(value);
    } else if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      redacted[key] = redactObjectValues(value as Record<string, unknown>);
    } else if (Array.isArray(value)) {
      redacted[key] = value.map((item) => {
        if (typeof item === "string") return redactStringValue(item);
        if (item !== null && typeof item === "object")
          return redactObjectValues(item as Record<string, unknown>);
        return item;
      });
    } else {
      redacted[key] = value;
    }
  }

  return redacted;
}

export function redactionFormat(): winston.Logform.Format {
  return winston.format((info) => {
    if (info.message && typeof info.message === "string") {
      info.message = redactStringValue(info.message);
    }

    const { level, message, timestamp, stack, ...rest } = info as Record<string, unknown>;

    const redactedMeta = redactObjectValues(rest);

    return {
      level,
      message,
      timestamp,
      stack,
      ...redactedMeta,
    } as winston.Logform.TransformableInfo;
  })();
}

export function redactString(input: string): string {
  return redactStringValue(input);
}
