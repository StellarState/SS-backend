import type { Response, NextFunction } from "express";
import type { AcknowledgementService } from "../services/acknowledgement.service";
import type { AuthenticatedRequest } from "../types/auth";
import { HttpError } from "../utils/http-error";

/** Blocks investment actions (POST /investments) until the wallet has acknowledged current terms (#473). */
export function requireAcknowledgement(acknowledgementService: AcknowledgementService) {
  return async (
    req: AuthenticatedRequest,
    _res: Response,
    next: NextFunction,
  ): Promise<void> => {
    if (!req.user) {
      next(new HttpError(401, "Authentication required"));
      return;
    }

    try {
      const acknowledged = await acknowledgementService.hasAcknowledgedCurrentTerms(req.user.id);
      if (!acknowledged) {
        next(new HttpError(403, "Investor accreditation acknowledgement is required before investing"));
        return;
      }
      next();
    } catch (err) {
      next(err);
    }
  };
}
