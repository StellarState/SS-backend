import { DataSource } from "typeorm";
import { logger as defaultLogger, type AppLogger } from "../observability/logger";
import { KeySubscription } from "../models/KeySubscription.model";
import { User } from "../models/User.model";
import {
  SubscriptionExpiryNotifierService,
  createTypeOrmSubscriptionSource,
  type SubscriptionNotificationSink,
  type SubscriptionExpiryRunResult,
} from "../services/subscription-expiry-notifier.service";
import { createCreatorKeyRepository } from "../services/onchain-projection-repositories";

export interface SubscriptionExpiryWorkerDependencies {
  notifierService: SubscriptionExpiryNotifierService;
  logger?: AppLogger;
  now?: () => Date;
}

/**
 * Catch-up and expired-subscription policy
 * ─────────────────────────────────────────
 * On startup the scheduler immediately runs one catch-up pass before waiting
 * for the next midnight boundary.  This covers any warning window that was
 * missed because the backend was down when the midnight job would have run.
 *
 * Deduplication guarantee
 * The notifier already checks the persistent notification store via
 * `findByDedupeKey` before dispatching, so a warning that was delivered by a
 * previous process (or a sibling replica that restarted at the same time) is
 * not sent again.  Concurrent replicas that both attempt to insert the same
 * dedupeKey are serialised by a database unique constraint, and the second
 * writer treats the conflict as a benign duplicate rather than an error.
 *
 * Already-expired subscriptions
 * Subscriptions whose expiry timestamp is already in the past at the time of
 * the catch-up are skipped (status `skipped_already_expired`).  No late
 * warning is dispatched because the subscription has already lapsed; the
 * missed window is logged so operators can audit it.
 *
 * Failure isolation
 * A catch-up failure is non-fatal: errors are logged and the normal
 * midnight-aligned schedule continues unchanged, so the next scheduled run
 * still fires even if the startup check threw.
 */

/**
 * Runs the daily subscription expiry notification check once.
 * Scans active subscriptions expiring within 7 days and dispatches 7-day and 24-hour warnings.
 * The `tag` parameter labels the log entries so catch-up runs are distinguishable from
 * regularly-scheduled runs.
 */
export async function runSubscriptionExpiryJob(
  notifier: SubscriptionExpiryNotifierService,
  logger: AppLogger = defaultLogger,
  tag: "scheduled" | "startup-catchup" = "scheduled"
): Promise<SubscriptionExpiryRunResult> {
  const startedAt = Date.now();
  const jobDate = new Date().toISOString().slice(0, 10);

  logger.info("SubscriptionExpiryJob: Starting check", { tag, jobDate });

  try {
    const result = await notifier.runDailyCheck();

    const durationMs = Date.now() - startedAt;
    logger.info("SubscriptionExpiryJob: Completed successfully", {
      tag,
      jobDate,
      durationMs,
      totalChecked: result.totalChecked,
      notified7d: result.notified7d,
      notified24h: result.notified24h,
      skippedMeetsHolding: result.skippedMeetsHolding,
      skippedDuplicate: result.skippedDuplicate,
      skippedOutsideWindow: result.skippedOutsideWindow,
      skippedExpired: result.skippedExpired,
      errorsCount: result.errors.length,
    });

    return result;
  } catch (error) {
    const durationMs = Date.now() - startedAt;
    logger.error("SubscriptionExpiryJob: Failed", {
      tag,
      jobDate,
      durationMs,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    throw error;
  }
}

/**
 * Runs an immediate catch-up pass at startup to recover any warning windows that were
 * missed while the backend was down.
 *
 * Behaviour:
 *  - Runs `runSubscriptionExpiryJob` synchronously before the first midnight tick.
 *  - Already-delivered warnings are skipped automatically via the persistent deduplication
 *    store (`findByDedupeKey`), so a sibling replica that restarted at the same time cannot
 *    produce duplicate notifications.
 *  - Already-expired subscriptions are skipped (`skipped_already_expired`); no late warning
 *    is dispatched because the window has closed.
 *  - On failure the error is logged and `null` is returned; the caller's normal schedule
 *    continues unaffected.
 */
export async function runStartupCatchUpJob(
  notifier: SubscriptionExpiryNotifierService,
  logger: AppLogger = defaultLogger
): Promise<SubscriptionExpiryRunResult | null> {
  logger.info("SubscriptionExpiryJob: Running startup catch-up to recover missed warnings");
  try {
    const result = await runSubscriptionExpiryJob(notifier, logger, "startup-catchup");
    logger.info("SubscriptionExpiryJob: Startup catch-up finished", {
      totalChecked: result.totalChecked,
      notified7d: result.notified7d,
      notified24h: result.notified24h,
      skippedDuplicate: result.skippedDuplicate,
      skippedExpired: result.skippedExpired,
      errorsCount: result.errors.length,
    });
    return result;
  } catch (error) {
    // Non-fatal: the normal midnight-aligned schedule continues regardless.
    logger.error(
      "SubscriptionExpiryJob: Startup catch-up failed (non-fatal); normal schedule will still run",
      {
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      }
    );
    return null;
  }
}

/**
 * Schedules the subscription expiry job to run daily at midnight UTC.
 *
 * Recovery: a startup catch-up pass is fired immediately (non-blocking) so that
 * any warning window missed during downtime is processed before the next midnight
 * boundary.  The catch-up result is logged but its failure does not prevent
 * subsequent scheduled runs.
 *
 * Replica coordination: both the catch-up and the scheduled runs delegate
 * deduplication to the persistent notification store.  Concurrent inserts for the
 * same dedupeKey are rejected by a database unique constraint and treated as
 * benign duplicates, so multiple replicas restarting together converge safely.
 *
 * Returns a stop handle that cancels both the catch-up timeout and the recurring
 * interval without preventing in-flight jobs from completing.
 */
export function scheduleSubscriptionExpiryJob(
  notifier: SubscriptionExpiryNotifierService,
  logger: AppLogger = defaultLogger,
  _now?: () => Date   // injectable clock – used by tests; production code ignores it
): { stop: () => void } {
  const nowFn: () => Date = _now ?? (() => new Date());
  let catchUpTimeout: ReturnType<typeof setTimeout> | null = null;
  let midnightTimeout: ReturnType<typeof setTimeout> | null = null;
  let interval: ReturnType<typeof setInterval> | null = null;
  let stopped = false;

  function msUntilMidnightUTC(): number {
    const now = nowFn();
    const tomorrow = new Date(now);
    tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
    tomorrow.setUTCHours(0, 0, 0, 0);
    return tomorrow.getTime() - now.getTime();
  }

  async function runScheduledJob(): Promise<void> {
    if (stopped) return;
    try {
      await runSubscriptionExpiryJob(notifier, logger, "scheduled");
    } catch {
      // Errors logged inside runSubscriptionExpiryJob; keep interval alive.
    }
  }

  // ── 1. Startup catch-up (runs immediately, non-blocking) ──────────────────
  catchUpTimeout = setTimeout(() => {
    if (stopped) return;
    void runStartupCatchUpJob(notifier, logger);
  }, 0);

  // ── 2. Midnight-aligned recurring schedule ────────────────────────────────
  const delayMs = msUntilMidnightUTC();
  logger.info("SubscriptionExpiryJob: Scheduled", {
    firstRunInMs: delayMs,
    firstRunAt: new Date(nowFn().getTime() + delayMs).toISOString(),
  });

  midnightTimeout = setTimeout(() => {
    if (stopped) return;
    void runScheduledJob();
    interval = setInterval(() => void runScheduledJob(), 24 * 60 * 60 * 1000);
    if (interval.unref) interval.unref();
  }, delayMs);

  if (catchUpTimeout.unref) catchUpTimeout.unref();
  if (midnightTimeout.unref) midnightTimeout.unref();

  return {
    stop: () => {
      stopped = true;
      if (catchUpTimeout) clearTimeout(catchUpTimeout);
      if (midnightTimeout) clearTimeout(midnightTimeout);
      if (interval) clearInterval(interval);
      logger.info("SubscriptionExpiryJob: Cancelled schedule");
    },
  };
}

/**
 * Helper to construct the full notifier service wired with DataSource.
 */
export function buildSubscriptionExpiryNotifier(
  dataSource: DataSource,
  notificationService: SubscriptionNotificationSink,
  logger: AppLogger = defaultLogger
): SubscriptionExpiryNotifierService {
  const keySubRepo = dataSource.getRepository(KeySubscription);
  const userRepo = dataSource.getRepository(User);
  const creatorKeyRepo = createCreatorKeyRepository(dataSource);
  const subscriptionSource = createTypeOrmSubscriptionSource(keySubRepo);

  return new SubscriptionExpiryNotifierService({
    notificationService,
    subscriptionSource,
    creatorKeyRepository: creatorKeyRepo,
    userRepository: userRepo,
    logger,
  });
}
