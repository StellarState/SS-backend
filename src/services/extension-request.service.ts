import { DataSource, EntityManager } from "typeorm";
import { Invoice } from "../models/Invoice.model";
import { ExtensionRequest, ExtensionRequestStatus } from "../models/ExtensionRequest.model";
import { InvoiceStatus, NotificationType } from "../types/enums";
import { Investment } from "../models/Investment.model";
import { ServiceError } from "../utils/service-error";
import type { NotificationService } from "./notification.service";

export interface RequestExtensionInput {
  invoiceId: string;
  requestedBy: string;
  proposedDeadline: Date;
}

export interface ReviewExtensionInput {
  invoiceId: string;
  requestId: string;
  reviewerId: string;
  approve: boolean;
  rejectionReason?: string;
}

const NON_EXTENDABLE_STATUSES = [InvoiceStatus.FUNDED, InvoiceStatus.SETTLED];

export class ExtensionRequestService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly notificationService?: NotificationService,
  ) {}

  async requestExtension(input: RequestExtensionInput): Promise<ExtensionRequest> {
    const { invoiceId, requestedBy, proposedDeadline } = input;

    return this.dataSource.transaction(async (em: EntityManager) => {
      const invoice = await em
        .createQueryBuilder(Invoice, "invoice")
        .setLock("pessimistic_write")
        .where("invoice.id = :id", { id: invoiceId })
        .getOne();

      if (!invoice) {
        throw new ServiceError("INVOICE_NOT_FOUND", "Invoice not found", 404);
      }

      if (NON_EXTENDABLE_STATUSES.includes(invoice.status)) {
        throw new ServiceError(
          "EXTENSION_NOT_PERMITTED",
          "Extension is not permitted on a fully funded or settled invoice",
          422,
        );
      }

      const pending = await em.getRepository(ExtensionRequest).findOne({
        where: { invoiceId, status: ExtensionRequestStatus.PENDING },
      });

      if (pending) {
        throw new ServiceError(
          "EXTENSION_ALREADY_PENDING",
          "An extension request is already pending for this invoice",
          422,
        );
      }

      const requestRepo = em.getRepository(ExtensionRequest);
      const request = requestRepo.create({
        invoiceId,
        requestedBy,
        currentDeadline: invoice.dueDate,
        proposedDeadline,
        status: ExtensionRequestStatus.PENDING,
      });

      return requestRepo.save(request);
    });
  }

  async reviewExtension(input: ReviewExtensionInput): Promise<ExtensionRequest> {
    const { invoiceId, requestId, reviewerId, approve, rejectionReason } = input;

    return this.dataSource.transaction(async (em: EntityManager) => {
      const requestRepo = em.getRepository(ExtensionRequest);
      const request = await requestRepo.findOne({ where: { id: requestId, invoiceId } });

      if (!request) {
        throw new ServiceError("EXTENSION_REQUEST_NOT_FOUND", "Extension request not found", 404);
      }

      if (request.status !== ExtensionRequestStatus.PENDING) {
        throw new ServiceError(
          "EXTENSION_ALREADY_REVIEWED",
          "This extension request has already been reviewed",
          422,
        );
      }

      request.reviewedBy = reviewerId;
      request.reviewedAt = new Date();

      if (!approve) {
        request.status = ExtensionRequestStatus.REJECTED;
        request.rejectionReason = rejectionReason ?? null;
        return requestRepo.save(request);
      }

      request.status = ExtensionRequestStatus.APPROVED;
      await requestRepo.save(request);

      // Atomically update the invoice deadline alongside the approval.
      const invoiceRepo = em.getRepository(Invoice);
      await invoiceRepo.update(request.invoiceId, { dueDate: request.proposedDeadline });

      if (this.notificationService) {
        const investments = await em.getRepository(Investment).find({
          where: { invoiceId: request.invoiceId },
        });
        const notifiedInvestorIds = new Set(investments.map((i) => i.investorId));
        for (const investorId of notifiedInvestorIds) {
          await this.notificationService.createNotification(
            investorId,
            NotificationType.INVOICE,
            "Funding deadline extended",
            `The funding deadline for an invoice you invested in has been extended to ${request.proposedDeadline.toISOString().slice(0, 10)}.`,
          );
        }
      }

      return request;
    });
  }
}

export function createExtensionRequestService(
  dataSource: DataSource,
  notificationService?: NotificationService,
): ExtensionRequestService {
  return new ExtensionRequestService(dataSource, notificationService);
}
