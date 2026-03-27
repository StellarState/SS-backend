import type { Request, Response } from "express";
import type { AuthService } from "../services/auth.service";

export function createAuthController(authService: AuthService) {
  return {
    challenge: async (req: Request, res: Response): Promise<void> => {
      const challenge = await authService.createChallenge(req.body.publicKey);

      res.status(201).json({
        challenge,
      });
    },
    verify: async (req: Request, res: Response): Promise<void> => {
      const session = await authService.verifyChallenge(req.body);

      res.status(200).json(session);
    },
    me: async (req: Request, res: Response): Promise<void> => {
      res.status(200).json({
        user: req.user,
      });
    },
  };
}
