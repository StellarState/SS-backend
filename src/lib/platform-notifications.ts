import type { EntityManager } from "typeorm";
import { Notification } from "../models/Notification.model";
import { User } from "../models/User.model";
import { logger as defaultLogger, type AppLogger } from "../observability/logger";
import { KYCStatus, NotificationType } from "../types/enums";
import type { NotificationInput } from "./invoice-notifications";

/**
 * In-app notifications for platform events outside the invoice lifecycle
 * (issue #564): KYC decisions and secondary market sales.
 *
 * Callers send these after their own write has committed, and a failure is
 * logged rather than thrown: the KYC decision or the sale has already
 * happened and must not be reported as failed because a notification could
 * not be stored.
 */

export interface KycStatusChange {
  userId: string;
  previousStatus: KYCStatus | null;
  newStatus: KYCStatus;
  reason?: string | null;
}

export function buildKycStatusNotification({
  userId,
  previousStatus,
  newStatus,
  reason,
}: KycStatusChange): NotificationInput | null {
  if (previousStatus === newStatus) return null;

  switch (newStatus) {
    case KYCStatus.APPROVED:
      return {
        userId,
        type: NotificationType.KYC_APPROVED,
        title: "KYC Approved",
        message: "Your identity verification has been approved.",
        data: { previousStatus, newStatus },
      };
    case KYCStatus.REJECTED:
      return {
        userId,
        type: NotificationType.KYC_REJECTED,
        title: "KYC Rejected",
        message: reason?.trim()
          ? `Your identity verification was rejected: ${reason.trim()}`
          : "Your identity verification was rejected.",
        data: { previousStatus, newStatus, reason: reason?.trim() || null },
      };
    case KYCStatus.PENDING:
      if (previousStatus === KYCStatus.APPROVED) {
        return {
          userId,
          type: NotificationType.KYC,
          title: "KYC Approval Revoked",
          message: reason?.trim()
            ? `Your KYC approval has been revoked and is pending review again: ${reason.trim()}`
            : "Your KYC approval has been revoked and is pending review again.",
          data: { previousStatus, newStatus, reason: reason?.trim() || null },
        };
      }
      break;
    default:
      break;
  }

  return {
    userId,
    type: NotificationType.KYC,
    title: "KYC Status Updated",
    message: `Your KYC status is now ${newStatus.replace(/_/g, " ")}.`,
    data: { previousStatus, newStatus },
  };
}

export async function notifyKycStatusChange(
  manager: EntityManager,
  change: KycStatusChange,
  log: AppLogger = defaultLogger
): Promise<void> {
  const notification = buildKycStatusNotification(change);
  if (!notification) return;
  await saveBestEffort(manager, [notification], log, { user_id: change.userId });
}

export interface ListingSale {
  listingId: string;
  invoiceId: string;
  invoiceNumber?: string | null;
  sellerId: string | null;
  sellerWallet: string;
  quantity: string;
  totalPrice: string;
  /** Fractions still listed after this sale; "0.0000" when it sold out. */
  remainingQuantity: string;
}

export function buildListingSoldNotification(
  sellerId: string,
  sale: ListingSale
): NotificationInput {
  const soldOut = Number(sale.remainingQuantity) === 0;
  const invoiceLabel = sale.invoiceNumber ? `invoice ${sale.invoiceNumber}` : "your invoice";
  return {
    userId: sellerId,
    type: NotificationType.LISTING_SOLD,
    title: soldOut ? "Listing Sold" : "Listing Partially Sold",
    message: soldOut
      ? `Your listing of ${sale.quantity} fractions of ${invoiceLabel} sold for ${sale.totalPrice}.`
      : `${sale.quantity} fractions of your ${invoiceLabel} listing sold for ${sale.totalPrice}. ${sale.remainingQuantity} remain listed.`,
    data: {
      listingId: sale.listingId,
      invoiceId: sale.invoiceId,
      quantity: sale.quantity,
      totalPrice: sale.totalPrice,
      remainingQuantity: sale.remainingQuantity,
    },
  };
}

export async function notifyListingSold(
  manager: EntityManager,
  sale: ListingSale,
  log: AppLogger = defaultLogger
): Promise<void> {
  try {
    // Listings created before seller ids were recorded only carry the wallet.
    const sellerId =
      sale.sellerId ??
      (await manager.findOne(User, { where: { stellarAddress: sale.sellerWallet } }))?.id ??
      null;
    if (!sellerId) return;
    await saveBestEffort(manager, [buildListingSoldNotification(sellerId, sale)], log, {
      listing_id: sale.listingId,
    });
  } catch (error) {
    log.warn("Failed to send listing-sold notification.", {
      listing_id: sale.listingId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

async function saveBestEffort(
  manager: EntityManager,
  entries: NotificationInput[],
  log: AppLogger,
  context: Record<string, unknown>
): Promise<void> {
  try {
    await manager.save(
      Notification,
      entries.map((entry) =>
        manager.create(Notification, {
          userId: entry.userId,
          type: entry.type,
          title: entry.title,
          message: entry.message,
          data: entry.data ?? null,
        })
      )
    );
  } catch (error) {
    log.warn("Failed to store platform notification.", {
      ...context,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
