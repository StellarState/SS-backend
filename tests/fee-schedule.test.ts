import express from "express";
import request from "supertest";
import { DataSource } from "typeorm";
import {
  FEE_RATE_FIELDS,
  FeeRateField,
  FeeScheduleService,
  UpdateFeeScheduleInput,
} from "../src/services/fee-schedule.service";
import { FeeSchedule, FeeScheduleHistory } from "../src/models/FeeSchedule.model";
import { createAdminFeesRouter } from "../src/routes/admin/fees.routes";
import { createErrorMiddleware } from "../src/middleware/error.middleware";
import { logger } from "../src/observability/logger";
import type { AuthenticatedRequest } from "../src/types/auth";
import { KYCStatus, UserType } from "../src/types/enums";
import { createTestDataSource } from "./helpers/test-data-source";

describe("FeeScheduleService & FeeScheduleController", () => {
  let dataSource: DataSource;
  let feeScheduleService: FeeScheduleService;

  async function seedActiveSchedule(overrides: Partial<FeeSchedule> = {}): Promise<FeeSchedule> {
    const repository = dataSource.getRepository(FeeSchedule);
    const schedule = repository.create({
      investmentFeeBps: 100,
      settlementFeeBps: 50,
      platformFeeBps: 100,
      secondaryMarketFeeBps: 150,
      isActive: true,
      effectiveFrom: new Date(),
      ...overrides,
    });
    return repository.save(schedule);
  }

  beforeAll(async () => {
    dataSource = await createTestDataSource();
    await dataSource.synchronize(true);
    feeScheduleService = new FeeScheduleService(dataSource);
  });

  afterAll(async () => {
    await dataSource.destroy();
  });

  beforeEach(async () => {
    jest.restoreAllMocks();
    // FeeScheduleHistory.feeSchedule FKs back to FeeSchedule, so the child
    // table must be cleared first or sqlite rejects deleting a still-
    // referenced parent row left over from the previous test.
    await dataSource.getRepository(FeeScheduleHistory).clear();
    await dataSource.getRepository(FeeSchedule).clear();
  });

  describe("getCurrentFeeSchedule", () => {
    it("should return the current active fee schedule", async () => {
      await seedActiveSchedule();

      const result = await feeScheduleService.getCurrentFeeSchedule();

      expect(result).toEqual({
        investmentFeeBps: 100,
        settlementFeeBps: 50,
        platformFeeBps: 100,
        secondaryMarketFeeBps: 150,
        effectiveFrom: expect.any(Date),
        effectiveUntil: null,
        isActive: true,
      });
    });

    it("should throw error when no active schedule exists", async () => {
      await expect(feeScheduleService.getCurrentFeeSchedule()).rejects.toMatchObject({
        code: "NO_ACTIVE_FEE_SCHEDULE",
        statusCode: 404,
      });
    });
  });

  describe("updateFeeSchedule", () => {
    it("should update fee rates and create history entry", async () => {
      await seedActiveSchedule();

      const result = await feeScheduleService.updateFeeSchedule(
        {
          investmentFeeBps: 200,
          settlementFeeBps: 75,
          changeReason: "Test update",
        },
        "GDADMINWALLET",
        "admin"
      );

      expect(result.investmentFeeBps).toBe(200);
      expect(result.settlementFeeBps).toBe(75);
      expect(result.platformFeeBps).toBe(100);
      expect(result.secondaryMarketFeeBps).toBe(150);

      const historyRepository = dataSource.getRepository(FeeScheduleHistory);
      const history = await historyRepository.findOne({ where: { actorWallet: "GDADMINWALLET" } });

      expect(history).toBeDefined();
      expect(history?.oldInvestmentFeeBps).toBe(100);
      expect(history?.newInvestmentFeeBps).toBe(200);
      expect(history?.changeReason).toBe("Test update");
    });

    it("should accept inclusive boundary integer values 0 and 1000 for all four fee fields", async () => {
      await seedActiveSchedule();

      const zeroResult = await feeScheduleService.updateFeeSchedule(
        {
          investmentFeeBps: 0,
          settlementFeeBps: 0,
          platformFeeBps: 0,
          secondaryMarketFeeBps: 0,
          changeReason: "Zero fee promotion",
        },
        "GDADMINWALLET",
        "admin"
      );

      expect(zeroResult).toMatchObject({
        investmentFeeBps: 0,
        settlementFeeBps: 0,
        platformFeeBps: 0,
        secondaryMarketFeeBps: 0,
        isActive: true,
      });

      const maxResult = await feeScheduleService.updateFeeSchedule(
        {
          investmentFeeBps: 1000,
          settlementFeeBps: 1000,
          platformFeeBps: 1000,
          secondaryMarketFeeBps: 1000,
          changeReason: "Max fee cap",
        },
        "GDADMINWALLET",
        "admin"
      );

      expect(maxResult).toMatchObject({
        investmentFeeBps: 1000,
        settlementFeeBps: 1000,
        platformFeeBps: 1000,
        secondaryMarketFeeBps: 1000,
        isActive: true,
      });
    });

    it.each(FEE_RATE_FIELDS)(
      "should preserve omitted valid fields on partial update of %s",
      async (field: FeeRateField) => {
        await seedActiveSchedule({
          investmentFeeBps: 110,
          settlementFeeBps: 60,
          platformFeeBps: 90,
          secondaryMarketFeeBps: 140,
        });

        const result = await feeScheduleService.updateFeeSchedule(
          { [field]: 325 } as UpdateFeeScheduleInput,
          "GDADMINWALLET",
          "admin"
        );

        expect(result).toMatchObject({
          investmentFeeBps: field === "investmentFeeBps" ? 325 : 110,
          settlementFeeBps: field === "settlementFeeBps" ? 325 : 60,
          platformFeeBps: field === "platformFeeBps" ? 325 : 90,
          secondaryMarketFeeBps: field === "secondaryMarketFeeBps" ? 325 : 140,
        });
      }
    );

    it("should validate fee rate bounds", async () => {
      await seedActiveSchedule();

      await expect(
        feeScheduleService.updateFeeSchedule({ investmentFeeBps: 1500 }, "GDADMINWALLET", "admin")
      ).rejects.toMatchObject({
        code: "INVALID_FEE_RATE",
        statusCode: 400,
        details: { field: "investmentFeeBps" },
      });

      await expect(
        feeScheduleService.updateFeeSchedule({ settlementFeeBps: -1 }, "GDADMINWALLET", "admin")
      ).rejects.toMatchObject({
        code: "INVALID_FEE_RATE",
        statusCode: 400,
        details: { field: "settlementFeeBps" },
      });
    });

    it("should reject non-numeric, fractional, and non-finite inputs across every fee field without opening a transaction or writing rows", async () => {
      await seedActiveSchedule();
      const txSpy = jest.spyOn(dataSource, "transaction");

      const invalidValues: Array<{ label: string; value: unknown }> = [
        { label: "null", value: null },
        { label: "true", value: true },
        { label: "false", value: false },
        { label: "numeric string", value: "100" },
        { label: "zero string", value: "0" },
        { label: "empty string", value: "" },
        { label: "empty array", value: [] },
        { label: "single-element array", value: [100] },
        { label: "object", value: { valueOf: () => 100 } },
        { label: "fraction", value: 12.5 },
        { label: "small fraction", value: 0.01 },
        { label: "negative fraction", value: -0.5 },
        { label: "NaN", value: Number.NaN },
        { label: "Infinity", value: Number.POSITIVE_INFINITY },
        { label: "-Infinity", value: Number.NEGATIVE_INFINITY },
      ];

      for (const field of FEE_RATE_FIELDS) {
        for (const { value } of invalidValues) {
          const companionField: FeeRateField =
            field === "investmentFeeBps" ? "settlementFeeBps" : "investmentFeeBps";

          await expect(
            feeScheduleService.updateFeeSchedule(
              {
                [companionField]: 250,
                [field]: value,
              } as unknown as UpdateFeeScheduleInput,
              "GDADMINWALLET",
              "admin"
            )
          ).rejects.toMatchObject({
            code: "INVALID_FEE_RATE",
            statusCode: 400,
            details: { field },
          });
        }
      }

      expect(txSpy).not.toHaveBeenCalled();
      expect(await dataSource.getRepository(FeeSchedule).count()).toBe(1);
      expect(await dataSource.getRepository(FeeScheduleHistory).count()).toBe(0);
    });

    it("should reject non-object service inputs before opening a transaction", async () => {
      await seedActiveSchedule();
      const txSpy = jest.spyOn(dataSource, "transaction");

      for (const badPayload of [null, undefined, "100", 100, [100], true]) {
        await expect(
          feeScheduleService.updateFeeSchedule(
            badPayload as unknown as UpdateFeeScheduleInput,
            "GDADMINWALLET",
            "admin"
          )
        ).rejects.toMatchObject({
          code: "INVALID_FEE_SCHEDULE_INPUT",
          statusCode: 400,
        });
      }

      expect(txSpy).not.toHaveBeenCalled();
    });

    it("should require at least one fee to update", async () => {
      await seedActiveSchedule();

      await expect(
        feeScheduleService.updateFeeSchedule({}, "GDADMINWALLET", "admin")
      ).rejects.toMatchObject({ code: "NO_CHANGES", statusCode: 400 });
    });
  });

  describe("PUT /fees HTTP controller & error middleware integration", () => {
    function buildApp() {
      const app = express();
      app.use(express.json());
      app.use((req, _res, next) => {
        const now = new Date();
        (req as AuthenticatedRequest).user = {
          id: "admin-1",
          stellarAddress: "GDHTTPADMINWALLET",
          email: null,
          userType: UserType.ADMIN,
          kycStatus: KYCStatus.APPROVED,
          createdAt: now,
          updatedAt: now,
          role: "admin",
        };
        next();
      });
      app.use("/api/v1/admin", createAdminFeesRouter(feeScheduleService));
      app.use(createErrorMiddleware(logger));
      return app;
    }

    it.each([
      { field: "investmentFeeBps", payload: { investmentFeeBps: "100" } },
      { field: "settlementFeeBps", payload: { settlementFeeBps: null } },
      { field: "platformFeeBps", payload: { platformFeeBps: 25.5 } },
      { field: "secondaryMarketFeeBps", payload: { secondaryMarketFeeBps: [150] } },
      { field: "investmentFeeBps", payload: { investmentFeeBps: true } },
      { field: "platformFeeBps", payload: { platformFeeBps: { bps: 100 } } },
    ])(
      "returns 400 with field-specific error and writes nothing for invalid $field JSON payload",
      async ({ field, payload }) => {
        await seedActiveSchedule();
        const app = buildApp();

        const res = await request(app).put("/api/v1/admin/fees").send(payload);

        expect(res.status).toBe(400);
        expect(res.body).toEqual({
          success: false,
          error: {
            code: "INVALID_FEE_RATE",
            message: expect.stringContaining(field),
            details: { field },
          },
        });

        const schedules = await dataSource.getRepository(FeeSchedule).find();
        const histories = await dataSource.getRepository(FeeScheduleHistory).find();
        expect(schedules).toHaveLength(1);
        expect(schedules[0]).toMatchObject({
          investmentFeeBps: 100,
          settlementFeeBps: 50,
          platformFeeBps: 100,
          secondaryMarketFeeBps: 150,
          isActive: true,
        });
        expect(histories).toHaveLength(0);
      }
    );

    it("accepts 0 and 1000 over HTTP PUT /api/v1/admin/fees and preserves omitted fields", async () => {
      await seedActiveSchedule();
      const app = buildApp();

      const res = await request(app)
        .put("/api/v1/admin/fees")
        .send({ investmentFeeBps: 0, secondaryMarketFeeBps: 1000, changeReason: "Boundary check" });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data).toMatchObject({
        investmentFeeBps: 0,
        settlementFeeBps: 50,
        platformFeeBps: 100,
        secondaryMarketFeeBps: 1000,
        isActive: true,
      });
    });
  });

  describe("getFeeScheduleHistory", () => {
    it("should return paginated history", async () => {
      await seedActiveSchedule();

      await feeScheduleService.updateFeeSchedule(
        { investmentFeeBps: 200 },
        "GDADMINWALLET1",
        "admin"
      );
      await feeScheduleService.updateFeeSchedule(
        { settlementFeeBps: 75 },
        "GDADMINWALLET2",
        "admin"
      );

      const result = await feeScheduleService.getFeeScheduleHistory({ limit: 10, offset: 0 });

      expect(result.history).toHaveLength(2);
      expect(result.total).toBe(2);
      expect(result.history[0].actorWallet).toBe("GDADMINWALLET2");
      expect(result.history[1].actorWallet).toBe("GDADMINWALLET1");
    });

    it("should respect pagination parameters", async () => {
      await seedActiveSchedule();

      for (let i = 0; i < 5; i++) {
        await feeScheduleService.updateFeeSchedule(
          { investmentFeeBps: 100 + i * 10 },
          `GDADMINWALLET${i}`,
          "admin"
        );
      }

      const result = await feeScheduleService.getFeeScheduleHistory({ limit: 2, offset: 0 });

      expect(result.history).toHaveLength(2);
      expect(result.total).toBe(5);
    });
  });
});
