import { DataSource, LessThanOrEqual } from "typeorm";
import type { AppConfig } from "../config/env";
import { Invoice } from "../models/Invoice.model";
import { InvoiceStatus } from "../types/enums";
import type { SettlementService } from "../services/settlement.service";
import type { AppLogger } from "../observability/logger";

type IntervalHandle = ReturnType<typeof setInterval>;

export class InvoiceMaturityWorker {
  private intervalHandle: IntervalHandle | null = null;
  private inFlight: Promise<void> | null = null;

  constructor(
    private readonly dataSource: DataSource,
    private readonly settlementService: SettlementService,
    private readonly config: AppConfig["maturity"],
    private readonly logger: AppLogger,
    private readonly setIntervalFn: typeof setInterval = setInterval,
    private readonly clearIntervalFn: typeof clearInterval = clearInterval
  ) {}

  start(): void {
    if (!this.config.enabled || this.intervalHandle) return;
    this.logger.info("Starting invoice maturity worker.", {
      intervalMs: this.config.intervalMs,
      batchSize: this.config.batchSize,
    });
    void this.scheduleTick();
    this.intervalHandle = this.setIntervalFn(() => {
      void this.scheduleTick();
    }, this.config.intervalMs);
  }

  async stop(): Promise<void> {
    if (this.intervalHandle) {
      this.clearIntervalFn(this.intervalHandle);
      this.intervalHandle = null;
    }
    await this.inFlight;
  }

  private async scheduleTick(): Promise<void> {
    if (this.inFlight) return;
    this.inFlight = this.processMaturedInvoices().finally(() => {
      this.inFlight = null;
    });
    await this.inFlight;
  }

  private async processMaturedInvoices(): Promise<void> {
    try {
      const invoices = await this.dataSource.getRepository(Invoice).find({
        where: {
          status: InvoiceStatus.FUNDED,
          dueDate: LessThanOrEqual(new Date()),
        },
        order: { dueDate: "ASC" },
        take: this.config.batchSize,
      });

      for (const invoice of invoices) {
        try {
          await this.settlementService.settleInvoice({
            invoiceId: invoice.id,
            proceeds: invoice.amount,
          });
        } catch (error) {
          this.logger.error("Failed to settle matured invoice.", {
            invoice_id: invoice.id,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    } catch (error) {
      this.logger.error("Invoice maturity worker cycle failed.", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

export function createInvoiceMaturityWorker(
  dataSource: DataSource,
  settlementService: SettlementService,
  config: AppConfig["maturity"],
  logger: AppLogger
): InvoiceMaturityWorker {
  return new InvoiceMaturityWorker(dataSource, settlementService, config, logger);
}
