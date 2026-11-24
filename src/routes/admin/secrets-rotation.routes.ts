import { Router, Request, Response } from "express";
import {
  evaluateSecretsRotation,
  type ManagedSecretDescriptor,
} from "@/config/secrets-rotation";

export interface AdminSecretsRotationRouterOptions {
  env?: NodeJS.ProcessEnv;
  descriptors?: readonly ManagedSecretDescriptor[];
  now?: () => Date;
}

export function createAdminSecretsRotationRouter(
  options: AdminSecretsRotationRouterOptions = {}
): Router {
  const router = Router();

  router.get("/rotation-status", (_req: Request, res: Response) => {
    const report = evaluateSecretsRotation(
      options.env ?? process.env,
      options.now ? options.now() : new Date(),
      options.descriptors
    );
    res.status(200).json({
      success: true,
      data: report,
    });
  });

  return router;
}
