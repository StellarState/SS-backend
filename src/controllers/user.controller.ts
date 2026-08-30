import type { NextFunction, Response } from "express";
import type { AuthenticatedRequest } from "../types/auth";
import { HttpError, AppError } from "../utils/http-error";
import { logger as defaultLogger, type AppLogger } from "../observability/logger";
import { isValidStellarPublicKey } from "../utils/stellar-address.utils";
import { UserType } from "../types/enums";

export interface UserRepositoryContract {
  findById(id: string): Promise<import("../models/User.model").User | null>;
  findByStellarAddress(address: string): Promise<import("../models/User.model").User | null>;
  findAll(options?: { skip?: number; take?: number }): Promise<import("../models/User.model").User[]>;
  count?(): Promise<number>;
  save(user: Partial<import("../models/User.model").User>): Promise<import("../models/User.model").User>;
}

export interface UserControllerDeps {
  userRepository: UserRepositoryContract;
  logger?: AppLogger;
}

function sanitizeString(value: unknown, maxLength = 255): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.slice(0, maxLength);
}

function toPublicUser(user: import("../models/User.model").User) {
  return {
    id: user.id,
    stellarAddress: user.stellarAddress,
    email: user.email,
    userType: user.userType,
    kycStatus: user.kycStatus,
    isKycVerified: user.isKycVerified ?? false,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
  };
}

export function createUserController(deps: UserControllerDeps) {
  const userRepository = deps.userRepository;
  const appLogger = deps.logger ?? defaultLogger;

  return {
    async getProfile(
      req: AuthenticatedRequest,
      res: Response,
      next: NextFunction,
    ): Promise<void> {
      try {
        if (!req.user?.id) {
          throw new HttpError(401, "Authentication required");
        }
        const user = await userRepository.findById(req.user.id);
        if (!user) {
          throw new HttpError(404, "User not found");
        }
        res.status(200).json({ success: true, data: toPublicUser(user) });
      } catch (error) {
        if (error instanceof HttpError || error instanceof AppError) {
          next(error);
          return;
        }
        appLogger.error("Failed to fetch user profile", {
          error: error instanceof Error ? error.message : String(error),
          userId: req.user?.id,
        });
        next(new AppError(500, "Failed to fetch profile", "PROFILE_FETCH_FAILED"));
      }
    },

    async getUserById(
      req: AuthenticatedRequest & { params: { id: string } },
      res: Response,
      next: NextFunction,
    ): Promise<void> {
      try {
        if (!req.user) {
          throw new HttpError(401, "Authentication required");
        }
        const rawId = sanitizeString(req.params.id, 64);
        if (!rawId) {
          throw new HttpError(400, "Invalid user id");
        }
        // Consistent 404 response if user does not exist
        const user = await userRepository.findById(rawId);
        if (!user) {
          throw new HttpError(404, "User not found");
        }
        res.status(200).json({ success: true, data: toPublicUser(user) });
      } catch (error) {
        if (error instanceof HttpError || error instanceof AppError) {
          next(error);
          return;
        }
        appLogger.error("Failed to fetch user by id", {
          error: error instanceof Error ? error.message : String(error),
          params: req.params,
        });
        next(new AppError(500, "Failed to fetch user", "USER_FETCH_FAILED"));
      }
    },

    async updateProfile(
      req: AuthenticatedRequest,
      res: Response,
      next: NextFunction,
    ): Promise<void> {
      try {
        if (!req.user?.id) {
          throw new HttpError(401, "Authentication required");
        }

        const email = sanitizeString(req.body?.email, 255);
        const stellarAddressRaw = sanitizeString(req.body?.stellarAddress, 56);
        const userTypeRaw = req.body?.userType;

        if (email !== null) {
          const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
          if (!emailRegex.test(email)) {
            throw new HttpError(400, "Invalid email format");
          }
        }

        if (stellarAddressRaw !== null && !isValidStellarPublicKey(stellarAddressRaw)) {
          throw new HttpError(400, "Invalid Stellar public key");
        }

        if (
          userTypeRaw !== undefined &&
          userTypeRaw !== null &&
          !Object.values(UserType).includes(userTypeRaw)
        ) {
          throw new HttpError(400, "Invalid user type");
        }

        if (email === null && stellarAddressRaw === null && (userTypeRaw === undefined || userTypeRaw === null)) {
          throw new HttpError(400, "No valid fields to update");
        }

        const existing = await userRepository.findById(req.user.id);
        if (!existing) {
          throw new HttpError(404, "User not found");
        }

        const patch: Partial<import("../models/User.model").User> = {};
        if (email !== null) patch.email = email.toLowerCase();
        if (stellarAddressRaw !== null) patch.stellarAddress = stellarAddressRaw;
        if (userTypeRaw) patch.userType = userTypeRaw;

        // Use immutable update pattern: create new object
        const updated = await userRepository.save({ ...existing, ...patch });

        appLogger.info("User profile updated", {
          userId: req.user.id,
          updatedFields: Object.keys(patch),
        });

        res.status(200).json({ success: true, data: toPublicUser(updated) });
      } catch (error) {
        if (error instanceof HttpError || error instanceof AppError) {
          next(error);
          return;
        }
        appLogger.error("Failed to update user profile", {
          error: error instanceof Error ? error.message : String(error),
          userId: req.user?.id,
        });
        next(new AppError(500, "Failed to update profile", "PROFILE_UPDATE_FAILED"));
      }
    },

    async listUsers(
      req: AuthenticatedRequest & { query: { page?: string; limit?: string } },
      res: Response,
      next: NextFunction,
    ): Promise<void> {
      try {
        if (!req.user) {
          throw new HttpError(401, "Authentication required");
        }

        // Backward-compatible pagination with sanitized bounds
        const page = Math.min(Math.max(Number(req.query.page) || 1, 1), 1000);
        const limit = Math.min(Math.max(Number(req.query.limit) || 20, 1), 100);

        let users: import("../models/User.model").User[];
        let total = 0;

        try {
          // Parallelized data and count fetching for high concurrency performance
          const [fetchedUsers, fetchedCount] = await Promise.all([
            userRepository.findAll({ skip: (page - 1) * limit, take: limit }),
            userRepository.count ? userRepository.count() : Promise.resolve(-1),
          ]);

          users = fetchedUsers;
          total = fetchedCount >= 0 ? fetchedCount : users.length;
        } catch (error) {
          appLogger.error("Failed to list users", { error });
          throw new AppError(500, "Failed to list users", "USER_LIST_FAILED");
        }

        res.status(200).json({
          success: true,
          data: users.map(toPublicUser),
          meta: { total, page, limit, totalPages: Math.ceil(total / limit) },
        });
      } catch (error) {
        if (error instanceof HttpError || error instanceof AppError) {
          next(error);
          return;
        }
        appLogger.error("Unhandled error in listUsers", {
          error: error instanceof Error ? error.message : String(error),
        });
        next(new AppError(500, "Processing failed", "USER_LIST_FAILED"));
      }
    },
  };
}
