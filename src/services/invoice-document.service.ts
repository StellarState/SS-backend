import { QueryFailedError, type DataSource, type EntityManager } from "typeorm";
import { Invoice } from "../models/Invoice.model";
import { InvoiceDocument, InvoiceDocumentType } from "../models/InvoiceDocument.model";
import { InvoiceStatus, UserType } from "../types/enums";
import { ServiceError } from "../utils/service-error";
import { parseContentChecksum } from "../lib/document-checksum";
import { InvoiceUploadSession } from "../models/InvoiceUploadSession.model";
import { isValidCid } from "../utils/cid.utils";
import type { TransitionEffect } from "../lib/invoice-state-machine";
import { logger as defaultLogger, type AppLogger } from "../observability/logger";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Postgres integer column upper bound. */
export const MAX_FILE_SIZE_BYTES = 2_147_483_647;

/** Invoices that accept new document registrations. */
const REGISTRABLE_STATUSES: readonly InvoiceStatus[] = [
  InvoiceStatus.DRAFT,
  InvoiceStatus.PENDING,
  InvoiceStatus.PUBLISHED,
];

/** Invoices whose documents anyone signed in may view; others are owner/admin only. */
const PUBLIC_STATUSES: readonly InvoiceStatus[] = [
  InvoiceStatus.PUBLISHED,
  InvoiceStatus.FUNDED,
  InvoiceStatus.SETTLED,
  InvoiceStatus.FAILED,
];

export interface DocumentRequester {
  id: string;
  userType?: UserType;
  role?: "admin" | "user";
}

export interface RegisterInvoiceDocumentInput {
  invoiceId: string;
  requester: DocumentRequester;
  cid: unknown;
  documentType: unknown;
  fileSizeBytes: unknown;
  filename?: unknown;
  mimeType?: unknown;
  contentChecksum?: unknown;
  uploadSessionId?: unknown;
}

export interface InvoiceDocumentView {
  id: string;
  invoice_id: string;
  cid: string;
  document_type: string;
  file_size_bytes: number;
  filename: string | null;
  mime_type: string | null;
  created_at: string;
  content_checksum: string | null;
  upload_session_id: string | null;
  checksum_verified: boolean;
  upload_complete: boolean;
}

function optionalString(value: unknown, field: string, maxLength: number): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || value.trim() === "" || value.trim().length > maxLength) {
    throw new ServiceError(
      "VALIDATION_ERROR",
      `${field} must be a non-empty string of at most ${maxLength} characters.`,
      400
    );
  }
  return value.trim();
}

function isAdmin(requester: DocumentRequester): boolean {
  return requester.role === "admin" || requester.userType === UserType.ADMIN;
}

export function toInvoiceDocumentView(doc: InvoiceDocument): InvoiceDocumentView {
  return {
    id: doc.id,
    invoice_id: doc.invoiceId,
    cid: doc.cid,
    document_type: doc.docType,
    file_size_bytes: Number(doc.fileSize),
    filename: doc.filename,
    mime_type: doc.mimeType,
    created_at: new Date(doc.createdAt).toISOString(),
    content_checksum: doc.contentChecksum ?? null,
    upload_session_id: doc.uploadSessionId ?? null,
    checksum_verified: doc.checksumVerified ?? false,
    upload_complete: true,
  };
}

/**
 * Registers IPFS CIDs of supporting documents against an invoice and lists
 * them for the document viewer (issue #781).
 */
export class InvoiceDocumentService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly logger: AppLogger = defaultLogger
  ) {}

  async registerDocument(input: RegisterInvoiceDocumentInput): Promise<InvoiceDocumentView> {
    const cid = typeof input.cid === "string" ? input.cid.trim() : input.cid;
    if (!isValidCid(cid)) {
      throw new ServiceError("cid_invalid", "cid is not a valid IPFS CID.", 400);
    }

    const documentType = input.documentType;
    if (
      typeof documentType !== "string" ||
      !(Object.values(InvoiceDocumentType) as string[]).includes(documentType)
    ) {
      throw new ServiceError(
        "VALIDATION_ERROR",
        `document_type must be one of: ${Object.values(InvoiceDocumentType).join(", ")}.`,
        400
      );
    }

    const size = input.fileSizeBytes;
    if (
      typeof size !== "number" ||
      !Number.isInteger(size) ||
      size <= 0 ||
      size > MAX_FILE_SIZE_BYTES
    ) {
      throw new ServiceError(
        "VALIDATION_ERROR",
        `file_size_bytes must be a positive integer no greater than ${MAX_FILE_SIZE_BYTES}.`,
        400
      );
    }

    const filename = optionalString(input.filename, "filename", 255);
    const mimeType = optionalString(input.mimeType, "mime_type", 128);

    const checksum = parseContentChecksum(input.contentChecksum);
    const sessionId = input.uploadSessionId;
    if (sessionId !== undefined && (typeof sessionId !== "string" || !UUID_PATTERN.test(sessionId)))
      throw new ServiceError("invalid_upload_session", "upload_session_id must be a UUID", 400);
    if (checksum && !sessionId)
      throw new ServiceError(
        "upload_verification_required",
        "Checksum registration requires a completed upload session",
        400
      );
    return this.dataSource.transaction(async (manager) => {
      const invoice = await this.findInvoice(input.invoiceId, manager);
      if (invoice.sellerId !== input.requester.id) {
        throw new ServiceError(
          "unauthorized_invoice_access",
          "Only the invoice owner can register documents.",
          403
        );
      }
      if (!REGISTRABLE_STATUSES.includes(invoice.status)) {
        throw new ServiceError(
          "invalid_invoice_status",
          `Documents cannot be registered on an invoice in ${invoice.status} status.`,
          409
        );
      }

      let verifiedChecksum: string | null = null;
      if (sessionId) {
        const session = await manager.findOneBy(InvoiceUploadSession, {
          id: sessionId as string,
          invoiceId: invoice.id,
        });
        if (
          !session ||
          session.state !== "complete" ||
          session.cid !== cid ||
          session.fileSizeBytes !== size ||
          (checksum && session.contentChecksum !== checksum)
        )
          throw new ServiceError(
            "upload_metadata_conflict",
            "Document metadata must match its completed upload session",
            409
          );
        verifiedChecksum = session.contentChecksum;
      }
      const repository = manager.getRepository(InvoiceDocument);
      try {
        const saved = await repository.save(
          repository.create({
            invoiceId: invoice.id,
            cid,
            docType: documentType,
            fileSize: size,
            filename,
            mimeType,
            contentChecksum: verifiedChecksum,
            checksumVerified: Boolean(verifiedChecksum),
            uploadSessionId: (sessionId as string | undefined) ?? null,
          })
        );
        return toInvoiceDocumentView(saved);
      } catch (error) {
        if (error instanceof QueryFailedError && /unique|duplicate/i.test(error.message)) {
          throw new ServiceError(
            "document_already_registered",
            "This CID is already registered on the invoice.",
            409
          );
        }
        throw error;
      }
    });
  }

  /** Active (non-deleted) documents, oldest first. */
  async listDocuments(
    invoiceId: string,
    requester: DocumentRequester
  ): Promise<InvoiceDocumentView[]> {
    const invoice = await this.findInvoice(invoiceId);
    const canView =
      PUBLIC_STATUSES.includes(invoice.status) ||
      invoice.sellerId === requester.id ||
      isAdmin(requester);
    // Hide existence of non-public invoices from other users.
    if (!canView) throw this.invoiceNotFound();

    const documents = await this.dataSource.getRepository(InvoiceDocument).find({
      where: { invoiceId: invoice.id },
      order: { createdAt: "ASC", id: "ASC" },
    });
    return documents.map(toInvoiceDocumentView);
  }

  /** Soft-deletes every active document of an invoice. */
  async softDeleteForInvoice(invoiceId: string, manager?: EntityManager): Promise<number> {
    const repository = (manager ?? this.dataSource.manager).getRepository(InvoiceDocument);
    const result = await repository.softDelete({ invoiceId });
    return result.affected ?? 0;
  }

  /** Invoice state machine effect: withdrawing (cancelling) an invoice removes its documents. */
  createWithdrawalEffect(): TransitionEffect {
    const softDeleteDocumentsOnWithdrawal: TransitionEffect = async (transition) => {
      if (transition.to !== InvoiceStatus.CANCELLED) return;
      try {
        const removed = await this.softDeleteForInvoice(transition.invoice.id);
        if (removed > 0) {
          this.logger.info("Invoice documents soft-deleted on withdrawal.", {
            invoice_id: transition.invoice.id,
            documents: removed,
          });
        }
      } catch (error) {
        this.logger.warn("Failed to soft-delete invoice documents on withdrawal.", {
          invoice_id: transition.invoice.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    };
    return softDeleteDocumentsOnWithdrawal;
  }

  private async findInvoice(invoiceId: string, manager?: EntityManager): Promise<Invoice> {
    if (!UUID_PATTERN.test(invoiceId)) throw this.invoiceNotFound();
    // Soft-deleted invoices are excluded by TypeORM, so they read as not found.
    const invoice = await (manager ?? this.dataSource.manager).getRepository(Invoice).findOne({
      where: { id: invoiceId },
      select: { id: true, sellerId: true, status: true },
      ...(manager ? { lock: { mode: "pessimistic_write" as const } } : {}),
    });
    if (!invoice) throw this.invoiceNotFound();
    return invoice;
  }

  private invoiceNotFound(): ServiceError {
    return new ServiceError("invoice_not_found", "Invoice not found", 404);
  }
}

export function createInvoiceDocumentService(
  dataSource: DataSource,
  logger?: AppLogger
): InvoiceDocumentService {
  return new InvoiceDocumentService(dataSource, logger);
}
