import { createHash } from "crypto";
import { SorobanRpc, scValToNative, xdr } from "stellar-sdk";
import type { DataSource, Repository } from "typeorm";
import type { AppLogger } from "../../observability/logger";
import { logger as globalLogger } from "../../observability/logger";
import { Investment } from "../../models/Investment.model";
import { Invoice } from "../../models/Invoice.model";
import { SorobanEventLog } from "../../models/SorobanEventLog.model";
import { SorobanIndexerCheckpoint } from "../../models/SorobanIndexerCheckpoint.model";
import { InvestmentStatus, InvoiceStatus } from "../../types/enums";
import type { DecodedSorobanEvent } from "../../types/soroban.types";
import type { ContractEventBus } from "../contract-event-bus.service";
import type { SettlementService } from "../settlement.service";
import { scaledBigIntToDecimalString } from "../../lib/decimal-bigint";
import type { InvestorInsightsService } from "../investor-insights.service";
import {
  parseLedgerTime,
  processingLagMs,
  type InvalidLedgerTimeReason,
  type LedgerTimeResult,
} from "../../lib/ledger-time";
import { recordReliabilityMetric } from "../../observability/reliability-metrics";

export type NewStreamBackfillPolicy = "backfill_from_genesis" | "resume_from_legacy";

export type CheckpointResumeAction =
  | "resume_checkpoint"
  | "migrated_legacy_checkpoint"
  | "backfill_expanded_stream"
  | "resume_event_log"
  | "start_from_genesis";

export interface CheckpointResumeDecision {
  checkpointKey: string;
  network: string;
  contractIds: string[];
  policy: NewStreamBackfillPolicy;
  action: CheckpointResumeAction;
  resumeLedger: number;
  legacyCheckpointKey?: string;
  legacyLedger?: number;
  reason: string;
}

export interface EventIndexerServiceDependencies {
  contractIds: string[];
  network?: string;
  newStreamBackfillPolicy?: NewStreamBackfillPolicy;
  rpcUrl?: string;
  server?: SorobanRpc.Server;
  dataSource?: DataSource;
  logger?: AppLogger;
  eventLogRepository?: Repository<SorobanEventLog>;
  checkpointRepository?: Repository<SorobanIndexerCheckpoint>;
  invoiceRepository?: Repository<Invoice>;
  investmentRepository?: Repository<Investment>;
  investorInsightsService?: InvestorInsightsService;
  lagAlertThresholdLedgers?: number;
  eventBus?: ContractEventBus;
  settlementService?: SettlementService;
}

export interface PollEventsOptions {
  startLedger?: number;
  limit?: number;
  cursor?: string;
}

export class EventIndexerService {
  readonly contractIds: string[];
  private readonly normalizedContractIds: string[];
  private readonly network: string;
  private readonly newStreamBackfillPolicy: NewStreamBackfillPolicy;
  private readonly rpcServer: SorobanRpc.Server;
  private readonly dataSource?: DataSource;
  private readonly logger: AppLogger;
  private readonly eventLogRepository?: Repository<SorobanEventLog>;
  private readonly checkpointRepository?: Repository<SorobanIndexerCheckpoint>;
  private readonly invoiceRepository?: Repository<Invoice>;
  private readonly investmentRepository?: Repository<Investment>;
  private readonly investorInsightsService?: InvestorInsightsService;
  private readonly settlementService?: SettlementService;
  private readonly checkpointId: string;
  private readonly lagAlertThresholdLedgers: number;
  private readonly eventBus?: ContractEventBus;

  private intervalHandle: NodeJS.Timeout | null = null;
  private lastIndexedLedger = 0;
  private latestObservedLedger = 0;
  private latestLedgerSeen = 0;
  private nextCursor?: string;
  private polling = false;
  private pollInFlight = false;
  private lagAlertActive = false;
  private lastResumeDecision: CheckpointResumeDecision | null = null;

  public static resolveNetworkIdentifier(network?: string, rpcUrl?: string): string {
    const explicit = network?.trim().toLowerCase();
    if (explicit) {
      return explicit;
    }

    const normalizedRpcUrl = rpcUrl?.trim().toLowerCase() ?? "";
    if (normalizedRpcUrl.includes("mainnet") || normalizedRpcUrl.includes("pubnet")) {
      return "mainnet";
    }
    if (normalizedRpcUrl.includes("futurenet")) {
      return "futurenet";
    }
    return "testnet";
  }

  public static deriveCheckpointKey(network: string, contractIds: string[]): string {
    const normalizedNetwork = network.trim().toLowerCase();
    const normalizedContracts = Array.from(
      new Set(contractIds.map((id) => id.trim()).filter(Boolean))
    ).sort();
    const digest = createHash("sha256")
      .update(`${normalizedNetwork}\0${normalizedContracts.join(",")}`)
      .digest("hex");
    return `soroban:${normalizedNetwork}:${digest}`;
  }

  constructor(dependencies: EventIndexerServiceDependencies) {
    const cleanedContractIds = (dependencies.contractIds ?? [])
      .map((id) => id.trim())
      .filter(Boolean);
    if (cleanedContractIds.length === 0) {
      throw new Error("At least one contractId is required.");
    }

    this.contractIds = Array.from(new Set(cleanedContractIds));
    this.normalizedContractIds = [...this.contractIds].sort();
    this.network = EventIndexerService.resolveNetworkIdentifier(
      dependencies.network,
      dependencies.rpcUrl
    );
    this.newStreamBackfillPolicy =
      dependencies.newStreamBackfillPolicy ?? "backfill_from_genesis";
    this.checkpointId = EventIndexerService.deriveCheckpointKey(
      this.network,
      this.normalizedContractIds
    );
    this.logger = dependencies.logger ?? globalLogger;
    this.dataSource = dependencies.dataSource;
    this.investorInsightsService = dependencies.investorInsightsService;
    this.lagAlertThresholdLedgers = dependencies.lagAlertThresholdLedgers ?? 100;
    this.eventBus = dependencies.eventBus;
    this.settlementService = dependencies.settlementService;

    if (dependencies.server) {
      this.rpcServer = dependencies.server;
    } else {
      const url = dependencies.rpcUrl ?? "https://soroban-testnet.stellar.org";
      this.rpcServer = new SorobanRpc.Server(url, {
        allowHttp: url.startsWith("http://"),
      });
    }

    if (dependencies.eventLogRepository) {
      this.eventLogRepository = dependencies.eventLogRepository;
    } else if (this.dataSource) {
      this.eventLogRepository = this.dataSource.getRepository(SorobanEventLog);
    }

    if (dependencies.checkpointRepository) {
      this.checkpointRepository = dependencies.checkpointRepository;
    } else if (this.dataSource) {
      this.checkpointRepository = this.dataSource.getRepository(SorobanIndexerCheckpoint);
    }

    if (dependencies.invoiceRepository) {
      this.invoiceRepository = dependencies.invoiceRepository;
    } else if (this.dataSource) {
      this.invoiceRepository = this.dataSource.getRepository(Invoice);
    }

    if (dependencies.investmentRepository) {
      this.investmentRepository = dependencies.investmentRepository;
    } else if (this.dataSource) {
      this.investmentRepository = this.dataSource.getRepository(Investment);
    }
  }

  public getCheckpointKey(): string {
    return this.checkpointId;
  }

  public getNetwork(): string {
    return this.network;
  }

  public getBackfillPolicy(): NewStreamBackfillPolicy {
    return this.newStreamBackfillPolicy;
  }

  public getLastResumeDecision(): CheckpointResumeDecision | null {
    return this.lastResumeDecision;
  }

  public decodeEvent(rawEvent: SorobanRpc.Api.GetEventsResponse["events"][0]): DecodedSorobanEvent {
    const decodedTopics: unknown[] = [];

    if (rawEvent.topic) {
      for (const topicXdr of rawEvent.topic) {
        try {
          const scVal =
            typeof topicXdr === "string"
              ? xdr.ScVal.fromXDR(topicXdr, "base64")
              : (topicXdr as unknown as xdr.ScVal);
          decodedTopics.push(scValToNative(scVal));
        } catch {
          decodedTopics.push(topicXdr);
        }
      }
    }

    let decodedData: unknown = null;
    if (rawEvent.value) {
      try {
        const scVal =
          typeof rawEvent.value === "string"
            ? xdr.ScVal.fromXDR(rawEvent.value, "base64")
            : (rawEvent.value as unknown as xdr.ScVal);
        decodedData = scValToNative(scVal);
      } catch {
        decodedData = rawEvent.value;
      }
    }

    const primaryTopic =
      decodedTopics.length > 0 && typeof decodedTopics[0] === "string"
        ? (decodedTopics[0] as string)
        : String(decodedTopics[0] ?? "unknown");

    const rawRecord = rawEvent as unknown as Record<string, unknown>;
    const contractIdStr = rawEvent.contractId
      ? typeof rawRecord.contractId === "string"
        ? (rawRecord.contractId as string)
        : typeof (rawEvent.contractId as unknown as { contractId?: () => string }).contractId === "function"
          ? (rawEvent.contractId as unknown as { contractId: () => string }).contractId()
          : String(rawEvent.contractId)
      : "";

    const txHash =
      typeof rawRecord.txHash === "string"
        ? rawRecord.txHash
        : typeof rawRecord.pagingToken === "string"
          ? rawRecord.pagingToken
          : rawEvent.id;
    // Same strict parser ingestion uses: a lenient `new Date()` would accept
    // zone-less or impossible dates (Feb 30 rolls forward to March).
    const occurredAt = parseLedgerTime(rawEvent.ledgerClosedAt);

    return {
      id: rawEvent.id,
      contractId: contractIdStr,
      ledger: Number(rawEvent.ledger),
      ledgerClosedAt: rawEvent.ledgerClosedAt,
      occurredAt: occurredAt.ok ? occurredAt.value : undefined,
      txHash,
      topic: primaryTopic,
      topics: decodedTopics,
      data: decodedData,
      inSuccessfulContractCall: rawEvent.inSuccessfulContractCall ?? true,
    };
  }

  public async pollContractEvents(options: PollEventsOptions = {}): Promise<DecodedSorobanEvent[]> {
    const startLedger = options.startLedger ?? (await this.getLastIndexedLedger()) + 1;

    try {
      const filters: NonNullable<SorobanRpc.Server.GetEventsRequest["filters"]> = [];
      for (let index = 0; index < this.contractIds.length; index += 5) {
        filters.push({
          type: "contract",
          contractIds: this.contractIds.slice(index, index + 5),
        });
      }

      const requestParams: SorobanRpc.Server.GetEventsRequest = {
        filters,
        limit: options.limit ?? 100,
      };

      if (startLedger > 1 && !options.cursor) {
        requestParams.startLedger = startLedger;
      }

      let cursor = options.cursor;
      const seenCursors = new Set<string>();
      const decodedEvents: DecodedSorobanEvent[] = [];

      do {
        const params: SorobanRpc.Server.GetEventsRequest = { ...requestParams };
        if (cursor) {
          params.cursor = cursor;
          delete params.startLedger;
        }

        const response = await this.rpcServer.getEvents(params);
        const responseWithCursor = response as SorobanRpc.Api.GetEventsResponse & { cursor?: string };

        this.latestObservedLedger = Math.max(this.latestObservedLedger, response.latestLedger ?? 0);
        this.latestLedgerSeen = Math.max(this.latestLedgerSeen, response.latestLedger ?? 0);

        decodedEvents.push(...(response.events ?? []).map((event) => this.decodeEvent(event)));

        const nextCursor = responseWithCursor.cursor;
        if (!nextCursor || nextCursor === cursor) break;
        if (seenCursors.has(nextCursor)) {
          throw new Error("Soroban RPC returned a repeated event cursor.");
        }
        seenCursors.add(nextCursor);
        cursor = nextCursor;
      } while (cursor);

      const lastIndexedLedger = await this.getLastIndexedLedger();
      const lag = Math.max(0, this.latestLedgerSeen - lastIndexedLedger);
      if (lag >= this.lagAlertThresholdLedgers && !this.lagAlertActive) {
        this.lagAlertActive = true;
        this.logger.warn("Soroban event indexer is behind the latest ledger", {
          latestLedger: this.latestLedgerSeen,
          lastIndexedLedger,
          lagLedgers: lag,
          thresholdLedgers: this.lagAlertThresholdLedgers,
        });
      } else if (lag < this.lagAlertThresholdLedgers) {
        this.lagAlertActive = false;
      }

      this.logger.info("Polled Soroban contract events", {
        startLedger,
        eventCount: decodedEvents.length,
      });

      return decodedEvents;
    } catch (error) {
      this.logger.error("Failed to poll Soroban contract events", {
        err: error,
        startLedger,
      });
      throw error;
    }
  }

  public async ingestEvents(events: DecodedSorobanEvent[]): Promise<number> {
    let processedCount = 0;
    let highestProcessedLedger = this.lastIndexedLedger;

    for (const incoming of events) {
      const eventId = incoming.id || `${incoming.txHash}:${incoming.topic}:${incoming.ledger}`;
      try {
        const existingLog = this.eventLogRepository
          ? await this.eventLogRepository.findOne({ where: { eventId } })
          : null;

        if (existingLog?.processed) {
          highestProcessedLedger = Math.max(highestProcessedLedger, incoming.ledger);
          processedCount++;
          continue;
        }

        const existing = this.eventLogRepository
          ? await this.eventLogRepository.findOne({
              where: { contractId: incoming.contractId, eventId: incoming.id },
            })
          : null;

        const receipts = !existing?.processed && this.dataSource?.options.type === "postgres"
          ? await this.dataSource.query(
              `SELECT 1 FROM event_replay_receipts WHERE source = $1 AND scope = $2 AND event_id = $3`,
              ["soroban_event_logs", incoming.contractId, eventId],
            ) : [];
        if (existing?.processed || receipts.length > 0) {
          processedCount++;
          continue;
        }

        // Issue #812: the first valid ledger time stored for an event is
        // authoritative. A replay may fill a missing value but never replaces
        // one, and projections always see the stored time.
        const ledgerTime = this.resolveLedgerTime(incoming, eventId, existingLog?.ledgerClosedAt);
        if (!ledgerTime.ok) {
          await this.quarantine(incoming, eventId, existingLog, ledgerTime.reason);
          // Advance past it so one bad event cannot stall the indexer; the
          // quarantined row keeps the payload for remediation and replay.
          highestProcessedLedger = Math.max(highestProcessedLedger, incoming.ledger);
          continue;
        }
        const event: DecodedSorobanEvent = {
          ...incoming,
          ledgerClosedAt: ledgerTime.value.toISOString(),
          occurredAt: ledgerTime.value,
        };

        if (this.eventLogRepository) {
          if (existingLog) {
            await this.eventLogRepository.update(
              { eventId },
              {
                processed: false,
                // Fill only: an existing ledger time is never overwritten.
                ...(existingLog.ledgerClosedAt ? {} : { ledgerClosedAt: ledgerTime.value }),
              }
            );
          } else {
            const logEntry = this.eventLogRepository.create({
              eventId,
              contractId: event.contractId,
              ledgerSequence: event.ledger.toString(),
              topic: event.topic,
              txHash: event.txHash,
              payload: {
                topics: event.topics,
                data: event.data,
                // The raw value as received, kept for audit.
                ledgerClosedAt: incoming.ledgerClosedAt,
              },
              ledgerClosedAt: ledgerTime.value,
              processed: false,
            });
            await this.eventLogRepository.save(logEntry);
          }
        }

        await this.applyEventStateTransition(event);
        await this.investorInsightsService?.processEvent(event);

        if (this.eventBus) {
          await this.eventBus.dispatch(event);
        }

        const processedAt = new Date();
        if (this.eventLogRepository) {
          await this.eventLogRepository.update(
            { eventId },
            {
              processed: true,
              processedAt,
              // A replay that arrives with a valid time releases a quarantined event.
              quarantineReason: null,
              quarantinedAt: null,
            }
          );
        }
        const lagMs = processingLagMs(ledgerTime.value, processedAt);
        if (lagMs !== null) {
          this.logger.debug("Processed Soroban event", {
            eventId,
            topic: event.topic,
            ledgerClosedAt: ledgerTime.value.toISOString(),
            processedAt: processedAt.toISOString(),
            processingLagMs: lagMs,
          });
        }

        highestProcessedLedger = Math.max(highestProcessedLedger, event.ledger);
        processedCount++;
      } catch (err) {
        this.logger.error("Error processing Soroban event", {
          err,
          eventId: incoming.id,
          topic: incoming.topic,
        });
        throw err;
      }
    }

    const checkpointLedger = Math.max(highestProcessedLedger, this.latestObservedLedger);
    if (checkpointLedger > 0) {
      await this.saveCheckpoint(checkpointLedger);
    }

    return processedCount;
  }

  /**
   * Pick the ledger time to process an event with. A stored value always
   * wins; a replay carrying a different time is logged and ignored, since
   * ledger time is fixed once the ledger closes.
   */
  private resolveLedgerTime(
    event: DecodedSorobanEvent,
    eventId: string,
    stored: Date | null | undefined,
  ): LedgerTimeResult {
    const incoming = parseLedgerTime(event.ledgerClosedAt);
    if (stored) {
      const storedTime = new Date(stored);
      if (incoming.ok && incoming.value.getTime() !== storedTime.getTime()) {
        recordReliabilityMetric("indexer_ledger_time_conflicts");
        this.logger.warn("Replayed event carried a different ledger time; keeping the stored value", {
          eventId,
          storedLedgerClosedAt: storedTime.toISOString(),
          replayedLedgerClosedAt: incoming.value.toISOString(),
        });
      }
      return { ok: true, value: storedTime };
    }
    return incoming;
  }

  /**
   * Record an event whose ledger time is invalid without projecting it.
   * The row stays `processed = false`, so retention never archives it, and
   * a later replay with a valid time releases it.
   */
  private async quarantine(
    event: DecodedSorobanEvent,
    eventId: string,
    existingLog: SorobanEventLog | null,
    reason: InvalidLedgerTimeReason,
  ): Promise<void> {
    const quarantineReason = `invalid_ledger_time:${reason}`;
    recordReliabilityMetric("indexer_events_quarantined");
    this.logger.warn("Quarantined Soroban event with an invalid ledger time", {
      eventId,
      topic: event.topic,
      ledger: event.ledger,
      reason,
      rawLedgerClosedAt: event.ledgerClosedAt ?? null,
    });

    if (!this.eventLogRepository) return;
    if (existingLog) {
      if (existingLog.quarantinedAt) return;
      await this.eventLogRepository.update(
        { eventId },
        { quarantineReason, quarantinedAt: new Date() },
      );
      return;
    }
    await this.eventLogRepository.save(
      this.eventLogRepository.create({
        eventId,
        contractId: event.contractId,
        ledgerSequence: event.ledger.toString(),
        topic: event.topic,
        txHash: event.txHash,
        payload: {
          topics: event.topics,
          data: event.data,
          ledgerClosedAt: event.ledgerClosedAt ?? null,
        },
        ledgerClosedAt: null,
        processed: false,
        quarantineReason,
        quarantinedAt: new Date(),
      }),
    );
  }

  public async saveCheckpoint(ledgerSequence: number): Promise<void> {
    if (!Number.isInteger(ledgerSequence) || ledgerSequence < 0) {
      throw new Error("ledgerSequence must be a non-negative integer.");
    }

    if (this.checkpointRepository) {
      const checkpointKey = this.getCheckpointKey();

      if (typeof this.checkpointRepository.query === "function") {
        const driverType =
          this.dataSource?.options.type ??
          this.checkpointRepository.manager?.connection?.options?.type;

        if (driverType === "sqlite" || driverType === "better-sqlite3") {
          await this.checkpointRepository.query(
            `INSERT INTO "soroban_indexer_checkpoints" ("checkpoint_key", "ledger_sequence", "updated_at")
             VALUES (?, ?, CURRENT_TIMESTAMP)
             ON CONFLICT ("checkpoint_key")
             DO UPDATE SET
               "ledger_sequence" = excluded."ledger_sequence",
               "updated_at" = CURRENT_TIMESTAMP
             WHERE CAST("soroban_indexer_checkpoints"."ledger_sequence" AS INTEGER) < CAST(excluded."ledger_sequence" AS INTEGER)`,
            [checkpointKey, ledgerSequence.toString()],
          );
        } else {
          await this.checkpointRepository.query(
            `INSERT INTO "soroban_indexer_checkpoints" ("checkpoint_key", "ledger_sequence", "updated_at")
             VALUES ($1, $2, CURRENT_TIMESTAMP)
             ON CONFLICT ("checkpoint_key")
             DO UPDATE SET
               "ledger_sequence" = EXCLUDED."ledger_sequence",
               "updated_at" = CURRENT_TIMESTAMP
             WHERE "soroban_indexer_checkpoints"."ledger_sequence" < EXCLUDED."ledger_sequence"`,
            [checkpointKey, ledgerSequence.toString()],
          );
        }
      } else {
        const checkpoint = await this.checkpointRepository.findOne({
          where: { checkpointKey },
        });

        const durableLedger = Number(checkpoint?.ledgerSequence ?? 0);
        if (ledgerSequence <= durableLedger) {
          this.lastIndexedLedger = Math.max(this.lastIndexedLedger, durableLedger);
          return;
        }

        await this.checkpointRepository.save(
          this.checkpointRepository.create({
            ...(checkpoint ?? {}),
            checkpointKey,
            ledgerSequence: ledgerSequence.toString(),
          }),
        );
      }
    }

    this.lastIndexedLedger = Math.max(this.lastIndexedLedger, ledgerSequence);
  }

  private async applyEventStateTransition(event: DecodedSorobanEvent): Promise<void> {
    const topic = event.topic.toLowerCase();

    if (topic === "create_escrow") {
      const invoiceId = this.extractInvoiceId(event);
      if (invoiceId && this.invoiceRepository) {
        const invoice = await this.invoiceRepository.findOne({ where: { id: invoiceId } });
        if (invoice && invoice.status === InvoiceStatus.DRAFT) {
          invoice.status = InvoiceStatus.PUBLISHED;
          await this.invoiceRepository.save(invoice);
        }
      }
    }

    if (topic === "fund_escrow" || topic === "fund") {
      const invoiceId = this.extractInvoiceId(event);
      if (invoiceId && this.invoiceRepository) {
        const invoice = await this.invoiceRepository.findOne({ where: { id: invoiceId } });
        if (invoice && invoice.status === InvoiceStatus.PUBLISHED) {
          invoice.status = InvoiceStatus.FUNDED;
          await this.invoiceRepository.save(invoice);
        }
      }
    }

    if (topic === "payment_recorded" || topic === "payment") {
      const invoiceId = this.extractInvoiceId(event);
      if (invoiceId && this.invoiceRepository) {
        const invoice = await this.invoiceRepository.findOne({ where: { id: invoiceId } });
        if (invoice && invoice.status === InvoiceStatus.FUNDED) {
          invoice.status = InvoiceStatus.SETTLED;
          await this.invoiceRepository.save(invoice);
        }
      }
    }

    if (topic === "settle_escrow" || topic === "settle") {
      const invoiceId = this.extractInvoiceId(event);
      if (invoiceId && this.invoiceRepository) {
        const invoice = await this.invoiceRepository.findOne({ where: { id: invoiceId } });
        if (invoice) {
          invoice.status = InvoiceStatus.SETTLED;
          await this.invoiceRepository.save(invoice);
        }
      }
    }

    if (topic === "investment_funded") {
      const investment = await this.findInvestmentForEvent(event);
      if (investment) {
        investment.status = InvestmentStatus.CONFIRMED;
        investment.transactionHash = event.txHash;
        investment.fundingBlock = String(event.ledger);
        await this.investmentRepository?.save(investment);
      }
    }
  }

  private extractSettlementProceeds(event: DecodedSorobanEvent): string {
    const data =
      event.data && typeof event.data === "object" && !Array.isArray(event.data)
        ? (event.data as Record<string, unknown>)
        : {};
    const directProceeds =
      data.proceeds ??
      data.proceeds_amount ??
      data.proceedsAmount ??
      data.total_proceeds ??
      data.totalSettlementAmount;
    if (typeof directProceeds === "string" || typeof directProceeds === "number") {
      return String(directProceeds);
    }
    if (typeof directProceeds === "bigint") {
      return scaledBigIntToDecimalString(directProceeds / 1000n);
    }

    const proceedsStroops =
      data.proceeds_stroops ??
      data.proceedsStroops ??
      data.amount_stroops ??
      data.amountStroops ??
      data.amount;
    if (
      typeof proceedsStroops === "string" ||
      typeof proceedsStroops === "number" ||
      typeof proceedsStroops === "bigint"
    ) {
      const normalized = String(proceedsStroops);
      if (!/^\d+$/.test(normalized)) {
        throw new Error(`Settlement event ${event.id} contains invalid proceeds stroops.`);
      }
      return scaledBigIntToDecimalString(BigInt(normalized) / 1000n);
    }

    throw new Error(
      `Settlement event ${event.id} does not include proceeds in decimal units or stroops.`
    );
  }

  private async findInvestmentForEvent(event: DecodedSorobanEvent): Promise<Investment | null> {
    if (!this.investmentRepository) return null;

    const investmentId = this.extractInvestmentId(event);
    if (investmentId) {
      const byId = await this.investmentRepository.findOne({ where: { id: investmentId } });
      if (byId) return byId;
    }

    return null;
  }

  private extractInvoiceId(event: DecodedSorobanEvent): string | null {
    if (event.topics.length > 1 && typeof event.topics[1] === "string") {
      return event.topics[1];
    }
    if (event.data && typeof event.data === "object") {
      const dataObj = event.data as Record<string, unknown>;
      if ("invoice_id" in dataObj) {
        return String(dataObj.invoice_id);
      }
    }
    return null;
  }

  private extractInvestmentId(event: DecodedSorobanEvent): string | null {
    if (event.data && typeof event.data === "object") {
      const dataObj = event.data as Record<string, unknown>;
      const investmentId = dataObj.investment_id ?? dataObj.investmentId;
      if (investmentId !== undefined && investmentId !== null) {
        return String(investmentId);
      }
    }
    return null;
  }

  private async findLegacyCheckpoint(): Promise<{
    checkpointKey: string;
    ledgerSequence: number;
  } | null> {
    if (!this.checkpointRepository) {
      return null;
    }

    for (const contractId of this.contractIds) {
      if (contractId === this.checkpointId) continue;
      const legacyCheckpoint = await this.checkpointRepository.findOne({
        where: { checkpointKey: contractId },
      });
      if (legacyCheckpoint && legacyCheckpoint.ledgerSequence) {
        return {
          checkpointKey: contractId,
          ledgerSequence: Number(legacyCheckpoint.ledgerSequence),
        };
      }
    }

    return null;
  }

  public async resolveCheckpointDecision(): Promise<CheckpointResumeDecision> {
    const baseDecision = {
      checkpointKey: this.getCheckpointKey(),
      network: this.network,
      contractIds: [...this.normalizedContractIds],
      policy: this.newStreamBackfillPolicy,
    };

    if (this.checkpointRepository) {
      const checkpoint = await this.checkpointRepository.findOne({
        where: { checkpointKey: this.getCheckpointKey() },
      });
      if (checkpoint && checkpoint.ledgerSequence) {
        return {
          ...baseDecision,
          action: "resume_checkpoint",
          resumeLedger: Number(checkpoint.ledgerSequence),
          reason: "Resuming from existing canonical checkpoint.",
        };
      }

      const legacy = await this.findLegacyCheckpoint();
      if (legacy) {
        const isExpandedStream = this.normalizedContractIds.length > 1;
        if (!isExpandedStream || this.newStreamBackfillPolicy === "resume_from_legacy") {
          if (legacy.ledgerSequence > 0) {
            await this.checkpointRepository.save(
              this.checkpointRepository.create({
                checkpointKey: this.getCheckpointKey(),
                ledgerSequence: legacy.ledgerSequence.toString(),
              })
            );
          }

          const decision: CheckpointResumeDecision = {
            ...baseDecision,
            action: "migrated_legacy_checkpoint",
            resumeLedger: legacy.ledgerSequence,
            legacyCheckpointKey: legacy.checkpointKey,
            legacyLedger: legacy.ledgerSequence,
            reason: isExpandedStream
              ? "Migrated legacy checkpoint to canonical stream key per resume_from_legacy policy."
              : "Migrated legacy single-contract checkpoint to canonical stream key.",
          };

          this.logger.info("Migrated legacy Soroban indexer checkpoint", {
            ...decision,
          });
          return decision;
        }

        const decision: CheckpointResumeDecision = {
          ...baseDecision,
          action: "backfill_expanded_stream",
          resumeLedger: 0,
          legacyCheckpointKey: legacy.checkpointKey,
          legacyLedger: legacy.ledgerSequence,
          reason:
            "Legacy single-contract checkpoint detected for expanded contract set; starting from ledger 0 per backfill_from_genesis policy to preserve historical events for newly added contracts.",
        };

        this.logger.warn(
          "Legacy Soroban indexer checkpoint found for expanded contract set; backfilling from genesis",
          {
            ...decision,
          }
        );
        return decision;
      }
    }

    if (
      this.eventLogRepository &&
      (this.normalizedContractIds.length === 1 ||
        this.newStreamBackfillPolicy === "resume_from_legacy")
    ) {
      const latest = await this.eventLogRepository.findOne({
        where: {},
        order: { ledgerSequence: "DESC" },
      });
      if (latest && latest.ledgerSequence) {
        return {
          ...baseDecision,
          action: "resume_event_log",
          resumeLedger: Number(latest.ledgerSequence),
          reason: "Resuming from latest recorded event log ledger.",
        };
      }
    }

    return {
      ...baseDecision,
      action: "start_from_genesis",
      resumeLedger: 0,
      reason: "No existing checkpoint found; starting from genesis.",
    };
  }

  public async getLastIndexedLedger(): Promise<number> {
    if (this.lastIndexedLedger > 0) {
      return this.lastIndexedLedger;
    }

    if (this.lastResumeDecision) {
      return this.lastResumeDecision.resumeLedger;
    }

    const decision = await this.resolveCheckpointDecision();
    this.lastResumeDecision = decision;
    this.lastIndexedLedger = decision.resumeLedger;
    return this.lastIndexedLedger;
  }

  public start(intervalMs = 10000): void {
    if (this.intervalHandle) return;

    this.logger.info("Starting Soroban event indexer service", {
      contractIds: this.contractIds,
      intervalMs,
    });

    this.intervalHandle = setInterval(async () => {
      if (this.polling) return;
      this.polling = true;
      try {
        const events = await this.pollContractEvents();
        if (events.length > 0) {
          await this.ingestEvents(events);
        }
      } catch (err) {
        this.logger.error("Error in Soroban event indexer poll cycle", { err });
      } finally {
        this.polling = false;
      }
    }, intervalMs);
  }

  public stop(): void {
    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
      this.logger.info("Stopped Soroban event indexer service");
    }
  }
}
