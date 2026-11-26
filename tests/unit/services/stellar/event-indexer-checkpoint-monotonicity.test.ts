import { DataSource } from "typeorm";
import { EventIndexerService } from "../../../../src/services/stellar/event-indexer.service";
import { SorobanIndexerCheckpoint } from "../../../../src/models/SorobanIndexerCheckpoint.model";
import type { AppLogger } from "../../../../src/observability/logger";
import type { DecodedSorobanEvent } from "../../../../src/types/soroban.types";

describe("EventIndexerService atomic checkpoint monotonicity", () => {
  const CONTRACT_ID = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM";

  let dataSource: DataSource;
  let mockLogger: AppLogger;

  const createService = (overrides?: Partial<ConstructorParameters<typeof EventIndexerService>[0]>) =>
    new EventIndexerService({
      contractIds: [CONTRACT_ID],
      dataSource,
      checkpointRepository: dataSource.getRepository(SorobanIndexerCheckpoint),
      logger: mockLogger,
      ...overrides,
    });

  const makeEvent = (ledger: number, id = `evt-${ledger}`): DecodedSorobanEvent => ({
    id,
    contractId: CONTRACT_ID,
    ledger,
    ledgerClosedAt: "2026-08-25T12:00:00Z",
    txHash: `tx-${id}`,
    topic: "noop_event",
    topics: ["noop_event"],
    data: null,
    inSuccessfulContractCall: true,
  });

  beforeEach(async () => {
    mockLogger = {
      debug: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      child: jest.fn().mockReturnThis(),
    };

    dataSource = new DataSource({
      type: "sqlite",
      database: ":memory:",
      entities: [SorobanIndexerCheckpoint],
      synchronize: false,
    });

    await dataSource.initialize();
    await dataSource.query(`
      CREATE TABLE "soroban_indexer_checkpoints" (
        "checkpoint_key" varchar(255) PRIMARY KEY NOT NULL,
        "ledger_sequence" bigint NOT NULL,
        "updated_at" datetime NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);
  });

  afterEach(async () => {
    if (dataSource?.isInitialized) {
      await dataSource.destroy();
    }
  });

  it("keeps durable progress at 120 under interleaved update/update saves of 120 and 110", async () => {
    const replicaA = createService();
    const replicaB = createService();

    await replicaA.saveCheckpoint(100);
    expect(await replicaA.getLastIndexedLedger()).toBe(100);
    expect(await replicaB.getLastIndexedLedger()).toBe(100);

    await Promise.all([replicaA.saveCheckpoint(120), replicaB.saveCheckpoint(110)]);

    const rows = await dataSource.getRepository(SorobanIndexerCheckpoint).find();
    expect(rows).toHaveLength(1);
    expect(Number(rows[0].ledgerSequence)).toBe(120);

    // Restarted replica reads durable progress 120
    const restarted = createService();
    expect(await restarted.getLastIndexedLedger()).toBe(120);
  });

  it("yields a single row preserving the larger ledger under concurrent initial insert/insert", async () => {
    const replicaA = createService();
    const replicaB = createService();

    await Promise.all([replicaA.saveCheckpoint(120), replicaB.saveCheckpoint(110)]);

    const rows = await dataSource.getRepository(SorobanIndexerCheckpoint).find();
    expect(rows).toHaveLength(1);
    expect(Number(rows[0].ledgerSequence)).toBe(120);

    // Restarted replica reads durable progress 120
    const restarted = createService();
    expect(await restarted.getLastIndexedLedger()).toBe(120);
  });

  it("treats equal-ledger saves as harmless no-ops with unchanged persisted progress", async () => {
    const service = createService();
    await service.saveCheckpoint(150);

    const checkpointRepo = dataSource.getRepository(SorobanIndexerCheckpoint);
    const before = await checkpointRepo.find();
    expect(before).toHaveLength(1);
    expect(Number(before[0].ledgerSequence)).toBe(150);

    await service.saveCheckpoint(150);

    const after = await checkpointRepo.find();
    expect(after).toHaveLength(1);
    expect(Number(after[0].ledgerSequence)).toBe(150);
    expect(after[0].updatedAt).toEqual(before[0].updatedAt);
  });

  it("enforces the same monotonicity rule for both ingestEvents() and saveCheckpoint()", async () => {
    const replicaA = createService();
    const replicaB = createService();

    await replicaA.saveCheckpoint(120);
    await replicaB.ingestEvents([makeEvent(110)]);

    const rows = await dataSource.getRepository(SorobanIndexerCheckpoint).find();
    expect(rows).toHaveLength(1);
    expect(Number(rows[0].ledgerSequence)).toBe(120);

    // Restarted replica still sees 120
    const restarted = createService();
    expect(await restarted.getLastIndexedLedger()).toBe(120);
  });

  it("does not expose uncommitted durable progress when database persistence fails", async () => {
    const failingRepo = {
      query: jest.fn().mockRejectedValue(new Error("database unavailable")),
      findOne: jest.fn().mockResolvedValue({ checkpointKey: CONTRACT_ID, ledgerSequence: "100" }),
      manager: { connection: { options: { type: "postgres" } } },
    } as any;

    const service = new EventIndexerService({
      contractIds: [CONTRACT_ID],
      checkpointRepository: failingRepo,
      logger: mockLogger,
    });

    await expect(service.saveCheckpoint(120)).rejects.toThrow("database unavailable");
    expect(await service.getLastIndexedLedger()).toBe(100);

    // Also verify ingestEvents does not advance in-memory progress on DB failure
    const service2 = new EventIndexerService({
      contractIds: [CONTRACT_ID],
      checkpointRepository: failingRepo,
      logger: mockLogger,
    });

    await expect(service2.ingestEvents([makeEvent(130)])).rejects.toThrow("database unavailable");
    expect(await service2.getLastIndexedLedger()).toBe(100);
  });
});
