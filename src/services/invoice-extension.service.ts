import { DataSource, EntityManager, QueryFailedError, Repository } from "typeorm";
import { Invoice } from "../models/Invoice.model";
import { Investment } from "../models/Investment.model";
import { InvoiceExtensionRequest } from "../models/InvoiceExtensionRequest.model";
import { ExtensionRequestStatus, InvoiceStatus, NotificationType } from "../types/enums";
import { ServiceError } from "../utils/service-error";
import { endOfDayUTC } from "../utils/date.utils";
import type { NotificationService } from "./notification.service";

/**
 * Name of the partial unique index that allows at most one pending extension
 * request per invoice (issue #734). Created by migration
 * 1796100000000-EnforceSinglePendingExtensionRequest.
 */
export const PENDING_EXTENSION_UNIQUE_INDEX = "uq_extension_requests_one_pending_per_invoice";

/**
 * Temporal rules for a proposed funding deadline (issue #733).
 *
 * - The proposal must be in the future (400 INVALID_DEADLINE) and strictly
 *   later than the invoice's current funding deadline (422
 *   EXTENSION_DEADLINE_NOT_LATER). A proposal equal to the current deadline
 *   is not an extension and is rejected. When the current deadline has
 *   already passed, "in the future" is the binding rule.
 * - Null legacy deadlines: an invoice with no funding deadline is treated as
 *   if its deadline were now, so any future proposal within maturity is an
 *   extension.
 * - The proposal must not be later than the maturity cutoff (422
 *   EXTENSION_BEYOND_MATURITY). `due_date` is a
 *   date-only column; following the repository's convention (date.utils.ts,
 *   also used by investment eligibility) the invoice matures at the end of
 *   that day in UTC, 23:59:59.999Z. A proposal exactly at the cutoff is
 *   allowed, one millisecond later is not.
 *
 * The same rules are checked again against the invoice's current dates and
 * the current time when an admin approves the request.
 */
export function validateProposedDeadline(
  invoice: Pick<Invoice, "fundingDeadline" | "dueDate">,
  proposed: Date,
  now: Date
): void {
  if (proposed.getTime() <= now.getTime()) {
    throw new ServiceError("INVALID_DEADLINE", "proposedDeadline must be in the future", 400);
  }

  const current = invoice.fundingDeadline ? new Date(invoice.fundingDeadline) : null;
  if (current && proposed.getTime() <= current.getTime()) {
    throw new ServiceError(
      "EXTENSION_DEADLINE_NOT_LATER",
      "proposedDeadline must be later than the current funding deadline",
      422,
      {
        proposedDeadline: proposed.toISOString(),
        currentDeadline: current.toISOString(),
      }
    );
  }

  if (!invoice.dueDate) {
    throw new ServiceError(
      "EXTENSION_BEYOND_MATURITY",
      "Invoice has no maturity date, so its funding window cannot be extended",
      422
    );
  }
  const maturityCutoff = endOfDayUTC(invoice.dueDate);
  if (proposed.getTime() > maturityCutoff.getTime()) {
    throw new ServiceError(
      "EXTENSION_BEYOND_MATURITY",
      "proposedDeadline must not be later than the invoice maturity date",
      422,
      {
        proposedDeadline: proposed.toISOString(),
        maturityCutoff: maturityCutoff.toISOString(),
      }
    );
  }
}

function isPendingUniqueViolation(error: unknown): boolean {
  if (!(error instanceof QueryFailedError)) return false;
  const driverError = error.driverError as { code?: string; constraint?: string } | undefined;
  return (
    driverError?.code === "23505" && driverError.constraint === PENDING_EXTENSION_UNIQUE_INDEX
  );
}

function pendingConflict(): ServiceError {
  return new ServiceError(
    "EXTENSION_PENDING",
    "An extension request is already pending for this invoice",
    409
  );
}

const BLOCKED_STATUSES = new Set<InvoiceStatus>([
  InvoiceStatus.FUNDED,
  InvoiceStatus.SETTLED,
  InvoiceStatus.CANCELLED,
  InvoiceStatus.REJECTED,
]);

export class InvoiceExtensionService {
  private readonly investmentRepo: Repository<Investment>;

  constructor(
    private readonly dataSource: DataSource,
    private readonly notificationService?: NotificationService,
    private readonly now: () => Date = () => new Date()
  ) {
    this.investmentRepo = dataSource.getRepository(Investment);
  }

  /**
   * Creates a pending extension request.
   *
   * Runs in one transaction that locks the invoice row, so concurrent
   * requests for the same invoice are serialized and the deadline checks
   * see the invoice as it is when the row is written. The partial unique
   * index on pending requests is the durable guarantee (it also covers
   * writers that bypass this service); a violation of it is reported as the
   * same 409 EXTENSION_PENDING as the sequential check (issue #734).
   */
  async requestExtension(input: {
    invoiceId: string;
    sellerId: string;
    proposedDeadline: Date;
    reason?: string | null;
  }): Promise<InvoiceExtensionRequest> {
    const proposed = input.proposedDeadline;
    if (!(proposed instanceof Date) || Number.isNaN(proposed.getTime())) {
      throw new ServiceError("INVALID_DEADLINE", "proposedDeadline must be a valid date", 400);
    }

    try {
      return await this.dataSource.transaction(async (manager) => {
        const invoice = await this.lockInvoice(manager, input.invoiceId);
        if (!invoice) {
          throw new ServiceError("INVOICE_NOT_FOUND", "Invoice not found", 404);
        }
        if (invoice.sellerId !== input.sellerId) {
          throw new ServiceError(
            "FORBIDDEN",
            "Only the invoice seller can request an extension",
            403
          );
        }
        if (BLOCKED_STATUSES.has(invoice.status)) {
          throw new ServiceError(
            "EXTENSION_NOT_ALLOWED",
            `Extension is not permitted on a ${invoice.status} invoice`,
            422
          );
        }

        validateProposedDeadline(invoice, proposed, this.now());

        const requestRepo = manager.getRepository(InvoiceExtensionRequest);
        const pending = await requestRepo.findOne({
          where: { invoiceId: input.invoiceId, status: ExtensionRequestStatus.PENDING },
        });
        if (pending) {
          throw pendingConflict();
        }

        const row = requestRepo.create({
          invoiceId: input.invoiceId,
          requestedBy: input.sellerId,
          proposedDeadline: proposed,
          previousDeadline: invoice.fundingDeadline ?? null,
          reason: input.reason ?? null,
          status: ExtensionRequestStatus.PENDING,
        });
        return requestRepo.save(row);
      });
    } catch (error) {
      if (isPendingUniqueViolation(error)) {
        throw pendingConflict();
      }
      throw error;
    }
  }

  private lockInvoice(manager: EntityManager, invoiceId: string): Promise<Invoice | null> {
    return manager.getRepository(Invoice).findOne({
      where: { id: invoiceId },
      lock: { mode: "pessimistic_write" },
    });
  }

  async reviewExtension(input: {
    invoiceId: string;
    requestId: string;
    decision: "approve" | "reject";
    reviewedBy: string;
    reviewNote?: string | null;
  }): Promise<{ request: InvoiceExtensionRequest; invoice: Invoice | null }> {
    return this.dataSource.transaction(async (manager) => {
      const requestRepo = manager.getRepository(InvoiceExtensionRequest);
      const invoiceRepo = manager.getRepository(Invoice);

      // Lock the request so two concurrent reviews cannot both act on it.
      const request = await requestRepo.findOne({
        where: { id: input.requestId, invoiceId: input.invoiceId },
        lock: { mode: "pessimistic_write" },
      });
      if (!request) {
        throw new ServiceError("EXTENSION_NOT_FOUND", "Extension request not found", 404);
      }
      if (request.status !== ExtensionRequestStatus.PENDING) {
        throw new ServiceError(
          "EXTENSION_NOT_PENDING",
          `Extension request is already ${request.status}`,
          409
        );
      }

      const invoice = await this.lockInvoice(manager, input.invoiceId);
      if (!invoice) {
        throw new ServiceError("INVOICE_NOT_FOUND", "Invoice not found", 404);
      }

      if (input.decision === "reject") {
        request.status = ExtensionRequestStatus.REJECTED;
        request.reviewedBy = input.reviewedBy;
        request.reviewedAt = new Date();
        request.reviewNote = input.reviewNote ?? null;
        const saved = await requestRepo.save(request);
        return { request: saved, invoice };
      }

      if (BLOCKED_STATUSES.has(invoice.status)) {
        throw new ServiceError(
          "EXTENSION_NOT_ALLOWED",
          `Extension is not permitted on a ${invoice.status} invoice`,
          422
        );
      }

      // Revalidate against the invoice's dates and the clock at review time:
      // the deadline may have moved, or the proposal may have expired, while
      // the request waited for review (issue #733).
      const now = this.now();
      if (request.proposedDeadline.getTime() <= now.getTime()) {
        throw new ServiceError(
          "EXTENSION_EXPIRED",
          "The proposed deadline passed while the request was awaiting review; reject it and ask the seller for a new proposal",
          409,
          { proposedDeadline: request.proposedDeadline.toISOString() }
        );
      }
      validateProposedDeadline(invoice, request.proposedDeadline, now);

      request.previousDeadline = invoice.fundingDeadline ?? request.previousDeadline;
      invoice.fundingDeadline = request.proposedDeadline;
      await invoiceRepo.save(invoice);

      request.status = ExtensionRequestStatus.APPROVED;
      request.reviewedBy = input.reviewedBy;
      request.reviewedAt = new Date();
      request.reviewNote = input.reviewNote ?? null;
      const saved = await requestRepo.save(request);

      return { request: saved, invoice };
    }).then(async (result) => {
      if (result.request.status === ExtensionRequestStatus.APPROVED && this.notificationService) {
        await this.notifyInvestors(result.request, result.invoice!);
      }
      return result;
    });
  }

  private async notifyInvestors(
    request: InvoiceExtensionRequest,
    invoice: Invoice
  ): Promise<void> {
    if (!this.notificationService) return;

    const investments = await this.investmentRepo.find({
      where: { invoiceId: invoice.id },
      select: ["investorId"],
    });
    const uniqueInvestorIds = [...new Set(investments.map((i) => i.investorId))];
    if (uniqueInvestorIds.length === 0) return;

    const deadlineIso = request.proposedDeadline.toISOString();
    await this.notificationService.createNotifications(
      uniqueInvestorIds.map((userId) => ({
        userId,
        type: NotificationType.INVOICE_DEADLINE_EXTENDED,
        title: "Funding deadline extended",
        message: `Invoice ${invoice.invoiceNumber} funding deadline was extended to ${deadlineIso}.`,
      }))
    );
  }
}

export function createInvoiceExtensionService(
  dataSource: DataSource,
  notificationService?: NotificationService,
  now?: () => Date
): InvoiceExtensionService {
  return new InvoiceExtensionService(dataSource, notificationService, now);
}
