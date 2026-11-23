import { ServiceError } from "../utils/service-error";

/**
 * Maximum character length allowed for any individual text field in a draft.
 */
export const MAX_DRAFT_TEXT_LENGTH = 10_000;

/**
 * Maximum number of keys allowed in a draft payload to prevent unbounded state.
 */
export const MAX_DRAFT_KEY_COUNT = 100;

/**
 * Maximum nesting depth allowed for extension fields.
 */
export const MAX_DRAFT_NESTING_DEPTH = 3;

/**
 * Documented policy for unknown/additional form keys.
 *
 * Policy: "PRESERVE"
 * Additional form fields beyond known invoice fields are preserved in draftData
 * so that partial form extensions, custom issuer notes, and multi-step UI state
 * remain resumable, provided they conform to plain-object payload and text/depth limits.
 */
export const UNKNOWN_FIELDS_POLICY = "PRESERVE" as const;

/**
 * Set of known invoice form fields that must be scalar values when provided.
 */
export const KNOWN_SCALAR_FIELDS = new Set([
  "invoiceNumber",
  "customerName",
  "issuerName",
  "description",
  "amount",
  "discountRate",
  "dueDate",
  "ipfsHash",
  "title",
  "faceValue",
  "fundingTarget",
  "fundingDeadline",
]);

export interface DraftValidationErrorItem {
  field: string;
  message: string;
}

export interface DraftValidationResult {
  isValid: boolean;
  errors: DraftValidationErrorItem[];
  fieldErrors: Record<string, string>;
  cleanedData?: Record<string, unknown>;
}

/**
 * Calculates the nesting depth of a value.
 */
function getDepth(value: unknown, currentDepth = 1): number {
  if (value === null || typeof value !== "object") {
    return currentDepth;
  }
  let max = currentDepth;
  if (Array.isArray(value)) {
    for (const item of value) {
      max = Math.max(max, getDepth(item, currentDepth + 1));
    }
  } else {
    for (const val of Object.values(value as Record<string, unknown>)) {
      max = Math.max(max, getDepth(val, currentDepth + 1));
    }
  }
  return max;
}

/**
 * Validates text length limits recursively on strings within an object/array.
 */
function checkTextLimits(
  value: unknown,
  path: string,
  errors: DraftValidationErrorItem[]
): void {
  if (typeof value === "string") {
    if (value.length > MAX_DRAFT_TEXT_LENGTH) {
      errors.push({
        field: path,
        message: `Field '${path}' exceeds maximum allowed text length of ${MAX_DRAFT_TEXT_LENGTH} characters`,
      });
    }
  } else if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      checkTextLimits(value[i], `${path}[${i}]`, errors);
    }
  } else if (value !== null && typeof value === "object") {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      checkTextLimits(v, `${path}.${k}`, errors);
    }
  }
}

/**
 * Validates a partial invoice draft payload.
 *
 * Distinguishes incomplete/empty form input from structurally invalid data.
 * Rejects objects/arrays in known scalar fields and invalid yieldBps types.
 * Preserves allowed unknown extension fields within depth and size limits.
 */
export function validateDraftPayload(payload: unknown): DraftValidationResult {
  const errors: DraftValidationErrorItem[] = [];

  // 1. Verify plain-object payload
  if (
    typeof payload !== "object" ||
    payload === null ||
    Array.isArray(payload)
  ) {
    errors.push({
      field: "payload",
      message: "Draft payload must be a plain object",
    });
    return {
      isValid: false,
      errors,
      fieldErrors: { payload: "Draft payload must be a plain object" },
    };
  }

  const rawData = payload as Record<string, unknown>;
  const cleanedData: Record<string, unknown> = { ...rawData };
  const keys = Object.keys(rawData);

  // 2. Bound total keys
  if (keys.length > MAX_DRAFT_KEY_COUNT) {
    errors.push({
      field: "payload",
      message: `Draft payload exceeds maximum allowed field count of ${MAX_DRAFT_KEY_COUNT}`,
    });
  }

  // 3. Validate known scalar fields
  for (const field of KNOWN_SCALAR_FIELDS) {
    const value = rawData[field];
    if (value === undefined || value === null) {
      continue; // empty/incomplete fields are allowed
    }

    // Must be a scalar (string or number). Objects, arrays, booleans are rejected.
    if (typeof value === "object" || Array.isArray(value)) {
      errors.push({
        field,
        message: `${field} must be a scalar value, received ${Array.isArray(value) ? "array" : "object"}`,
      });
    } else if (typeof value === "boolean") {
      errors.push({
        field,
        message: `${field} must be a scalar string or number, received boolean`,
      });
    } else if (typeof value === "string") {
      if (value.length > MAX_DRAFT_TEXT_LENGTH) {
        errors.push({
          field,
          message: `${field} exceeds maximum allowed text length of ${MAX_DRAFT_TEXT_LENGTH} characters`,
        });
      }
    } else if (typeof value === "number") {
      if (!Number.isFinite(value)) {
        errors.push({
          field,
          message: `${field} must be a finite number`,
        });
      }
    }
  }

  // 4. Validate yieldBps (documented integer form)
  if (rawData.yieldBps !== undefined && rawData.yieldBps !== null) {
    const val = rawData.yieldBps;
    if (typeof val === "number") {
      if (!Number.isInteger(val)) {
        errors.push({
          field: "yieldBps",
          message: "yieldBps must be an integer, received float",
        });
      }
    } else if (typeof val === "string") {
      if (!/^-?\d+$/.test(val.trim())) {
        errors.push({
          field: "yieldBps",
          message: "yieldBps must be an integer, received non-integer string",
        });
      } else {
        cleanedData.yieldBps = parseInt(val.trim(), 10);
      }
    } else {
      errors.push({
        field: "yieldBps",
        message: `yieldBps must be an integer number, received ${Array.isArray(val) ? "array" : typeof val}`,
      });
    }
  }

  // 5. Validate extension/unknown fields according to PRESERVE policy with limits
  for (const key of keys) {
    if (KNOWN_SCALAR_FIELDS.has(key) || key === "yieldBps") {
      continue;
    }
    const val = rawData[key];
    if (val === undefined || val === null) {
      continue;
    }

    // Check nesting depth
    const depth = getDepth(val);
    if (depth > MAX_DRAFT_NESTING_DEPTH) {
      errors.push({
        field: key,
        message: `Field '${key}' exceeds maximum nesting depth of ${MAX_DRAFT_NESTING_DEPTH}`,
      });
    }

    // Check text length limits
    checkTextLimits(val, key, errors);
  }

  const fieldErrors: Record<string, string> = {};
  for (const err of errors) {
    if (!fieldErrors[err.field]) {
      fieldErrors[err.field] = err.message;
    }
  }

  return {
    isValid: errors.length === 0,
    errors,
    fieldErrors,
    cleanedData: errors.length === 0 ? cleanedData : undefined,
  };
}

/**
 * Asserts that a draft payload is valid, throwing a ServiceError with 400 if invalid.
 */
export function assertValidDraftPayload(payload: unknown): Record<string, unknown> {
  const result = validateDraftPayload(payload);
  if (!result.isValid) {
    throw new ServiceError(
      "INVALID_DRAFT_DATA",
      `Draft validation failed: ${result.errors.map((e) => e.message).join("; ")}`,
      400,
      {
        errors: result.errors,
        fieldErrors: result.fieldErrors,
      }
    );
  }
  return result.cleanedData ?? (payload as Record<string, unknown>);
}
