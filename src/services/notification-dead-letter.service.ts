import { DataSource, Repository } from "typeorm";
import { NotificationDeadLetter, NotificationDeadLetterStatus } from "../models/NotificationDeadLetter.model";
import { NotificationDeadLetterAudit } from "../models/NotificationDeadLetterAudit.model";
import { HttpError } from "../utils/http-error";

const MAX_ATTEMPTS = 5;
const MAX_BACKOFF_MS = 60 * 60 * 1000;

export interface NotificationDeliveryInput {
  userId: string;
  type: string;
  title: string;
  message: string;
}

export type NotificationSender = (notification: NotificationDeliveryInput) => Promise<void>;

export interface NotificationDeadLetterRepository {
  save(deadLetter: Partial<NotificationDeadLetter>): Promise<NotificationDeadLetter>;
  findDue(limit: number): Promise<NotificationDeadLetter[]>;
  findById(id: string): Promise<NotificationDeadLetter | null>;
  update(id: string, patch: Partial<NotificationDeadLetter>): Promise<void>;
  audit(input: Partial<NotificationDeadLetterAudit>): Promise<NotificationDeadLetterAudit>;
}

function redactSecrets(value: string): string {
  return value
    .replace(/(bearer\s+)[^\s,;]+/gi, "$1[REDACTED]")
    .replace(/(api[_-]?key|token|secret|password|private[_-]?key)\s*[:=]\s*[^\s,;]+/gi, "$1=[REDACTED]")
    .slice(0, 5000);
}

function errorDetails(error: unknown): { code: string | null; message: string } {
  const candidate = error as { code?: unknown; status?: unknown; message?: unknown };
  const code = typeof candidate?.code === "string" ? candidate.code.slice(0, 64) : null;
  const message = redactSecrets(typeof candidate?.message === "string" ? candidate.message : "Notification delivery failed.");
  return { code, message };
}

function isPermanentError(error: unknown): boolean {
  const status = (error as { status?: unknown })?.status;
  return typeof status === "number" && status >= 400 && status < 500 && status !== 408 && status !== 409 && status !== 429;
}

function backoffMs(attempt: number): number {
  return Math.min(MAX_BACKOFF_MS, 1000 * 2 ** Math.max(0, attempt - 1));
}

export class NotificationDeadLetterService {
  constructor(private readonly repository: NotificationDeadLetterRepository) {}

  async enqueue(input: NotificationDeliveryInput): Promise<NotificationDeadLetter> {
    return this.repository.save({
      userId: input.userId,
      type: input.type,
      title: redactSecrets(input.title).slice(0, 255),
      message: redactSecrets(input.message),
      status: NotificationDeadLetterStatus.PENDING,
      attemptCount: 0,
      nextAttemptAt: new Date(),
      lastError: null,
    });
  }

  async processDue(sender: NotificationSender, limit = 25): Promise<{ delivered: number; retried: number; dead: number }> {
    const due = await this.repository.findDue(limit);
    const result = { delivered: 0, retried: 0, dead: 0 };

    for (const deadLetter of due) {
      const attempt = deadLetter.attemptCount + 1;
      await this.repository.update(deadLetter.id, { status: NotificationDeadLetterStatus.RETRYING, attemptCount: attempt });
      try {
        await sender({ userId: deadLetter.userId, type: deadLetter.type, title: deadLetter.title, message: deadLetter.message });
        await this.repository.update(deadLetter.id, { status: NotificationDeadLetterStatus.DELIVERED, lastError: null });
        await this.repository.audit({ deadLetterId: deadLetter.id, action: "delivered", success: true });
        result.delivered++;
      } catch (error) {
        const details = errorDetails(error);
        const dead = isPermanentError(error) || attempt >= MAX_ATTEMPTS;
        await this.repository.update(deadLetter.id, {
          status: dead ? NotificationDeadLetterStatus.DEAD : NotificationDeadLetterStatus.RETRYING,
          nextAttemptAt: new Date(Date.now() + backoffMs(attempt)),
          lastError: details.message,
        });
        await this.repository.audit({
          deadLetterId: deadLetter.id,
          action: dead ? "dead" : "attempt",
          success: false,
          errorCode: details.code,
          errorMessage: details.message,
        });
        dead ? result.dead++ : result.retried++;
      }
    }
    return result;
  }

  async replay(id: string, actorId: string): Promise<NotificationDeadLetter> {
    const deadLetter = await this.requireDeadLetter(id);
    if (deadLetter.status !== NotificationDeadLetterStatus.DEAD) throw new HttpError(409, "Only dead letters can be replayed.");
    await this.repository.update(id, { status: NotificationDeadLetterStatus.PENDING, nextAttemptAt: new Date(), lastError: null });
    await this.repository.audit({ deadLetterId: id, action: "replay", actorId, success: true });
    return { ...deadLetter, status: NotificationDeadLetterStatus.PENDING, nextAttemptAt: new Date(), lastError: null };
  }

  async discard(id: string, actorId: string): Promise<void> {
    const deadLetter = await this.requireDeadLetter(id);
    if (deadLetter.status !== NotificationDeadLetterStatus.DEAD) throw new HttpError(409, "Only dead letters can be discarded.");
    await this.repository.update(id, { status: NotificationDeadLetterStatus.DISCARDED });
    await this.repository.audit({ deadLetterId: id, action: "discard", actorId, success: true });
  }

  private async requireDeadLetter(id: string): Promise<NotificationDeadLetter> {
    const deadLetter = await this.repository.findById(id);
    if (!deadLetter) throw new HttpError(404, "Dead letter not found.");
    return deadLetter;
  }
}

class TypeOrmNotificationDeadLetterRepository implements NotificationDeadLetterRepository {
  constructor(private readonly deadLetters: Repository<NotificationDeadLetter>, private readonly audits: Repository<NotificationDeadLetterAudit>) {}
  save(deadLetter: Partial<NotificationDeadLetter>) { return this.deadLetters.save(deadLetter); }
  findDue(limit: number) { return this.deadLetters.createQueryBuilder("d").where("d.status IN (:...statuses)", { statuses: [NotificationDeadLetterStatus.PENDING, NotificationDeadLetterStatus.RETRYING] }).andWhere("d.next_attempt_at <= CURRENT_TIMESTAMP").orderBy("d.next_attempt_at", "ASC").take(limit).getMany(); }
  findById(id: string) { return this.deadLetters.findOneBy({ id }); }
  async update(id: string, patch: Partial<NotificationDeadLetter>) { await this.deadLetters.update(id, patch); }
  audit(input: Partial<NotificationDeadLetterAudit>) { return this.audits.save(input); }
}

export function createNotificationDeadLetterService(dataSource: DataSource): NotificationDeadLetterService {
  return new NotificationDeadLetterService(new TypeOrmNotificationDeadLetterRepository(dataSource.getRepository(NotificationDeadLetter), dataSource.getRepository(NotificationDeadLetterAudit)));
}
