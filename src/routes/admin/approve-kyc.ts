import { Request, Response } from "express";
import { DataSource } from "typeorm";
import { User } from "@/entities/User";
import { KYCStatus } from "@/types/enums";

interface ApproveKYCBody {
  userId: string;
}

export async function approveKYC(req: Request<unknown, unknown, ApproveKYCBody>, res: Response, dataSource: DataSource) {
  try {
    const adminKey = req.headers["x-admin-key"];
    if (adminKey !== process.env.ADMIN_API_KEY) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const { userId } = req.body;

    const userRepo = dataSource.getRepository(User);
    await userRepo.update(userId, { kycStatus: KYCStatus.APPROVED });

    return res.json({ success: true });
  } catch (err: unknown) {
    const appErr = err as { status?: number; code?: string; message?: string };
    return res.status(appErr.status ?? 500).json({
      error: {
        code: appErr.code ?? "INTERNAL_ERROR",
        message: appErr.message ?? "Internal server error",
      },
    });
  }
}