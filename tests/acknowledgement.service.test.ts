import { DataSource } from "typeorm";
import { AcknowledgementService } from "../src/services/acknowledgement.service";
import { Acknowledgement } from "../src/models/Acknowledgement.model";

describe("AcknowledgementService", () => {
  let mockRepo: any;
  let mockDataSource: jest.Mocked<DataSource>;
  let service: AcknowledgementService;

  beforeEach(() => {
    process.env.TERMS_VERSION = "2.0";

    mockRepo = {
      create: jest.fn((data: any) => data),
      save: jest.fn((data: any) => Promise.resolve({ ...data, acknowledgedAt: new Date("2026-01-01T00:00:00.000Z") })),
      findOne: jest.fn(),
    };

    mockDataSource = {
      getRepository: jest.fn().mockReturnValue(mockRepo),
    } as any;

    service = new AcknowledgementService(mockDataSource);
  });

  it("records an acknowledgement with the current terms version", async () => {
    const result = await service.recordAcknowledgement("user-1");

    expect(mockRepo.create).toHaveBeenCalledWith({ userId: "user-1", termsVersion: "2.0" });
    expect(result.termsVersion).toBe("2.0");
  });

  it("returns acknowledged: true when a record exists for the current version", async () => {
    mockRepo.findOne.mockResolvedValue({
      userId: "user-1",
      termsVersion: "2.0",
      acknowledgedAt: new Date("2026-01-01T00:00:00.000Z"),
    } as Acknowledgement);

    const status = await service.getStatus("user-1");

    expect(status).toEqual({
      acknowledged: true,
      currentVersion: "2.0",
      acknowledgedAt: "2026-01-01T00:00:00.000Z",
    });
  });

  it("returns acknowledged: false when no record exists for the current version", async () => {
    mockRepo.findOne.mockResolvedValue(null);

    const status = await service.getStatus("user-1");

    expect(status.acknowledged).toBe(false);
    expect(status.acknowledgedAt).toBeNull();
  });

  it("requires re-acknowledgement when the terms version changes", async () => {
    // Prior acknowledgement was under version 1.0; the query filters by the
    // *current* version, so it will not match — findOne returns null.
    mockRepo.findOne.mockResolvedValue(null);

    const status = await service.getStatus("user-1");

    expect(mockRepo.findOne).toHaveBeenCalledWith({
      where: { userId: "user-1", termsVersion: "2.0" },
      order: { acknowledgedAt: "DESC" },
    });
    expect(status.acknowledged).toBe(false);
  });
});
