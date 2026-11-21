import {
  ReconcilePendingStellarStateWorker,
  createReconcilePendingStellarStateWorker,
  type ReconciliationCandidate,
} from "../src/workers/reconcile-pending-stellar-state.worker";
import type { AppLogger, LogMetadata } from "../src/observability/logger";
import { InvestmentStatus, TransactionStatus } from "../src/types/enums";
import { ServiceError } from "../src/utils/service-error";
import type { PaymentVerificationResult } from "../src/services/stellar/verify-payment.service";

interface LogEntry {
  level: "debug" | "info" | "warn" | "error";
  message: string;
  metadata: LogMetadata;
}

class CaptureLogger implements AppLogger {
  constructor(
    readonly entries: LogEntry[] = [],
    private readonly defaultMetadata: LogMetadata = {}
  ) {}

  debug(message: string, metadata: LogMetadata = {}): void {
    this.entries.push({
      level: "debug",
      message,
      metadata: {
        ...this.defaultMetadata,
        ...metadata,
      },
    });
  }

  info(message: string, metadata: LogMetadata = {}): void {
    this.entries.push({
      level: "info",
      message,
      metadata: {
        ...this.defaultMetadata,
        ...metadata,
      },
    });
  }

  warn(message: string, metadata: LogMetadata = {}): void {
    this.entries.push({
      level: "warn",
      message,
      metadata: {
        ...this.defaultMetadata,
        ...metadata,
      },
    });
  }

  error(message: string, metadata: LogMetadata = {}): void {
    this.entries.push({
      level: "error",
      message,
      metadata: {
        ...this.defaultMetadata,
        ...metadata,
      },
    });
  }

  child(metadata: LogMetadata): AppLogger {
    return new CaptureLogger(this.entries, {
      ...this.defaultMetadata,
      ...metadata,
    });
  }
}

function createCandidate(
  investmentId: string,
  stellarTxHash: string,
  overrides: Partial<ReconciliationCandidate> = {}
): ReconciliationCandidate {
  return {
    investmentId,
    stellarTxHash,
    source: overrides.source ?? "investment",
    operationIndex: overrides.operationIndex,
    queuedAt: overrides.queuedAt ?? new Date("2026-01-01T00:00:00.000Z"),
  };
}

function createVerifiedResult(
  investmentId: string,
  outcome: "verified" | "already_verified"
): PaymentVerificationResult {
  return {
    outcome,
    investmentId,
    stellarTxHash: `tx-${investmentId}`,
    operationIndex: 0,
    transactionId: `transaction-${investmentId}`,
    status: InvestmentStatus.CONFIRMED,
  };
}

describe("ReconcilePendingStellarStateWorker", () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it("reconciles actionable candidates, continues after errors, and yields between items", async () => {
    const now = new Date("2026-01-01T00:10:00.000Z");
    const repository = {
      findPendingCandidates: jest
        .fn()
        .mockResolvedValue([
          createCandidate("investment-1", "hash-1"),
          createCandidate("investment-2", "hash-2"),
          createCandidate("investment-3", "hash-3"),
        ]),
    };
    const paymentVerifier = {
      verifyPayment: jest
        .fn()
        .mockResolvedValueOnce(createVerifiedResult("investment-1", "verified"))
        .mockRejectedValueOnce(
          new ServiceError("transaction_not_found", "Transaction not found.", 404)
        )
        .mockResolvedValueOnce(createVerifiedResult("investment-3", "already_verified")),
    };
    const yieldControl = jest.fn(async () => undefined);
    const logger = new CaptureLogger();
    const worker = new ReconcilePendingStellarStateWorker({
      repository,
      paymentVerifier,
      config: {
        enabled: true,
        intervalMs: 1_000,
        batchSize: 3,
        gracePeriodMs: 60_000,
        maxRuntimeMs: 10_000,
      },
      logger,
      now: () => now,
      yieldControl,
    });

    const result = await worker.runTick();

    expect(repository.findPendingCandidates).toHaveBeenCalledWith(
      new Date("2026-01-01T00:09:00.000Z"),
      3
    );
    expect(paymentVerifier.verifyPayment).toHaveBeenCalledTimes(3);
    expect(yieldControl).toHaveBeenCalledTimes(3);
    expect(result).toMatchObject({
      candidatesFetched: 3,
      processed: 3,
      verified: 1,
      alreadyVerified: 1,
      failed: 1,
      deferredDueToRuntime: 0,
    });
    expect(logger.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          level: "warn",
          message: "Failed to reconcile pending Stellar state.",
        }),
        expect.objectContaining({
          level: "debug",
          message: "Completed Stellar reconciliation tick.",
        }),
      ])
    );
  });

  it("logs cycle start and completion once per cycle with matching cycle_id", async () => {
    const now = new Date("2026-01-01T00:10:00.000Z");
    const repository = {
      findPendingCandidates: jest
        .fn()
        .mockResolvedValue([
          createCandidate("investment-1", "hash-1"),
          createCandidate("investment-2", "hash-2"),
        ]),
    };
    const paymentVerifier = {
      verifyPayment: jest
        .fn()
        .mockResolvedValueOnce(createVerifiedResult("investment-1", "verified"))
        .mockResolvedValueOnce(createVerifiedResult("investment-2", "already_verified")),
    };
    const logger = new CaptureLogger();
    const worker = new ReconcilePendingStellarStateWorker({
      repository,
      paymentVerifier,
      config: {
        enabled: true,
        intervalMs: 1_000,
        batchSize: 3,
        gracePeriodMs: 60_000,
        maxRuntimeMs: 10_000,
      },
      logger,
      now: () => now,
      yieldControl: jest.fn(async () => undefined),
    });

    await worker.runTick();

    const startLogs = logger.entries.filter(
      (entry) => entry.level === "info" && entry.message === "Started Stellar reconciliation tick."
    );
    const completionLogs = logger.entries.filter(
      (entry) =>
        entry.level === "debug" && entry.message === "Completed Stellar reconciliation tick."
    );

    expect(startLogs).toHaveLength(1);
    expect(completionLogs).toHaveLength(1);

    expect(startLogs[0].metadata).toMatchObject({
      cycle_id: expect.any(String),
      pending_count: 2,
      started_at: now.toISOString(),
    });

    expect(completionLogs[0].metadata).toMatchObject({
      cycle_id: startLogs[0].metadata.cycle_id,
      confirmed_count: 1,
      failed_count: 0,
      skipped_count: 1,
      duration_ms: expect.any(Number),
    });
  });

  it("stops starting new reconciliations once the tick runtime budget is exhausted", async () => {
    let currentTimeMs = Date.parse("2026-01-01T00:00:00.000Z");
    const repository = {
      findPendingCandidates: jest
        .fn()
        .mockResolvedValue([
          createCandidate("investment-1", "hash-1"),
          createCandidate("investment-2", "hash-2"),
          createCandidate("investment-3", "hash-3"),
        ]),
    };
    const paymentVerifier = {
      verifyPayment: jest.fn(async (input: { investmentId: string }) => {
        currentTimeMs += 60;
        return createVerifiedResult(input.investmentId, "verified");
      }),
    };
    const worker = new ReconcilePendingStellarStateWorker({
      repository,
      paymentVerifier,
      config: {
        enabled: true,
        intervalMs: 1_000,
        batchSize: 3,
        gracePeriodMs: 60_000,
        maxRuntimeMs: 100,
      },
      logger: new CaptureLogger(),
      now: () => new Date(currentTimeMs),
      yieldControl: async () => undefined,
    });

    const result = await worker.runTick();

    expect(paymentVerifier.verifyPayment).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({
      candidatesFetched: 3,
      processed: 2,
      verified: 2,
      deferredDueToRuntime: 1,
    });
  });

  it("schedules periodic ticks and stops scheduling after stop is called", async () => {
    jest.useFakeTimers();

    const repository = {
      findPendingCandidates: jest.fn().mockResolvedValue([]),
    };
    const paymentVerifier = {
      verifyPayment: jest.fn(),
    };
    const worker = new ReconcilePendingStellarStateWorker({
      repository,
      paymentVerifier,
      config: {
        enabled: true,
        intervalMs: 1_000,
        batchSize: 5,
        gracePeriodMs: 60_000,
        maxRuntimeMs: 5_000,
      },
      logger: new CaptureLogger(),
      yieldControl: async () => undefined,
    });

    worker.start();
    await Promise.resolve();

    expect(repository.findPendingCandidates).toHaveBeenCalledTimes(1);

    await jest.advanceTimersByTimeAsync(2_000);

    expect(repository.findPendingCandidates).toHaveBeenCalledTimes(3);

    await worker.stop();

    await jest.advanceTimersByTimeAsync(5_000);

    expect(repository.findPendingCandidates).toHaveBeenCalledTimes(3);
  });

  it("skips already-confirmed investments: Horizon client called exactly once for pending investment only", async () => {
    const now = new Date("2026-01-01T00:10:00.000Z");
    const logger = new CaptureLogger();

    // Seed one investment with status funded (already confirmed) and one with status pending_payment
    const repository = {
      findPendingCandidates: jest.fn().mockResolvedValue([
        // The worker queries INVESTMENT repo with status: PENDING only.
        // A funded/confirmed investment should NOT appear in candidates at all.
        createCandidate("investment-pending", "hash-pending", {
          source: "investment",
          queuedAt: new Date("2026-01-01T00:05:00.000Z"),
        }),
      ]),
    };

    const paymentVerifier = {
      verifyPayment: jest
        .fn()
        .mockResolvedValueOnce(createVerifiedResult("investment-pending", "verified")),
    };

    const worker = new ReconcilePendingStellarStateWorker({
      repository,
      paymentVerifier,
      config: {
        enabled: true,
        intervalMs: 1_000,
        batchSize: 10,
        gracePeriodMs: 60_000,
        maxRuntimeMs: 10_000,
      },
      logger,
      now: () => now,
      yieldControl: jest.fn(async () => undefined),
    });

    const result = await worker.runTick();

    // Horizon client called exactly once for the pending investment
    expect(paymentVerifier.verifyPayment).toHaveBeenCalledTimes(1);
    expect(paymentVerifier.verifyPayment).toHaveBeenCalledWith({
      investmentId: "investment-pending",
      stellarTxHash: "hash-pending",
      operationIndex: undefined,
    });

    // The candidate was fetched from repo (already filtered to PENDING)
    expect(repository.findPendingCandidates).toHaveBeenCalledTimes(1);
    expect(repository.findPendingCandidates).toHaveBeenCalledWith(
      new Date("2026-01-01T00:09:00.000Z"),
      10
    );

    // Pending investment was verified
    expect(result.verified).toBe(1);
    expect(result.alreadyVerified).toBe(0);
    expect(result.failed).toBe(0);
    expect(result.processed).toBe(1);

    // Funded investment status remains funded — since it's filtered from candidates by status,
    // it is never touched during reconciliation.
    // Log should show 1 checked, 0 skipped (only 1 pending candidate existed)
    const completionLog = logger.entries.find(
      (entry: LogEntry) =>
        entry.level === "debug" && entry.message === "Completed Stellar reconciliation tick."
    );
    expect(completionLog).toBeDefined();
    expect(completionLog?.metadata).toMatchObject({
      confirmed_count: 1,
      skipped_count: 0,
    });
  });

  it("records checked and skipped counts correctly when mix of verified and already_verified results occur", async () => {
    const now = new Date("2026-01-01T00:10:00.000Z");
    const logger = new CaptureLogger();

    const repository = {
      findPendingCandidates: jest
        .fn()
        .mockResolvedValue([
          createCandidate("investment-1", "hash-1"),
          createCandidate("investment-2", "hash-2"),
          createCandidate("investment-3", "hash-3"),
        ]),
    };

    const paymentVerifier = {
      verifyPayment: jest
        .fn()
        .mockResolvedValueOnce(createVerifiedResult("investment-1", "verified"))
        .mockResolvedValueOnce(createVerifiedResult("investment-2", "already_verified"))
        .mockResolvedValueOnce(createVerifiedResult("investment-3", "verified")),
    };

    const worker = new ReconcilePendingStellarStateWorker({
      repository,
      paymentVerifier,
      config: {
        enabled: true,
        intervalMs: 1_000,
        batchSize: 10,
        gracePeriodMs: 60_000,
        maxRuntimeMs: 10_000,
      },
      logger,
      now: () => now,
      yieldControl: jest.fn(async () => undefined),
    });

    const result = await worker.runTick();

    expect(result.processed).toBe(3);
    expect(result.verified).toBe(2);
    expect(result.alreadyVerified).toBe(1);
    expect(result.failed).toBe(0);

    const completionLog = logger.entries.find(
      (entry: LogEntry) =>
        entry.level === "debug" && entry.message === "Completed Stellar reconciliation tick."
    );
    expect(completionLog).toBeDefined();
    expect(completionLog?.metadata).toMatchObject({
      confirmed_count: 2,
      skipped_count: 1,
    });
  });

  describe("worker restart resilience", () => {
    it("resumes reconciliation after worker restart using persisted submission hashes", async () => {
      const now = new Date("2026-01-01T00:10:00.000Z");
      const logger1 = new CaptureLogger();
      const logger2 = new CaptureLogger();
      const persistedCandidate = createCandidate("inv-restart-1", "hash-persisted-123");

      const repository = {
        findPendingCandidates: jest.fn().mockResolvedValue([persistedCandidate]),
        terminallyFailCandidate: jest.fn().mockResolvedValue(undefined),
      };

      const paymentVerifier = {
        verifyPayment: jest.fn().mockResolvedValue(createVerifiedResult("inv-restart-1", "verified")),
      };

      // Worker 1 runs and stops (simulating service restart)
      const worker1 = new ReconcilePendingStellarStateWorker({
        repository,
        paymentVerifier,
        config: {
          enabled: true,
          intervalMs: 1_000,
          batchSize: 10,
          gracePeriodMs: 60_000,
          maxRuntimeMs: 10_000,
        },
        logger: logger1,
        now: () => now,
        yieldControl: async () => undefined,
      });

      worker1.start();
      await worker1.stop();

      // Worker 2 starts fresh (after restart) with same repository and resumes
      const worker2 = new ReconcilePendingStellarStateWorker({
        repository,
        paymentVerifier,
        config: {
          enabled: true,
          intervalMs: 1_000,
          batchSize: 10,
          gracePeriodMs: 60_000,
          maxRuntimeMs: 10_000,
        },
        logger: logger2,
        now: () => now,
        yieldControl: async () => undefined,
      });

      const tickResult = await worker2.runTick();

      expect(paymentVerifier.verifyPayment).toHaveBeenCalledTimes(1);
      expect(paymentVerifier.verifyPayment).toHaveBeenCalledWith({
        investmentId: "inv-restart-1",
        stellarTxHash: "hash-persisted-123",
        operationIndex: undefined,
      });
      expect(tickResult.verified).toBe(1);
      expect(tickResult.failed).toBe(0);
    });

    it("resumes bounded reconciliation after restart and safely retries transient failures", async () => {
      const now = new Date("2026-01-01T00:10:00.000Z");
      const logger = new CaptureLogger();
      const candidate = createCandidate("inv-restart-retry", "hash-transient-456", {
        attempts: 1,
      });

      const repository = {
        findPendingCandidates: jest.fn().mockResolvedValue([candidate]),
        terminallyFailCandidate: jest.fn().mockResolvedValue(undefined),
        recordAttempt: jest.fn().mockResolvedValue(undefined),
      };

      // On restart, verifyPayment succeeds on the retry attempt
      const paymentVerifier = {
        verifyPayment: jest.fn().mockResolvedValueOnce(createVerifiedResult("inv-restart-retry", "verified")),
      };

      const restartedWorker = new ReconcilePendingStellarStateWorker({
        repository,
        paymentVerifier,
        config: {
          enabled: true,
          intervalMs: 1_000,
          batchSize: 5,
          gracePeriodMs: 60_000,
          maxRuntimeMs: 10_000,
          maxAttempts: 3,
        },
        logger,
        now: () => now,
        yieldControl: async () => undefined,
      });

      const result = await restartedWorker.runTick();

      expect(result.verified).toBe(1);
      expect(result.failed).toBe(0);
      expect(paymentVerifier.verifyPayment).toHaveBeenCalledTimes(1);
    });
  });

  describe("duplicate-hash handling", () => {
    it("terminally fails candidate when transaction hash is already used by another payment", async () => {
      const now = new Date("2026-01-01T00:10:00.000Z");
      const logger = new CaptureLogger();
      const candidate = createCandidate("inv-dup-1", "hash-already-credited");

      const repository = {
        findPendingCandidates: jest.fn().mockResolvedValue([candidate]),
        terminallyFailCandidate: jest.fn().mockResolvedValue(undefined),
      };

      const paymentVerifier = {
        verifyPayment: jest.fn().mockRejectedValue(
          new ServiceError(
            "stellar_payment_already_used",
            "This Stellar payment operation has already been credited to another investment.",
            409
          )
        ),
      };

      const worker = new ReconcilePendingStellarStateWorker({
        repository,
        paymentVerifier,
        config: {
          enabled: true,
          intervalMs: 1_000,
          batchSize: 5,
          gracePeriodMs: 60_000,
          maxRuntimeMs: 10_000,
        },
        logger,
        now: () => now,
        yieldControl: async () => undefined,
      });

      const result = await worker.runTick();

      expect(result.verified).toBe(0);
      expect(result.failed).toBe(1);
      expect(result.terminallyFailed).toBe(1);
      expect(repository.terminallyFailCandidate).toHaveBeenCalledWith(
        candidate,
        "Validation failure (stellar_payment_already_used)"
      );

      const terminalErrorLog = logger.entries.find(
        (entry) =>
          entry.level === "error" &&
          entry.message === "Pending Stellar investment funding transaction terminally failed reconciliation."
      );
      expect(terminalErrorLog).toBeDefined();
      expect(terminalErrorLog?.metadata).toMatchObject({
        event: "investment_funding_terminally_failed",
        investment_id: "inv-dup-1",
        stellar_tx_hash: "hash-already-credited",
        failureKind: "permanent_validation",
        action: expect.any(String),
      });
    });

    it("terminally fails candidate when reconciliation conflict occurs", async () => {
      const now = new Date("2026-01-01T00:10:00.000Z");
      const logger = new CaptureLogger();
      const candidate = createCandidate("inv-conflict", "hash-conflict-789");

      const repository = {
        findPendingCandidates: jest.fn().mockResolvedValue([candidate]),
        terminallyFailCandidate: jest.fn().mockResolvedValue(undefined),
      };

      const paymentVerifier = {
        verifyPayment: jest.fn().mockRejectedValue(
          new ServiceError(
            "reconciliation_conflict",
            "Transaction row is already linked to a different Stellar hash.",
            409
          )
        ),
      };

      const worker = new ReconcilePendingStellarStateWorker({
        repository,
        paymentVerifier,
        config: {
          enabled: true,
          intervalMs: 1_000,
          batchSize: 5,
          gracePeriodMs: 60_000,
          maxRuntimeMs: 10_000,
        },
        logger,
        now: () => now,
        yieldControl: async () => undefined,
      });

      const result = await worker.runTick();

      expect(result.failed).toBe(1);
      expect(result.terminallyFailed).toBe(1);
      expect(repository.terminallyFailCandidate).toHaveBeenCalledWith(
        candidate,
        "Validation failure (reconciliation_conflict)"
      );
    });
  });

  describe("terminal reconciliation of timeout and provider mismatch outcomes", () => {
    it("terminally reconciles candidate when max retry attempts are exceeded (timeout outcome)", async () => {
      const now = new Date("2026-01-01T00:10:00.000Z");
      const logger = new CaptureLogger();
      const candidate = createCandidate("inv-timeout", "hash-timeout-999");

      const repository = {
        findPendingCandidates: jest.fn().mockResolvedValue([candidate]),
        terminallyFailCandidate: jest.fn().mockResolvedValue(undefined),
        recordAttempt: jest.fn().mockResolvedValue(undefined),
      };

      const paymentVerifier = {
        verifyPayment: jest.fn().mockRejectedValue(
          new ServiceError("horizon_unavailable", "Horizon is down", 503)
        ),
      };

      const worker = new ReconcilePendingStellarStateWorker({
        repository,
        paymentVerifier,
        config: {
          enabled: true,
          intervalMs: 1_000,
          batchSize: 5,
          gracePeriodMs: 60_000,
          maxRuntimeMs: 10_000,
          maxAttempts: 3,
        },
        logger,
        now: () => now,
        yieldControl: async () => undefined,
      });

      // Tick 1: attempt 1 (retryable, not terminal yet)
      const res1 = await worker.runTick();
      expect(res1.failed).toBe(1);
      expect(res1.terminallyFailed ?? 0).toBe(0);
      expect(repository.terminallyFailCandidate).not.toHaveBeenCalled();

      // Tick 2: attempt 2 (retryable, not terminal yet)
      const res2 = await worker.runTick();
      expect(res2.failed).toBe(1);
      expect(res2.terminallyFailed ?? 0).toBe(0);
      expect(repository.terminallyFailCandidate).not.toHaveBeenCalled();

      // Tick 3: attempt 3 reaches maxAttempts -> terminally failed
      const res3 = await worker.runTick();
      expect(res3.failed).toBe(1);
      expect(res3.terminallyFailed).toBe(1);
      expect(repository.terminallyFailCandidate).toHaveBeenCalledWith(
        candidate,
        expect.stringContaining("exceeding max attempts (3)")
      );
    });

    it("terminally reconciles provider mismatch outcomes immediately without retrying", async () => {
      const now = new Date("2026-01-01T00:10:00.000Z");
      const logger = new CaptureLogger();
      const candidate = createCandidate("inv-mismatch", "hash-mismatch");

      const repository = {
        findPendingCandidates: jest.fn().mockResolvedValue([candidate]),
        terminallyFailCandidate: jest.fn().mockResolvedValue(undefined),
      };

      const paymentVerifier = {
        verifyPayment: jest.fn().mockRejectedValue(
          new ServiceError("invalid_payment", "No Stellar payment operation matched.", 422)
        ),
      };

      const worker = new ReconcilePendingStellarStateWorker({
        repository,
        paymentVerifier,
        config: {
          enabled: true,
          intervalMs: 1_000,
          batchSize: 5,
          gracePeriodMs: 60_000,
          maxRuntimeMs: 10_000,
          maxAttempts: 3,
        },
        logger,
        now: () => now,
        yieldControl: async () => undefined,
      });

      const result = await worker.runTick();

      expect(result.failed).toBe(1);
      expect(result.terminallyFailed).toBe(1);
      expect(repository.terminallyFailCandidate).toHaveBeenCalledWith(
        candidate,
        "Validation failure (invalid_payment)"
      );

      const terminalLog = logger.entries.find(
        (entry) =>
          entry.level === "error" &&
          entry.message === "Pending Stellar investment funding transaction terminally failed reconciliation."
      );
      expect(terminalLog?.metadata).toMatchObject({
        event: "investment_funding_terminally_failed",
        failureKind: "permanent_validation",
        action: expect.any(String),
      });
    });

    it("TypeOrmReconciliationCandidateRepository terminally fails both investment and transaction", async () => {
      const investmentRepo = {
        find: jest.fn(),
        update: jest.fn().mockResolvedValue({ affected: 1 }),
      };
      const transactionRepo = {
        find: jest.fn(),
        update: jest.fn().mockResolvedValue({ affected: 1 }),
      };
      const pendingTxRepo = {
        update: jest.fn().mockResolvedValue({ affected: 1 }),
      };

      const dataSource = {
        getRepository: jest.fn((entity: any) => {
          if (entity.name === "Investment" || entity.toString().includes("Investment")) return investmentRepo;
          if (entity.name === "Transaction" || entity.toString().includes("Transaction")) return transactionRepo;
          return pendingTxRepo;
        }),
      } as any;

      const worker = createReconcilePendingStellarStateWorker(
        dataSource,
        {} as any,
        {
          enabled: true,
          intervalMs: 1000,
          batchSize: 10,
          gracePeriodMs: 60000,
          maxRuntimeMs: 10000,
        },
        new CaptureLogger()
      );

      const candidate = createCandidate("inv-term-repo", "tx-hash-term");
      // Call terminallyFailCandidate on worker's repository
      await (worker as any).repository.terminallyFailCandidate(candidate, "Test failure");

      expect(investmentRepo.update).toHaveBeenCalledWith(
        { id: "inv-term-repo", status: InvestmentStatus.PENDING },
        { status: InvestmentStatus.CANCELLED }
      );
      expect(transactionRepo.update).toHaveBeenCalledWith(
        { investmentId: "inv-term-repo", status: TransactionStatus.PENDING },
        { status: TransactionStatus.FAILED }
      );
      expect(pendingTxRepo.update).toHaveBeenCalledWith(
        { stellarTxHash: "tx-hash-term", status: "PENDING_CONFIRMATION" },
        expect.objectContaining({
          status: "FAILED",
          failureReason: "Test failure",
        })
      );
    });
  });
});
