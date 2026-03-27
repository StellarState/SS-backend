import { Router } from "express";
import Joi from "joi";
import { createAuthController } from "../controllers/auth.controller";
import { createAuthMiddleware } from "../middleware/auth.middleware";
import { validateBody } from "../middleware/validate.middleware";
import type { AuthService } from "../services/auth.service";

const challengeSchema = Joi.object({
  publicKey: Joi.string().trim().required(),
});

const verifySchema = Joi.object({
  publicKey: Joi.string().trim().required(),
  nonce: Joi.string().trim().required(),
  signature: Joi.string().trim().required(),
});

export function createAuthRouter(authService: AuthService): Router {
  const router = Router();
  const controller = createAuthController(authService);
  const authMiddleware = createAuthMiddleware(authService);

  router.post("/challenge", validateBody(challengeSchema), controller.challenge);
  router.post("/verify", validateBody(verifySchema), controller.verify);
  router.get("/me", authMiddleware, controller.me);

  return router;
}
