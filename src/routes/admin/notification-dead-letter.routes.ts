import { Router } from "express";
import type { NotificationDeadLetterService } from "../../services/notification-dead-letter.service";
import { HttpError } from "../../utils/http-error";

export function createNotificationDeadLetterRouter(service: NotificationDeadLetterService): Router {
  const router = Router();
  router.use((req, _res, next) => {
    const configuredKey = process.env.ADMIN_API_KEY;
    const suppliedKey = req.header("x-admin-key");
    if (!configuredKey || !suppliedKey || suppliedKey !== configuredKey) {
      next(new HttpError(401, "Admin authorization required."));
      return;
    }
    next();
  });

  router.post("/:id/replay", async (req, res, next) => {
    try {
      const actorId = req.header("x-admin-actor") ?? "admin-api";
      res.json({ data: await service.replay(req.params.id, actorId) });
    } catch (error) { next(error); }
  });

  router.post("/:id/discard", async (req, res, next) => {
    try {
      const actorId = req.header("x-admin-actor") ?? "admin-api";
      await service.discard(req.params.id, actorId);
      res.status(204).send();
    } catch (error) { next(error); }
  });
  return router;
}
