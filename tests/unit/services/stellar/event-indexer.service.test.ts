import { nativeToScVal, xdr } from "@stellar/stellar-sdk";
import { EventIndexerService } from "../../../../src/services/stellar/event-indexer.service";
import { InvestmentStatus, InvoiceStatus } from "../../../../src/types/enums";
import type { AppLogger } from "../../../../src/observability/logger";

describe("EventIndexerService (Issue #135)", () => {
  const ESCROW_CONTRACT_ID = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM";
  const TOKEN_CONTRACT_ID = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";

  let mockLogger: AppLogger;
  let mockEventLogRepo: any;
  let mockCheckpointRepo: any;
  let mockInvoiceRepo: any;
  let mockInvestmentRepo: any;
  let mockRpcServer: any;

  beforeEach(() => {
    mockLogger = {
      debug: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      child: jest.fn().mockReturnThis(),
    };

    mockEventLogRepo = {
      create: jest.fn().mockImplementation((data) => data),
      save: jest.fn().mockImplementation((data) => Promise.resolve(data)),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
      findOne: jest.fn().mockImplementation(({ where }) =>
        Promise.resolve(where?.eventId ? null : { ledgerSequence: "500" }),
      ),
    };

    mockCheckpointRepo = {
      create: jest.fn().mockImplementation((data) => data),
      save: jest.fn().mockImplementation((data) => Promise.resolve(data)),
      findOne: jest.fn().mockResolvedValue(null),
    };

    mockInvoiceRepo = {
      findOne: jest.fn().mockResolvedValue({ id: "INV-100", status: InvoiceStatus.DRAFT }),
      save: jest.fn().mockImplementation((inv) => Promise.resolve(inv)),
    };

    mockInvestmentRepo = {
      findOne: jest.fn().mockResolvedValue(null),
      save: jest.fn().mockImplementation((inv) => Promise.resolve(inv)),
    };

    mockRpcServer = {
      getEvents: jest.fn().mockResolvedValue({
        events: [],
      }),
    };
  });

  describe("Initialization", () => {
    it("should throw an error when contractIds array is empty", () => {
      expect(() => new EventIndexerService({ contractIds: [] })).toThrow(
        "At least one contractId is required."
      );
    });

    it("should initialize with valid contract IDs", () => {
      const service = new EventIndexerService({
        contractIds: [ESCROW_CONTRACT_ID, TOKEN_CONTRACT_ID],
        logger: mockLogger,
      });
      expect(service.contractIds).toEqual([ESCROW_CONTRACT_ID, TOKEN_CONTRACT_ID]);
    });
  });

  describe("decodeEvent", () => {
    it("should decode raw Soroban ScVal event topics and payload data", () => {
      const service = new EventIndexerService({
        contractIds: [ESCROW_CONTRACT_ID],
        logger: mockLogger,
      });

      const topicSymbolScVal = nativeToScVal("fund_escrow", { type: "symbol" });
      const invoiceIdScVal = nativeToScVal("INV-2026-001", { type: "string" });
      const amountScVal = nativeToScVal(100_000n, { type: "i128" });

      const rawEvent = {
        id: "evt-001",
        contractId: ESCROW_CONTRACT_ID,
        ledger: 1050,
        ledgerClosedAt: "2026-08-25T12:00:00Z",
        txHash: "0xdeadbeef123",
        topic: [topicSymbolScVal.toXDR("base64"), invoiceIdScVal.toXDR("base64")],
        value: amountScVal.toXDR("base64"),
        inSuccessfulContractCall: true,
      };

      const decoded = service.decodeEvent(rawEvent as any);
      expect(decoded.id).toBe("evt-001");
      expect(decoded.contractId).toBe(ESCROW_CONTRACT_ID);
      expect(decoded.ledger).toBe(1050);
      expect(decoded.occurredAt).toEqual(new Date(rawEvent.ledgerClosedAt));
      expect(decoded.topic).toBe("fund_escrow");
      expect(decoded.topics).toEqual(["fund_escrow", "INV-2026-001"]);
      expect(BigInt(decoded.data as any)).toBe(100_000n);
    });
  });

  describe("pollContractEvents", () => {
    it("should query getEvents with contract filters and decode returned events", async () => {
      const topicScVal = nativeToScVal("create_escrow", { type: "symbol" });
      const invoiceIdScVal = nativeToScVal("INV-100", { type: "string" });

      mockRpcServer.getEvents.mockResolvedValue({
        events: [
          {
            id: "evt-002",
            contractId: ESCROW_CONTRACT_ID,
            ledger: 2000,
            ledgerClosedAt: "2026-08-25T12:05:00Z",
            txHash: "0xabcdef",
            topic: [topicScVal.toXDR("base64"), invoiceIdScVal.toXDR("base64")],
            value: null,
            inSuccessfulContractCall: true,
          },
        ],
      });

      const service = new EventIndexerService({
        contractIds: [ESCROW_CONTRACT_ID],
        server: mockRpcServer,
        eventLogRepository: mockEventLogRepo,
        logger: mockLogger,
      });

      const events = await service.pollContractEvents({ startLedger: 1999, limit: 50 });
      expect(events).toHaveLength(1);
      expect(events[0].topic).toBe("create_escrow");
      expect(events[0].ledger).toBe(2000);
      expect(mockRpcServer.getEvents).toHaveBeenCalledWith(
        expect.objectContaining({
          startLedger: 1999,
          limit: 50,
          filters: [{ type: "contract", contractIds: [ESCROW_CONTRACT_ID] }],
        })
      );
    });

    it("should follow RPC cursors until every event page has been fetched", async () => {
      const eventTopic = nativeToScVal("create_escrow", { type: "symbol" }).toXDR("base64");
      const invoiceTopic = nativeToScVal("INV-100", { type: "string" }).toXDR("base64");
      mockRpcServer.getEvents
        .mockResolvedValueOnce({
          events: [{
            id: "evt-page-1",
            contractId: ESCROW_CONTRACT_ID,
            ledger: 2000,
            ledgerClosedAt: "2026-08-25T12:05:00Z",
            txHash: "tx-page-1",
            topic: [eventTopic, invoiceTopic],
            value: null,
            inSuccessfulContractCall: true,
          }],
          cursor: "page-2",
        })
        .mockResolvedValueOnce({ events: [], cursor: undefined });

      const service = new EventIndexerService({
        contractIds: [ESCROW_CONTRACT_ID],
        server: mockRpcServer,
        logger: mockLogger,
      });

      const events = await service.pollContractEvents({ startLedger: 2000, limit: 1 });

      expect(events).toHaveLength(1);
      expect(mockRpcServer.getEvents).toHaveBeenCalledTimes(2);
      expect(mockRpcServer.getEvents).toHaveBeenLastCalledWith(
        expect.objectContaining({ cursor: "page-2" }),
      );
      expect(mockRpcServer.getEvents.mock.calls[1][0]).not.toHaveProperty("startLedger");
    });
  });

  describe("ingestEvents & State Transitions", () => {
    it("should ingest create_escrow event and transition invoice to PUBLISHED", async () => {
      const service = new EventIndexerService({
        contractIds: [ESCROW_CONTRACT_ID],
        eventLogRepository: mockEventLogRepo,
        invoiceRepository: mockInvoiceRepo,
        logger: mockLogger,
      });

      const decodedEvent = {
        id: "evt-001",
        contractId: ESCROW_CONTRACT_ID,
        ledger: 2001,
        ledgerClosedAt: "2026-08-25T12:06:00Z",
        txHash: "0x123",
        topic: "create_escrow",
        topics: ["create_escrow", "INV-100"],
        data: null,
        inSuccessfulContractCall: true,
      };

      const processed = await service.ingestEvents([decodedEvent]);
      expect(processed).toBe(1);
      expect(mockEventLogRepo.save).toHaveBeenCalled();
      expect(mockInvoiceRepo.findOne).toHaveBeenCalledWith({ where: { id: "INV-100" } });
      expect(mockInvoiceRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({ id: "INV-100", status: InvoiceStatus.PUBLISHED })
      );
    });

    it("should ingest fund_escrow event and transition invoice to FUNDED", async () => {
      mockInvoiceRepo.findOne.mockResolvedValue({ id: "INV-100", status: InvoiceStatus.PUBLISHED });

      const service = new EventIndexerService({
        contractIds: [ESCROW_CONTRACT_ID],
        eventLogRepository: mockEventLogRepo,
        invoiceRepository: mockInvoiceRepo,
        logger: mockLogger,
      });

      const decodedEvent = {
        id: "evt-002",
        contractId: ESCROW_CONTRACT_ID,
        ledger: 2002,
        ledgerClosedAt: "2026-08-25T12:07:00Z",
        txHash: "0x456",
        topic: "fund_escrow",
        topics: ["fund_escrow", "INV-100"],
        data: { amount: "500000" },
        inSuccessfulContractCall: true,
      };

      await service.ingestEvents([decodedEvent]);
      expect(mockInvoiceRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({ id: "INV-100", status: InvoiceStatus.FUNDED })
      );
    });

    it("should ingest payment_recorded event and transition invoice to REPAID", async () => {
      mockInvoiceRepo.findOne.mockResolvedValue({ id: "INV-100", status: InvoiceStatus.FUNDED });

      const service = new EventIndexerService({
        contractIds: [ESCROW_CONTRACT_ID],
        eventLogRepository: mockEventLogRepo,
        invoiceRepository: mockInvoiceRepo,
        logger: mockLogger,
      });

      const decodedEvent = {
        id: "evt-003",
        contractId: ESCROW_CONTRACT_ID,
        ledger: 2003,
        ledgerClosedAt: "2026-08-25T12:08:00Z",
        txHash: "0x789",
        topic: "payment_recorded",
        topics: ["payment_recorded", "INV-100"],
        data: null,
        inSuccessfulContractCall: true,
      };

      await service.ingestEvents([decodedEvent]);
      expect(mockInvoiceRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({ id: "INV-100", status: InvoiceStatus.SETTLED })
      );
    });

    it("should ingest settle_escrow event and transition invoice to SETTLED", async () => {
      mockInvoiceRepo.findOne.mockResolvedValue({ id: "INV-100", status: InvoiceStatus.FUNDED });

      const service = new EventIndexerService({
        contractIds: [ESCROW_CONTRACT_ID],
        eventLogRepository: mockEventLogRepo,
        invoiceRepository: mockInvoiceRepo,
        logger: mockLogger,
      });

      const decodedEvent = {
        id: "evt-004",
        contractId: ESCROW_CONTRACT_ID,
        ledger: 2004,
        ledgerClosedAt: "2026-08-25T12:09:00Z",
        txHash: "0xabc",
        topic: "settle_escrow",
        topics: ["settle_escrow", "INV-100"],
        data: null,
        inSuccessfulContractCall: true,
      };

      await service.ingestEvents([decodedEvent]);
      expect(mockInvoiceRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({ id: "INV-100", status: InvoiceStatus.SETTLED })
      );
    });

    it("skips a previously processed event on redelivery", async () => {
      mockEventLogRepo.findOne
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ processed: true });
      const service = new EventIndexerService({
        contractIds: [ESCROW_CONTRACT_ID],
        eventLogRepository: mockEventLogRepo,
        invoiceRepository: mockInvoiceRepo,
        logger: mockLogger,
      });
      const event = {
        id: "evt-duplicate",
        contractId: ESCROW_CONTRACT_ID,
        ledger: 2005,
        ledgerClosedAt: "2026-08-25T12:10:00Z",
        txHash: "0xdef",
        topic: "create_escrow",
        topics: ["create_escrow", "INV-100"],
        data: null,
        inSuccessfulContractCall: true,
      };

      await service.ingestEvents([event]);
      await service.ingestEvents([event]);

      expect(mockInvoiceRepo.save).toHaveBeenCalledTimes(1);
      expect(mockEventLogRepo.save).toHaveBeenCalledTimes(1);
    });

    it("confirms an investment identified by the event payload", async () => {
      const investment = {
        id: "investment-1",
        status: InvestmentStatus.PENDING,
        transactionHash: null,
        fundingBlock: null,
      };
      mockInvestmentRepo.findOne.mockResolvedValue(investment);
      const service = new EventIndexerService({
        contractIds: [ESCROW_CONTRACT_ID],
        investmentRepository: mockInvestmentRepo,
        logger: mockLogger,
      });

      await service.ingestEvents([
        {
          id: "evt-investment-funded",
          contractId: ESCROW_CONTRACT_ID,
          ledger: 2006,
          ledgerClosedAt: "2026-08-25T12:11:00Z",
          txHash: "0xinvestment",
          topic: "investment_funded",
          topics: ["investment_funded"],
          data: { investment_id: "investment-1" },
          inSuccessfulContractCall: true,
        },
      ]);

      expect(mockInvestmentRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({
          id: "investment-1",
          status: InvestmentStatus.CONFIRMED,
          transactionHash: "0xinvestment",
          fundingBlock: "2006",
        })
      );
    });

    it("ignores failed contract-call events for projections while retaining raw diagnostic logs (#757)", async () => {
      const mockInvestorInsightsService = {
        processEvent: jest.fn().mockResolvedValue(undefined),
      };
      const mockEventBus = {
        dispatch: jest.fn().mockResolvedValue(undefined),
      };

      const service = new EventIndexerService({
        contractIds: [ESCROW_CONTRACT_ID],
        eventLogRepository: mockEventLogRepo,
        checkpointRepository: mockCheckpointRepo,
        invoiceRepository: mockInvoiceRepo,
        investmentRepository: mockInvestmentRepo,
        investorInsightsService: mockInvestorInsightsService as any,
        eventBus: mockEventBus as any,
        logger: mockLogger,
      });

      const failedEvents = [
        {
          id: "evt-failed-invoice",
          contractId: ESCROW_CONTRACT_ID,
          ledger: 2010,
          ledgerClosedAt: "2026-08-25T12:12:00Z",
          txHash: "0xfailed1",
          topic: "create_escrow",
          topics: ["create_escrow", "INV-100"],
          data: null,
          inSuccessfulContractCall: false,
        },
        {
          id: "evt-failed-investment",
          contractId: ESCROW_CONTRACT_ID,
          ledger: 2011,
          ledgerClosedAt: "2026-08-25T12:13:00Z",
          txHash: "0xfailed2",
          topic: "investment_funded",
          topics: ["investment_funded"],
          data: { investment_id: "investment-1" },
          inSuccessfulContractCall: false,
        },
      ];

      const processed = await service.ingestEvents(failedEvents);

      expect(processed).toBe(0);
      expect(mockInvoiceRepo.findOne).not.toHaveBeenCalled();
      expect(mockInvoiceRepo.save).not.toHaveBeenCalled();
      expect(mockInvestmentRepo.findOne).not.toHaveBeenCalled();
      expect(mockInvestmentRepo.save).not.toHaveBeenCalled();
      expect(mockInvestorInsightsService.processEvent).not.toHaveBeenCalled();
      expect(mockEventBus.dispatch).not.toHaveBeenCalled();

      expect(mockEventLogRepo.save).toHaveBeenCalledTimes(2);
      expect(mockEventLogRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({
          eventId: "evt-failed-invoice",
          processed: false,
          payload: expect.objectContaining({ inSuccessfulContractCall: false }),
        })
      );
      expect(mockEventLogRepo.update).not.toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ processed: true })
      );
      expect(mockCheckpointRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({ ledgerSequence: "2011" })
      );
      expect(mockLogger.warn).toHaveBeenCalledWith(
        "Ignoring Soroban event from failed contract call",
        expect.objectContaining({ eventId: "evt-failed-invoice", ledger: 2010 })
      );
    });
  });

  describe("Last Indexed Ledger & Lifecycle", () => {
    it("should retrieve last indexed ledger from database", async () => {
      mockEventLogRepo.findOne.mockResolvedValue({ ledgerSequence: "9999" });

      const service = new EventIndexerService({
        contractIds: [ESCROW_CONTRACT_ID],
        eventLogRepository: mockEventLogRepo,
        logger: mockLogger,
      });

      const lastLedger = await service.getLastIndexedLedger();
      expect(lastLedger).toBe(9999);
    });

    it("excludes unrelated contracts and unprocessed logs when recovering progress without a checkpoint (#755)", async () => {
      const storedLogs = [
        { contractId: TOKEN_CONTRACT_ID, ledgerSequence: "15000", processed: true },
        { contractId: ESCROW_CONTRACT_ID, ledgerSequence: "12000", processed: false },
        { contractId: ESCROW_CONTRACT_ID, ledgerSequence: "4500", processed: true },
      ];

      const scopedEventLogRepo = {
        findOne: jest.fn().mockImplementation(({ where }) => {
          const allowedContracts = Array.isArray(where?.contractId?.value)
            ? where.contractId.value
            : where?.contractId
              ? [where.contractId]
              : null;

          const matching = storedLogs
            .filter((row) => {
              if (allowedContracts && !allowedContracts.includes(row.contractId)) {
                return false;
              }
              if (where?.processed !== undefined && row.processed !== where.processed) {
                return false;
              }
              return true;
            })
            .sort((a, b) => Number(b.ledgerSequence) - Number(a.ledgerSequence));

          return Promise.resolve(matching[0] ?? null);
        }),
      };

      const service = new EventIndexerService({
        contractIds: [ESCROW_CONTRACT_ID],
        eventLogRepository: scopedEventLogRepo as any,
        logger: mockLogger,
      });

      const lastLedger = await service.getLastIndexedLedger();

      expect(lastLedger).toBe(4500);
      expect(scopedEventLogRepo.findOne).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            processed: true,
          }),
          order: { ledgerSequence: "DESC" },
        })
      );
      expect(service.getLastResumeDecision()).toEqual(
        expect.objectContaining({
          action: "resume_event_log",
          resumeLedger: 4500,
        })
      );
    });

    it("starts from genesis when only unprocessed or unrelated logs exist (#755)", async () => {
      const storedLogs = [
        { contractId: TOKEN_CONTRACT_ID, ledgerSequence: "15000", processed: true },
        { contractId: ESCROW_CONTRACT_ID, ledgerSequence: "12000", processed: false },
      ];

      const scopedEventLogRepo = {
        findOne: jest.fn().mockImplementation(({ where }) => {
          const allowedContracts = Array.isArray(where?.contractId?.value)
            ? where.contractId.value
            : where?.contractId
              ? [where.contractId]
              : null;

          const matching = storedLogs
            .filter((row) => {
              if (allowedContracts && !allowedContracts.includes(row.contractId)) {
                return false;
              }
              if (where?.processed !== undefined && row.processed !== where.processed) {
                return false;
              }
              return true;
            })
            .sort((a, b) => Number(b.ledgerSequence) - Number(a.ledgerSequence));

          return Promise.resolve(matching[0] ?? null);
        }),
      };

      const service = new EventIndexerService({
        contractIds: [ESCROW_CONTRACT_ID],
        eventLogRepository: scopedEventLogRepo as any,
        logger: mockLogger,
      });

      const lastLedger = await service.getLastIndexedLedger();

      expect(lastLedger).toBe(0);
      expect(service.getLastResumeDecision()).toEqual(
        expect.objectContaining({
          action: "start_from_genesis",
          resumeLedger: 0,
        })
      );
    });

    it("persists a checkpoint independently of event rows", async () => {
      const service = new EventIndexerService({
        contractIds: [ESCROW_CONTRACT_ID],
        network: "testnet",
        checkpointRepository: mockCheckpointRepo,
        logger: mockLogger,
      });

      await service.saveCheckpoint(1200);

      expect(mockCheckpointRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({
          checkpointKey: service.getCheckpointKey(),
          ledgerSequence: "1200",
        })
      );
      expect(service.getCheckpointKey()).toMatch(/^soroban:testnet:[0-9a-f]{64}$/);
    });

    it("should start and stop timer loop without errors", () => {
      const service = new EventIndexerService({
        contractIds: [ESCROW_CONTRACT_ID],
        server: mockRpcServer,
        logger: mockLogger,
      });

      service.start(5000);
      service.stop();
      expect(mockLogger.info).toHaveBeenCalledWith(
        "Starting Soroban event indexer service",
        expect.any(Object)
      );
      expect(mockLogger.info).toHaveBeenCalledWith("Stopped Soroban event indexer service");
    });
  });

  describe("Checkpoint Identity, Network Isolation, and Legacy Migration", () => {
    const DISTRIBUTOR_CONTRACT_ID = "CC777777777777777777777777777777777777777777777777777777";

    function createInMemoryCheckpointRepo(initialRows: Record<string, string> = {}) {
      const store = new Map<string, { checkpointKey: string; ledgerSequence: string }>();
      for (const [checkpointKey, ledgerSequence] of Object.entries(initialRows)) {
        store.set(checkpointKey, { checkpointKey, ledgerSequence });
      }

      return {
        store,
        create: jest.fn().mockImplementation((data) => ({ ...data })),
        save: jest.fn().mockImplementation((data) => {
          store.set(data.checkpointKey, {
            checkpointKey: data.checkpointKey,
            ledgerSequence: String(data.ledgerSequence),
          });
          return Promise.resolve(data);
        }),
        findOne: jest.fn().mockImplementation(({ where }) => {
          const row = store.get(where?.checkpointKey);
          return Promise.resolve(row ? { ...row } : null);
        }),
      };
    }

    it("resolves identical contract sets in different orders to the same durable checkpoint key", async () => {
      const repo = createInMemoryCheckpointRepo();

      const indexerA = new EventIndexerService({
        contractIds: [ESCROW_CONTRACT_ID, TOKEN_CONTRACT_ID],
        network: "testnet",
        checkpointRepository: repo as any,
        logger: mockLogger,
      });
      const indexerB = new EventIndexerService({
        contractIds: [TOKEN_CONTRACT_ID, ESCROW_CONTRACT_ID, TOKEN_CONTRACT_ID],
        network: "testnet",
        checkpointRepository: repo as any,
        logger: mockLogger,
      });

      expect(indexerA.getCheckpointKey()).toBe(indexerB.getCheckpointKey());

      await indexerA.saveCheckpoint(4200);
      const resumedLedger = await indexerB.getLastIndexedLedger();

      expect(resumedLedger).toBe(4200);
      expect(indexerB.getLastResumeDecision()).toEqual(
        expect.objectContaining({
          action: "resume_checkpoint",
          resumeLedger: 4200,
          checkpointKey: indexerA.getCheckpointKey(),
          network: "testnet",
        })
      );
    });

    it("isolates checkpoint rows for different contract sets sharing the same first address", async () => {
      const repo = createInMemoryCheckpointRepo();

      const streamA = new EventIndexerService({
        contractIds: [ESCROW_CONTRACT_ID, TOKEN_CONTRACT_ID],
        network: "testnet",
        checkpointRepository: repo as any,
        logger: mockLogger,
      });
      const streamB = new EventIndexerService({
        contractIds: [ESCROW_CONTRACT_ID, DISTRIBUTOR_CONTRACT_ID],
        network: "testnet",
        checkpointRepository: repo as any,
        logger: mockLogger,
      });

      expect(streamA.getCheckpointKey()).not.toBe(streamB.getCheckpointKey());

      await streamA.saveCheckpoint(8000);
      expect(await streamB.getLastIndexedLedger()).toBe(0);
      expect(streamB.getLastResumeDecision()).toEqual(
        expect.objectContaining({
          action: "start_from_genesis",
          resumeLedger: 0,
        })
      );
    });

    it("prevents testnet and mainnet configurations from consuming each other's saved progress", async () => {
      const repo = createInMemoryCheckpointRepo();

      const testnetIndexer = new EventIndexerService({
        contractIds: [ESCROW_CONTRACT_ID, TOKEN_CONTRACT_ID],
        network: "testnet",
        checkpointRepository: repo as any,
        logger: mockLogger,
      });
      const mainnetIndexer = new EventIndexerService({
        contractIds: [ESCROW_CONTRACT_ID, TOKEN_CONTRACT_ID],
        network: "mainnet",
        checkpointRepository: repo as any,
        logger: mockLogger,
      });

      expect(testnetIndexer.getCheckpointKey()).not.toBe(mainnetIndexer.getCheckpointKey());
      expect(testnetIndexer.getCheckpointKey()).toContain("soroban:testnet:");
      expect(mainnetIndexer.getCheckpointKey()).toContain("soroban:mainnet:");

      await testnetIndexer.saveCheckpoint(15000);
      expect(await mainnetIndexer.getLastIndexedLedger()).toBe(0);

      await mainnetIndexer.saveCheckpoint(300);
      expect(await testnetIndexer.getLastIndexedLedger()).toBe(15000);
    });

    it("migrates a legacy single-contract checkpoint with an explicit, inspectable resume decision", async () => {
      const repo = createInMemoryCheckpointRepo({
        [ESCROW_CONTRACT_ID]: "6500",
      });

      const service = new EventIndexerService({
        contractIds: [ESCROW_CONTRACT_ID],
        network: "testnet",
        checkpointRepository: repo as any,
        logger: mockLogger,
      });

      const resumedLedger = await service.getLastIndexedLedger();

      expect(resumedLedger).toBe(6500);
      expect(repo.store.get(service.getCheckpointKey())).toEqual({
        checkpointKey: service.getCheckpointKey(),
        ledgerSequence: "6500",
      });
      expect(service.getLastResumeDecision()).toEqual(
        expect.objectContaining({
          action: "migrated_legacy_checkpoint",
          resumeLedger: 6500,
          legacyCheckpointKey: ESCROW_CONTRACT_ID,
          legacyLedger: 6500,
          checkpointKey: service.getCheckpointKey(),
        })
      );
    });

    it("backfills from genesis by default when a contract is added to a stream with a legacy checkpoint", async () => {
      const repo = createInMemoryCheckpointRepo({
        [ESCROW_CONTRACT_ID]: "9000",
      });

      const expandedIndexer = new EventIndexerService({
        contractIds: [ESCROW_CONTRACT_ID, TOKEN_CONTRACT_ID],
        network: "testnet",
        checkpointRepository: repo as any,
        logger: mockLogger,
      });

      const resumedLedger = await expandedIndexer.getLastIndexedLedger();

      expect(resumedLedger).toBe(0);
      expect(repo.store.has(expandedIndexer.getCheckpointKey())).toBe(false);
      expect(expandedIndexer.getLastResumeDecision()).toEqual(
        expect.objectContaining({
          action: "backfill_expanded_stream",
          policy: "backfill_from_genesis",
          resumeLedger: 0,
          legacyCheckpointKey: ESCROW_CONTRACT_ID,
          legacyLedger: 9000,
        })
      );
      expect(mockLogger.warn).toHaveBeenCalledWith(
        "Legacy Soroban indexer checkpoint found for expanded contract set; backfilling from genesis",
        expect.objectContaining({
          action: "backfill_expanded_stream",
          legacyCheckpointKey: ESCROW_CONTRACT_ID,
          legacyLedger: 9000,
        })
      );
    });

    it("supports explicit resume_from_legacy policy for expanded streams", async () => {
      const repo = createInMemoryCheckpointRepo({
        [ESCROW_CONTRACT_ID]: "9000",
      });

      const expandedIndexer = new EventIndexerService({
        contractIds: [ESCROW_CONTRACT_ID, TOKEN_CONTRACT_ID],
        network: "testnet",
        newStreamBackfillPolicy: "resume_from_legacy",
        checkpointRepository: repo as any,
        logger: mockLogger,
      });

      const resumedLedger = await expandedIndexer.getLastIndexedLedger();

      expect(resumedLedger).toBe(9000);
      expect(repo.store.get(expandedIndexer.getCheckpointKey())).toEqual({
        checkpointKey: expandedIndexer.getCheckpointKey(),
        ledgerSequence: "9000",
      });
      expect(expandedIndexer.getLastResumeDecision()).toEqual(
        expect.objectContaining({
          action: "migrated_legacy_checkpoint",
          policy: "resume_from_legacy",
          resumeLedger: 9000,
          legacyCheckpointKey: ESCROW_CONTRACT_ID,
          legacyLedger: 9000,
        })
      );
    });
  });
});
