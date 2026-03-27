import cors from "cors";
import express from "express";
import helmet from "helmet";
import { errorMiddleware, notFoundMiddleware } from "./middleware/error.middleware";
import { createAuthRouter } from "./routes/auth.routes";
import type { AuthService } from "./services/auth.service";

export interface AppDependencies {
  authService: AuthService;
}

export function createApp({ authService }: AppDependencies) {
  const app = express();

  app.use(helmet());
  app.use(cors());
  app.use(express.json());

  app.get("/health", (_req, res) => {
    res.status(200).json({ status: "ok" });
  });

  app.use("/api/v1/auth", createAuthRouter(authService));

  app.use(notFoundMiddleware);
  app.use(errorMiddleware);

  return app;
}
