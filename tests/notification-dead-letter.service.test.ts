import { NotificationDeadLetter, NotificationDeadLetterStatus } from "../src/models/NotificationDeadLetter.model";
import { NotificationDeadLetterAudit } from "../src/models/NotificationDeadLetterAudit.model";
import { NotificationDeadLetterRepository, NotificationDeadLetterService } from "../src/services/notification-dead-letter.service";

function makeRepository(overrides: Partial<NotificationDeadLetterRepository> = {}) {
  const deadLetter: NotificationDeadLetter = {
    id: "dead-1",
    userId: "user-1",
    type: "system",
    title: "A title",
    message: "A message",
    status: NotificationDeadLetterStatus.PENDING,
    attemptCount: 0,
    nextAttemptAt: new Date(0),
    lastError: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
  };
  return {
    deadLetter,
    save: jest.fn().mockResolvedValue(deadLetter),
    findDue: jest.fn().mockResolvedValue([deadLetter]),
    findById: jest.fn().mockResolvedValue(deadLetter),
    update: jest.fn().mockResolvedValue(undefined),
    audit: jest.fn().mockResolvedValue({} as NotificationDeadLetterAudit),
    ...overrides,
  } as jest.Mocked<NotificationDeadLetterRepository> & { deadLetter: NotificationDeadLetter };
}

describe("NotificationDeadLetterService", () => {
  it("redacts secrets before persisting a dead-letter payload", async () => {
    const repository = makeRepository();
    const service = new NotificationDeadLetterService(repository);

    await service.enqueue({
      userId: "user-1",
      type: "system",
      title: "Token=abc123",
      message: "Authorization: Bearer very-secret-token api_key=also-secret",
    });

    expect(repository.save).toHaveBeenCalledWith(expect.objectContaining({
      title: "Token=[REDACTED]",
      message: "Authorization: Bearer [REDACTED] api_key=[REDACTED]",
    }));
  });

  it("dead-letters permanent failures without another retry", async () => {
    const repository = makeRepository();
    const service = new NotificationDeadLetterService(repository);
    const error = Object.assign(new Error("invalid recipient"), { status: 400 });

    const result = await service.processDue(jest.fn().mockRejectedValue(error));

    expect(result).toEqual({ delivered: 0, retried: 0, dead: 1 });
    expect(repository.update).toHaveBeenLastCalledWith("dead-1", expect.objectContaining({ status: NotificationDeadLetterStatus.DEAD }));
    expect(repository.audit).toHaveBeenCalledWith(expect.objectContaining({ action: "dead", success: false }));
  });

  it("uses bounded backoff for retryable failures and eventually caps attempts", async () => {
    const repository = makeRepository({
      findDue: jest.fn().mockResolvedValue([{ ...makeRepository().deadLetter, attemptCount: 4 }]),
    });
    const service = new NotificationDeadLetterService(repository);

    const result = await service.processDue(jest.fn().mockRejectedValue(new Error("temporary outage")));

    expect(result).toEqual({ delivered: 0, retried: 0, dead: 1 });
    expect(repository.update).toHaveBeenLastCalledWith("dead-1", expect.objectContaining({ status: NotificationDeadLetterStatus.DEAD }));
  });

  it("audits authorized replay and discard transitions", async () => {
    const repository = makeRepository({
      findById: jest.fn().mockResolvedValue({ ...makeRepository().deadLetter, status: NotificationDeadLetterStatus.DEAD }),
    });
    const service = new NotificationDeadLetterService(repository);

    await service.replay("dead-1", "admin-1");
    await service.discard("dead-1", "admin-1");

    expect(repository.audit).toHaveBeenNthCalledWith(1, expect.objectContaining({ action: "replay", actorId: "admin-1", success: true }));
    expect(repository.audit).toHaveBeenNthCalledWith(2, expect.objectContaining({ action: "discard", actorId: "admin-1", success: true }));
  });
});
