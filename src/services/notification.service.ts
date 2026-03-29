import { DataSource, Repository } from "typeorm";
import { Notification } from "../models/Notification.model";
import { NotificationType } from "../types/enums";
import { HttpError } from "../utils/http-error";

export interface NotificationPage {
  data: Notification[];
  meta: {
    total: number;
    page: number;
    limit: number;
    totalPages: number;
  };
}

export interface ListNotificationsOptions {
  userId: string;
  page?: number;
  limit?: number;
  read?: boolean;
  type?: NotificationType;
  sortOrder?: "asc" | "desc";
}

export interface NotificationRepositoryContract {
  create(
    userId: string,
    type: NotificationType,
    title: string,
    message: string,
  ): Promise<Notification>;
  findByIdAndUserId(id: string, userId: string): Promise<Notification | null>;
  markRead(id: string, userId: string): Promise<Notification>;
  list(options: ListNotificationsOptions): Promise<NotificationPage>;
}

export class NotificationService {
  constructor(
    private readonly notificationRepository: NotificationRepositoryContract,
  ) {}

  /**
   * Creates a notification for a user.
   * Intended call sites:
   *   - Invoice publish  → createNotification(sellerId, NotificationType.INVOICE, ...)
   *   - Investment confirmed → createNotification(investorId, NotificationType.INVESTMENT, ...)
   *   - Settlement complete  → createNotification(userId, NotificationType.PAYMENT, ...)
   */
  async createNotification(
    userId: string,
    type: NotificationType,
    title: string,
    message: string,
  ): Promise<Notification> {
    return this.notificationRepository.create(userId, type, title, message);
  }

  async listNotifications(
    options: ListNotificationsOptions,
  ): Promise<NotificationPage> {
    return this.notificationRepository.list(options);
  }

  async markNotificationRead(
    notificationId: string,
    userId: string,
  ): Promise<Notification> {
    const notification = await this.notificationRepository.findByIdAndUserId(
      notificationId,
      userId,
    );

    if (!notification) {
      throw new HttpError(404, "Notification not found.");
    }

    if (notification.read) {
      return notification;
    }

    return this.notificationRepository.markRead(notificationId, userId);
  }
}

class TypeOrmNotificationRepository implements NotificationRepositoryContract {
  constructor(private readonly repository: Repository<Notification>) {}

  async create(
    userId: string,
    type: NotificationType,
    title: string,
    message: string,
  ): Promise<Notification> {
    const entity = this.repository.create({ userId, type, title, message });
    return this.repository.save(entity);
  }

  findByIdAndUserId(id: string, userId: string): Promise<Notification | null> {
    return this.repository.findOne({ where: { id, userId } });
  }

  async markRead(id: string, userId: string): Promise<Notification> {
    await this.repository.update({ id, userId }, { read: true });
    const updated = await this.repository.findOne({ where: { id, userId } });
    if (!updated) {
      throw new HttpError(404, "Notification not found.");
    }
    return updated;
  }

  async list(options: ListNotificationsOptions): Promise<NotificationPage> {
    const {
      userId,
      page = 1,
      limit = 20,
      read,
      type,
      sortOrder = "desc",
    } = options;

    const qb = this.repository
      .createQueryBuilder("n")
      .where("n.userId = :userId", { userId })
      .orderBy("n.timestamp", sortOrder === "asc" ? "ASC" : "DESC")
      .skip((page - 1) * limit)
      .take(limit);

    if (read !== undefined) {
      qb.andWhere("n.read = :read", { read });
    }

    if (type !== undefined) {
      qb.andWhere("n.type = :type", { type });
    }

    const [data, total] = await qb.getManyAndCount();

    return {
      data,
      meta: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
      },
    };
  }
}

export function createNotificationService(dataSource: DataSource): NotificationService {
  return new NotificationService(
    new TypeOrmNotificationRepository(dataSource.getRepository(Notification)),
  );
}