import type { Request, Response } from "express";
import type { DataSource } from "typeorm";
import { Audited } from "@/utils/audited.decorator";
import { approveKYC } from "@/routes/admin/approve-kyc";
import { rejectKYC } from "@/routes/admin/reject-kyc";
import { revokeKYC } from "@/routes/admin/revoke-kyc";

export class AdminKycAuditController {
  constructor(private readonly dataSource: DataSource) {}

  @Audited("kyc.approve")
  public async approve(req: Request, res: Response) {
    return approveKYC(req as never, res, this.dataSource);
  }

  @Audited("kyc.reject")
  public async reject(req: Request, res: Response) {
    return rejectKYC(req as never, res, this.dataSource);
  }

  @Audited("kyc.revoke")
  public async revoke(req: Request, res: Response) {
    return revokeKYC(req as never, res, this.dataSource);
  }
}
