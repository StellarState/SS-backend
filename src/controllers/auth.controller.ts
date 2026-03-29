import type { Response } from "express";
import type { AuthService } from "../services/auth.service";
import type { AuthenticatedRequestUser } from "../types/auth";
import type { AuthenticatedRequest } from "../types/auth";

export function createAuthController(authService: AuthService) {
  return {
    // Request challenge for signing
    challenge: async (
      req: AuthenticatedRequest,
      res: Response
    ): Promise<void> => {
      const challenge = await authService.createChallenge(req.body.publicKey);
      res.status(201).json({ challenge });
    },

    // Verify signed challenge and create session
    verify: async (
      req: AuthenticatedRequest & { body: { publicKey: string; signature: string; nonce: string } },
      res: Response
    ): Promise<void> => {
      const session = await authService.verifyChallenge(req.body);
      res.status(200).json(session);
    },

    // Return current authenticated user
    me: async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      const user: AuthenticatedRequestUser | undefined = req.user;
      if (!user) {
        res.status(401).json({ message: "Unauthorized" });
        return;
      }

      res.status(200).json({ user });
    },
  };
}