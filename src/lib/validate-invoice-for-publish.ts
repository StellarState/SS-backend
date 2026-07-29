import { Decimal } from "decimal.js";
import type { Invoice } from "../models/Invoice.model";

export interface ValidationError {
  field: string;
  code: string;
  message: string;
}

const MIN_LEAD_TIME_MS = 24 * 60 * 60 * 1000;
export const MIN_FACE_VALUE_XLM = new Decimal("100");

/**
 * Validates that an invoice meets the minimum field requirements
 * required for the draft -> published lifecycle transition.
 */
export function validateInvoiceForPublish(invoice: Invoice): ValidationError[] {
  const errors: ValidationError[] = [];

  const faceValue = new Decimal(invoice.amount);
  if (faceValue.lessThan(MIN_FACE_VALUE_XLM)) {
    errors.push({
      field: "amount",
      code: "FACE_VALUE_TOO_LOW",
      message: `Invoice face value must be at least ${MIN_FACE_VALUE_XLM.toFixed(4)} XLM.`,
    });
  }

  const dueDate = new Date(invoice.dueDate);
  if (Number.isNaN(dueDate.getTime()) || dueDate.getTime() - Date.now() < MIN_LEAD_TIME_MS) {
    errors.push({
      field: "dueDate",
      code: "DUE_DATE_TOO_SOON",
      message: "Invoice due date must be at least 24 hours in the future.",
    });
  }

  if (!invoice.ipfsHash) {
    errors.push({
      field: "ipfsHash",
      code: "MISSING_DOCUMENT",
      message: "Invoice must have at least one document attached before it can be published.",
    });
  }

  return errors;
}
