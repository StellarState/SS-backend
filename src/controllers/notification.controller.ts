import type { Request, Response } from "express";
import type { NotificationService } from "../services/notification.service";
import { NotificationType } from "../types/enums";

export function createNotificationController(
  notificationService: NotificationService,
) {
  return {
    list: async (req: Request, res: Response): Promise<void> => {
      const userId = req.user!.id;

      const page = Math.max(1, parseInt((req.query.page as string) ?? "1", 10) || 1);
      const limit = Math.min(
        100,
        Math.max(1, parseInt((req.query.limit as string) ?? "20", 10) || 20),
      );

      const readParam = req.query.read as string | undefined;
      let read: boolean | undefined;
      if (readParam === "true") read = true;
      else if (readParam === "false") read = false;

      const typeParam = req.query.type as string | undefined;
      const type =
        typeParam && Object.values(NotificationType).includes(typeParam as NotificationType)
          ? (typeParam as NotificationType)
          : undefined;

      const sortOrder =
        (req.query.sort as string) === "asc" ? ("asc" as const) : ("desc" as const);

      const result = await notificationService.listNotifications({
        userId,
        page,
        limit,
        read,
        type,
        sortOrder,
      });

      res.status(200).json(result);
    },

    markRead: async (req: Request, res: Response): Promise<void> => {
      const userId = req.user!.id;
      const id = req.params.id as string;

      const notification = await notificationService.markNotificationRead(id, userId);

      res.status(200).json({ data: notification });
    },
  };
}