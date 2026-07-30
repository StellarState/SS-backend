import { Router } from "express";
import { DataSource } from "typeorm";

import { ipWhitelistMiddleware } from "@/middleware/ip-whitelist.middleware";
import { approveKYC } from "./approve-kyc";
import { rejectKYC } from "./reject-kyc";

export interface AdminRouterDependencies {
  dataSource: DataSource;
  allowedCidrs: string[];
}

export function createAdminRouter({
  dataSource,
  allowedCidrs,
}: AdminRouterDependencies): Router {
  const router = Router();
  const ipWhitelist = ipWhitelistMiddleware(allowedCidrs);

  router.use(ipWhitelist);

  router.post("/approve-kyc", (req, res) => {
    approveKYC(req, res, dataSource);
  });

  router.post("/reject-kyc", (req, res) => {
    rejectKYC(req, res, dataSource);
  });

  return router;
}