import type { DataSource, Repository } from "typeorm";
import {
  sanitizeNotificationEvent,
  sanitizeNotificationText,
  type DeadLetter,
} from "../lib/notification-dispatcher";
import {
  reviveLifecycleEvent,
  type ClaimDueOptions,
  type NewNotificationJob,
  type NotificationJob,
  type NotificationJobStore,
  type RecoverLeasesOptions,
} from "../lib/notification-job-store";
import { NotificationDispatchJob } from "../models/NotificationDispatchJob.model";
import { NotificationDeadLetterAudit } from "../models/NotificationDeadLetterAudit.model";

/**
 * TypeORM-backed {@link NotificationJobStore} (issue #772).
 *
 * Claims are a select-then-conditional-update: the update repeats the due
 * predicate in its `WHERE`, so when two workers see the same candidate only
 * one update affects a row and the loser skips it. Completion and retry
 * writes additionally require `claimed_by = workerId`, so a worker whose lease
 * was taken over cannot overwrite the new owner's progress.
 */
export class TypeOrmNotificationJobStore implements NotificationJobStore {
  private readonly repository: Repository<NotificationDispatchJob>;

  constructor(dataSource: DataSource) {
    this.repository = dataSource.getRepository(NotificationDispatchJob);
  }

  async create(job: NewNotificationJob): Promise<boolean> {
    const existing = await this.repository.findOneBy({ eventId: job.eventId });
    if (existing) return false;

    await this.repository
      .createQueryBuilder()
      .insert()
      .into(NotificationDispatchJob)
      .values({
        eventId: job.eventId,
        correlationId: job.correlationId ?? null,
        event: job.event,
        status: "pending",
        attempts: 0,
        nextAttemptAt: job.nextAttemptAt,
        claimedBy: null,
        claimedAt: null,
        lastError: null,
      })
      .orIgnore()
      .execute();
    return true;
  }

  async claimDue({
    workerId,
    now,
    limit,
    leaseMs,
  }: ClaimDueOptions): Promise<NotificationJob[]> {
    const leaseCutoff = new Date(now.getTime() - leaseMs);
    const candidates = await this.repository
      .createQueryBuilder("job")
      .where(
        "(job.status = :pending AND job.nextAttemptAt <= :now) OR " +
          "(job.status = :processing AND job.claimedAt <= :cutoff)",
        { pending: "pending", processing: "processing", now, cutoff: leaseCutoff }
      )
      .orderBy("job.nextAttemptAt", "ASC")
      .take(limit)
      .getMany();

    const claimed: NotificationJob[] = [];
    for (const candidate of candidates) {
      const result = await this.repository
        .createQueryBuilder()
        .update(NotificationDispatchJob)
        .set({
          status: "processing",
          attempts: () => "attempts + 1",
          claimedBy: workerId,
          claimedAt: now,
          updatedAt: now,
        })
        .where("event_id = :eventId", { eventId: candidate.eventId })
        .andWhere(
          "((status = :pending AND next_attempt_at <= :now) OR " +
            "(status = :processing AND claimed_at <= :cutoff))",
          { pending: "pending", processing: "processing", now, cutoff: leaseCutoff }
        )
        .execute();

      if ((result.affected ?? 0) !== 1) continue;
      const row = await this.repository.findOneBy({ eventId: candidate.eventId });
      if (row) claimed.push(toJob(row));
    }
    return claimed;
  }

  async complete(eventId: string, workerId: string): Promise<boolean> {
    const result = await this.repository
      .createQueryBuilder()
      .delete()
      .from(NotificationDispatchJob)
      .where(
        "event_id = :eventId AND claimed_by = :workerId AND status = :processing",
        { eventId, workerId, processing: "processing" }
      )
      .execute();
    return (result.affected ?? 0) > 0;
  }

  async reschedule(
    eventId: string,
    workerId: string,
    attempts: number,
    nextAttemptAt: Date,
    error: string
  ): Promise<boolean> {
    const result = await this.repository
      .createQueryBuilder()
      .update(NotificationDispatchJob)
      .set({
        status: "pending",
        attempts,
        nextAttemptAt,
        lastError: sanitizeNotificationText(error),
        claimedBy: null,
        claimedAt: null,
        updatedAt: new Date(),
      })
      .where(
        "event_id = :eventId AND claimed_by = :workerId AND status = :processing",
        { eventId, workerId, processing: "processing" }
      )
      .execute();
    return (result.affected ?? 0) > 0;
  }

  async markDead(
    eventId: string,
    workerId: string,
    attempts: number,
    error: string,
    failedAt: Date
  ): Promise<boolean> {
    const result = await this.repository
      .createQueryBuilder()
      .update(NotificationDispatchJob)
      .set({
        status: "dead",
        attempts,
        lastError: sanitizeNotificationText(error),
        claimedBy: null,
        claimedAt: null,
        updatedAt: failedAt,
      })
      .where(
        "event_id = :eventId AND claimed_by = :workerId AND status = :processing",
        { eventId, workerId, processing: "processing" }
      )
      .execute();
    return (result.affected ?? 0) > 0;
  }

  async recoverExpiredLeases({ now, leaseMs }: RecoverLeasesOptions): Promise<number> {
    const leaseCutoff = new Date(now.getTime() - leaseMs);
    const result = await this.repository
      .createQueryBuilder()
      .update(NotificationDispatchJob)
      .set({ status: "pending", claimedBy: null, claimedAt: null, updatedAt: now })
      .where("status = :processing AND claimed_at <= :cutoff", {
        processing: "processing",
        cutoff: leaseCutoff,
      })
      .execute();
    return result.affected ?? 0;
  }

  async nextRunAt(leaseMs: number): Promise<Date | null> {
    const pending = await this.repository.find({
      where: { status: "pending" },
      order: { nextAttemptAt: "ASC" },
      take: 1,
    });
    const processing = await this.repository.find({
      where: { status: "processing" },
      order: { claimedAt: "ASC" },
      take: 1,
    });

    const candidates: number[] = [];
    if (pending[0]) candidates.push(new Date(pending[0].nextAttemptAt).getTime());
    if (processing[0]?.claimedAt) {
      candidates.push(new Date(processing[0].claimedAt).getTime() + leaseMs);
    }
    return candidates.length === 0 ? null : new Date(Math.min(...candidates));
  }

  async listDeadLetters(limit = 100): Promise<DeadLetter[]> {
    const rows = await this.repository.find({
      where: { status: "dead" },
      order: { updatedAt: "DESC" },
      take: limit,
    });
    return rows.map((row) => ({
      eventId: row.eventId,
      event: sanitizeNotificationEvent(reviveLifecycleEvent(row.event)),
      attempts: row.attempts,
      error: sanitizeNotificationText(row.lastError ?? "unknown error"),
      failedAt: new Date(row.updatedAt),
    }));
  }

  async replayDeadLetter(eventId: string, actorId: string, now: Date): Promise<boolean> {
    return this.repository.manager.transaction(async (manager) => {
      const result = await manager
        .getRepository(NotificationDispatchJob)
        .createQueryBuilder()
        .update(NotificationDispatchJob)
        .set({
          status: "pending",
          attempts: 0,
          nextAttemptAt: now,
          lastError: null,
          claimedBy: null,
          claimedAt: null,
          updatedAt: now,
        })
        .where("event_id = :eventId AND status = :dead", { eventId, dead: "dead" })
        .execute();
      if ((result.affected ?? 0) !== 1) return false;
      await manager.getRepository(NotificationDeadLetterAudit).save({
        eventId,
        actorId,
        action: "replayed",
      });
      return true;
    });
  }

  async discardDeadLetter(eventId: string, actorId: string, now: Date): Promise<boolean> {
    return this.repository.manager.transaction(async (manager) => {
      const result = await manager
        .getRepository(NotificationDispatchJob)
        .createQueryBuilder()
        .update(NotificationDispatchJob)
        .set({ status: "discarded", updatedAt: now })
        .where("event_id = :eventId AND status = :dead", { eventId, dead: "dead" })
        .execute();
      if ((result.affected ?? 0) !== 1) return false;
      await manager.getRepository(NotificationDeadLetterAudit).save({
        eventId,
        actorId,
        action: "discarded",
      });
      return true;
    });
  }

  async pruneDeadLetters(olderThan: Date): Promise<number> {
    const result = await this.repository
      .createQueryBuilder()
      .delete()
      .from(NotificationDispatchJob)
      .where("status = :dead AND updated_at < :cutoff", { dead: "dead", cutoff: olderThan })
      .execute();
    return result.affected ?? 0;
  }

  async countActive(): Promise<number> {
    return this.repository
      .createQueryBuilder("job")
      .where("job.status IN (:...statuses)", { statuses: ["pending", "processing"] })
      .getCount();
  }
}

function toJob(row: NotificationDispatchJob): NotificationJob {
  return {
    eventId: row.eventId,
    correlationId: row.correlationId ?? undefined,
    event: reviveLifecycleEvent(row.event),
    status: row.status,
    attempts: row.attempts,
    nextAttemptAt: new Date(row.nextAttemptAt),
    claimedBy: row.claimedBy,
    claimedAt: row.claimedAt ? new Date(row.claimedAt) : null,
    lastError: row.lastError,
    createdAt: new Date(row.createdAt),
    updatedAt: new Date(row.updatedAt),
  };
}

export function createNotificationJobStore(dataSource: DataSource): NotificationJobStore {
  return new TypeOrmNotificationJobStore(dataSource);
}
