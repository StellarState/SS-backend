import { DataSource } from "typeorm";
import express from "express";
import request from "supertest";
import { FeeScheduleService } from "../src/services/fee-schedule.service";
import { FeeSchedule, FeeScheduleHistory } from "../src/models/FeeSchedule.model";
import { FeeScheduleController } from "../src/controllers/fee-schedule.controller";
import { createErrorMiddleware } from "../src/middleware/error.middleware";
import { logger } from "../src/observability/logger";
import { PublicAppError } from "../src/utils/http-error";
import { createTestDataSource } from "./helpers/test-data-source";

describe("FeeScheduleService", () => {
  let dataSource: DataSource;
  let feeScheduleService: FeeScheduleService;

  beforeAll(async () => {
    dataSource = await createTestDataSource();
    await dataSource.synchronize(true);
    feeScheduleService = new FeeScheduleService(dataSource);
  });

  afterAll(async () => {
    await dataSource.destroy();
  });

  afterEach(async () => {
    await dataSource.query("DROP TRIGGER IF EXISTS reject_fee_schedule_history");
  });

  beforeEach(async () => {
    // FeeScheduleHistory.feeSchedule FKs back to FeeSchedule, so the child
    // table must be cleared first or sqlite rejects deleting a still-
    // referenced parent row left over from the previous test.
    await dataSource.getRepository(FeeScheduleHistory).clear();
    await dataSource.getRepository(FeeSchedule).clear();
  });

  describe("getCurrentFeeSchedule", () => {
    it("should return the current active fee schedule", async () => {
      const repository = dataSource.getRepository(FeeSchedule);
      const schedule = repository.create({
        investmentFeeBps: 100,
        settlementFeeBps: 50,
        platformFeeBps: 100,
        secondaryMarketFeeBps: 150,
        isActive: true,
        effectiveFrom: new Date(),
      });
      await repository.save(schedule);

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
      const repository = dataSource.getRepository(FeeSchedule);
      const schedule = repository.create({
        investmentFeeBps: 100,
        settlementFeeBps: 50,
        platformFeeBps: 100,
        secondaryMarketFeeBps: 150,
        isActive: true,
        effectiveFrom: new Date(),
      });
      await repository.save(schedule);

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

    it("should validate fee rate bounds", async () => {
      const repository = dataSource.getRepository(FeeSchedule);
      const schedule = repository.create({
        investmentFeeBps: 100,
        settlementFeeBps: 50,
        platformFeeBps: 100,
        secondaryMarketFeeBps: 150,
        isActive: true,
        effectiveFrom: new Date(),
      });
      await repository.save(schedule);

      await expect(
        feeScheduleService.updateFeeSchedule(
          { investmentFeeBps: 1500 },
          "GDADMINWALLET",
          "admin"
        )
      ).rejects.toMatchObject({ code: "INVALID_FEE_RATE", statusCode: 400 });
    });

    it("accepts inclusive integer basis-point boundaries for every fee field", async () => {
      const repository = dataSource.getRepository(FeeSchedule);
      await repository.save(repository.create({
        investmentFeeBps: 100,
        settlementFeeBps: 50,
        platformFeeBps: 100,
        secondaryMarketFeeBps: 150,
        isActive: true,
        effectiveFrom: new Date(),
      }));

      const zeroRates = await feeScheduleService.updateFeeSchedule({
        investmentFeeBps: 0,
        settlementFeeBps: 0,
        platformFeeBps: 0,
        secondaryMarketFeeBps: 0,
      }, "GDADMINWALLET");
      expect(zeroRates).toMatchObject({
        investmentFeeBps: 0,
        settlementFeeBps: 0,
        platformFeeBps: 0,
        secondaryMarketFeeBps: 0,
      });

      const maximumRates = await feeScheduleService.updateFeeSchedule({
        investmentFeeBps: 1000,
        settlementFeeBps: 1000,
        platformFeeBps: 1000,
        secondaryMarketFeeBps: 1000,
      }, "GDADMINWALLET");
      expect(maximumRates).toMatchObject({
        investmentFeeBps: 1000,
        settlementFeeBps: 1000,
        platformFeeBps: 1000,
        secondaryMarketFeeBps: 1000,
      });
    });

    it.each([
      "investmentFeeBps",
      "settlementFeeBps",
      "platformFeeBps",
      "secondaryMarketFeeBps",
    ] as const)("rejects invalid runtime values for %s before opening a transaction", async (field) => {
      const repository = dataSource.getRepository(FeeSchedule);
      const activeSchedule = await repository.save(repository.create({
        investmentFeeBps: 100,
        settlementFeeBps: 50,
        platformFeeBps: 100,
        secondaryMarketFeeBps: 150,
        isActive: true,
        effectiveFrom: new Date(),
      }));
      const invalidValues: unknown[] = [
        null,
        true,
        "100",
        [],
        {},
        1.5,
        NaN,
        Infinity,
        -Infinity,
        -1,
        1001,
      ];

      for (const invalidValue of invalidValues) {
        const transaction = jest.spyOn(dataSource, "transaction");

        const error = await feeScheduleService.updateFeeSchedule(
          { [field]: invalidValue },
          "GDADMINWALLET"
        ).catch((caught: unknown) => caught);

        expect(error).toBeInstanceOf(PublicAppError);
        expect(error).toMatchObject({
          code: "INVALID_FEE_RATE",
          statusCode: 400,
          details: { field },
        });
        expect(transaction).not.toHaveBeenCalled();
        transaction.mockRestore();
      }

      expect(await repository.count()).toBe(1);
      expect(await repository.findOneByOrFail({ id: activeSchedule.id }))
        .toMatchObject({ isActive: true, investmentFeeBps: 100 });
      expect(await dataSource.getRepository(FeeScheduleHistory).count()).toBe(0);
    });

    it("returns field-specific 400 validation errors through the controller and error middleware", async () => {
      await dataSource.getRepository(FeeSchedule).save({
        investmentFeeBps: 100,
        settlementFeeBps: 50,
        platformFeeBps: 100,
        secondaryMarketFeeBps: 150,
        isActive: true,
        effectiveFrom: new Date(),
      });
      const app = express();
      app.use(express.json());
      const controller = new FeeScheduleController(feeScheduleService);
      app.put("/fees", (req, res, next) => {
        void controller.updateFeeSchedule(req as never, res, next);
      });
      app.use(createErrorMiddleware(logger));

      const response = await request(app)
        .put("/fees")
        .send({ platformFeeBps: "75" })
        .expect(400);

      expect(response.body.error.code).toBe("INVALID_FEE_RATE");
      expect(response.body.error.details).toEqual({
        field: "platformFeeBps",
        minimum: 0,
        maximum: 1000,
      });
      expect(await dataSource.getRepository(FeeSchedule).count()).toBe(1);
      expect(await dataSource.getRepository(FeeScheduleHistory).count()).toBe(0);
    });

    it("preserves concurrent partial updates and records a sequential audit chain", async () => {
      const schedules = dataSource.getRepository(FeeSchedule);
      await schedules.save(schedules.create({
        investmentFeeBps: 100,
        settlementFeeBps: 50,
        platformFeeBps: 100,
        secondaryMarketFeeBps: 150,
        isActive: true,
        effectiveFrom: new Date(),
      }));

      await Promise.all([
        feeScheduleService.updateFeeSchedule(
          { investmentFeeBps: 210 },
          "GDADMINWALLET1"
        ),
        feeScheduleService.updateFeeSchedule(
          { settlementFeeBps: 85 },
          "GDADMINWALLET2"
        ),
      ]);

      const activeSchedules = await schedules.findBy({ isActive: true });
      expect(activeSchedules).toHaveLength(1);
      expect(activeSchedules[0]).toMatchObject({
        investmentFeeBps: 210,
        settlementFeeBps: 85,
        platformFeeBps: 100,
        secondaryMarketFeeBps: 150,
      });

      const history = await dataSource.getRepository(FeeScheduleHistory).find({
        order: { id: "ASC" },
      });
      expect(history).toHaveLength(2);
      expect(history[0]).toMatchObject({
        oldInvestmentFeeBps: 100,
        oldSettlementFeeBps: 50,
        oldPlatformFeeBps: 100,
        oldSecondaryMarketFeeBps: 150,
      });
      expect(history[1]).toMatchObject({
        oldInvestmentFeeBps: history[0].newInvestmentFeeBps,
        oldSettlementFeeBps: history[0].newSettlementFeeBps,
        oldPlatformFeeBps: history[0].newPlatformFeeBps,
        oldSecondaryMarketFeeBps: history[0].newSecondaryMarketFeeBps,
      });
      expect(history[1].newInvestmentFeeBps).toBe(210);
      expect(history[1].newSettlementFeeBps).toBe(85);
    });

    it("rolls back schedule deactivation and version history when history recording fails", async () => {
      const schedules = dataSource.getRepository(FeeSchedule);
      const initialSchedule = await schedules.save(schedules.create({
        investmentFeeBps: 100,
        settlementFeeBps: 50,
        platformFeeBps: 100,
        secondaryMarketFeeBps: 150,
        isActive: true,
        effectiveFrom: new Date(),
      }));
      await dataSource.query(`
        CREATE TRIGGER reject_fee_schedule_history
        BEFORE INSERT ON fee_schedule_history
        BEGIN
          SELECT RAISE(ABORT, 'fee schedule history rejected');
        END
      `);

      await expect(feeScheduleService.updateFeeSchedule(
        { investmentFeeBps: 210 },
        "GDADMINWALLET"
      )).rejects.toThrow("fee schedule history rejected");

      expect(await schedules.count()).toBe(1);
      expect(await schedules.findOneByOrFail({ id: initialSchedule.id }))
        .toMatchObject({ isActive: true, investmentFeeBps: 100 });
      expect(await dataSource.getRepository(FeeScheduleHistory).count()).toBe(0);
    });

    it("should require at least one fee to update", async () => {
      const repository = dataSource.getRepository(FeeSchedule);
      const schedule = repository.create({
        investmentFeeBps: 100,
        settlementFeeBps: 50,
        platformFeeBps: 100,
        secondaryMarketFeeBps: 150,
        isActive: true,
        effectiveFrom: new Date(),
      });
      await repository.save(schedule);

      await expect(
        feeScheduleService.updateFeeSchedule({}, "GDADMINWALLET", "admin")
      ).rejects.toMatchObject({ code: "NO_CHANGES", statusCode: 400 });
    });
  });

  describe("getFeeScheduleHistory", () => {
    it("should return paginated history", async () => {
      const scheduleRepository = dataSource.getRepository(FeeSchedule);
      const schedule = scheduleRepository.create({
        investmentFeeBps: 100,
        settlementFeeBps: 50,
        platformFeeBps: 100,
        secondaryMarketFeeBps: 150,
        isActive: true,
        effectiveFrom: new Date(),
      });
      await scheduleRepository.save(schedule);

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
      const scheduleRepository = dataSource.getRepository(FeeSchedule);
      const schedule = scheduleRepository.create({
        investmentFeeBps: 100,
        settlementFeeBps: 50,
        platformFeeBps: 100,
        secondaryMarketFeeBps: 150,
        isActive: true,
        effectiveFrom: new Date(),
      });
      await scheduleRepository.save(schedule);

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
