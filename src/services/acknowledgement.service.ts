import { DataSource } from "typeorm";
import { Acknowledgement } from "../models/Acknowledgement.model";

export interface AcknowledgementStatus {
  acknowledged: boolean;
  currentVersion: string;
  acknowledgedAt: string | null;
}

/**
 * Tracks investor acknowledgement of accreditation / terms-of-service.
 * "Current" terms version is read from TERMS_VERSION at call time (not
 * cached) so bumping the env var immediately invalidates prior
 * acknowledgements without a deploy-time migration.
 */
export class AcknowledgementService {
  constructor(private readonly dataSource: DataSource) {}

  private currentTermsVersion(): string {
    return process.env.TERMS_VERSION ?? "1.0";
  }

  async recordAcknowledgement(userId: string): Promise<Acknowledgement> {
    const repo = this.dataSource.getRepository(Acknowledgement);
    const record = repo.create({
      userId,
      termsVersion: this.currentTermsVersion(),
    });
    return repo.save(record);
  }

  async getStatus(userId: string): Promise<AcknowledgementStatus> {
    const currentVersion = this.currentTermsVersion();
    const repo = this.dataSource.getRepository(Acknowledgement);

    const latest = await repo.findOne({
      where: { userId, termsVersion: currentVersion },
      order: { acknowledgedAt: "DESC" },
    });

    return {
      acknowledged: latest !== null,
      currentVersion,
      acknowledgedAt: latest ? latest.acknowledgedAt.toISOString() : null,
    };
  }

  /** Used by the investment-gating middleware — true if re-acknowledgement is not needed. */
  async hasAcknowledgedCurrentTerms(userId: string): Promise<boolean> {
    const status = await this.getStatus(userId);
    return status.acknowledged;
  }
}

export function createAcknowledgementService(dataSource: DataSource): AcknowledgementService {
  return new AcknowledgementService(dataSource);
}
