import request from "supertest";
import type { DataSource } from "typeorm";
import { createApp } from "../src/app";
import type { AuthService } from "../src/services/auth.service";
import { AlertPreference } from "../src/models/AlertPreference.model";
import { Investment } from "../src/models/Investment.model";
import { YieldAdjustment } from "../src/models/YieldAdjustment.model";
import { InvestorInsightsService } from "../src/services/investor-insights.service";
import { previewNotification } from "../src/lib/notification-templates";
import type { DecodedSorobanEvent } from "../src/types/soroban.types";

/**
 * Issue #811: alert preference validation, preview, and delivery rendering
 * through the mounted /api/v1/investors routes.
 */
const WALLET = "GALERTWALLETAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const OTHER_WALLET = "GOTHERWALLETBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";

function createAuthServiceStub(): AuthService {
  return {
    getCurrentUser: jest.fn(async (token: string) => ({
      id: `user-${token}`,
      stellarAddress: token === "own" ? WALLET : OTHER_WALLET,
      isSuspended: false,
    })),
  } as unknown as AuthService;
}

function createFakeDataSource() {
  const rows: AlertPreference[] = [];
  const save = jest.fn(async (input: AlertPreference) => {
    const index = rows.findIndex((row) => row.wallet === input.wallet);
    if (index >= 0) rows[index] = input;
    else rows.push(input);
    return input;
  });
  const preferenceRepository = {
    create: (input: object) => ({ ...input }),
    save,
    findOne: jest.fn(
      async ({ where }: { where: { wallet: string } }) =>
        rows.find((row) => row.wallet === where.wallet) ?? null
    ),
  };
  const empty = {
    create: (input: object) => ({ ...input }),
    save: jest.fn(async (input: object) => input),
    findOne: jest.fn(async () => null),
    find: jest.fn(async () => []),
  };
  const dataSource = {
    getRepository: (model: unknown) =>
      model === AlertPreference
        ? preferenceRepository
        : model === Investment || model === YieldAdjustment
          ? empty
          : empty,
  } as unknown as DataSource;
  return { dataSource, rows, save };
}

function sorobanEvent(
  topic: string,
  data: Record<string, unknown>,
  id = "evt-1"
): DecodedSorobanEvent {
  return {
    id,
    contractId: "contract",
    ledger: 1,
    ledgerClosedAt: "2026-11-01T00:00:00.000Z",
    txHash: "tx-1",
    topic,
    topics: [topic],
    data,
    inSuccessfulContractCall: true,
  };
}

describe("alert preferences API (#811)", () => {
  let fake: ReturnType<typeof createFakeDataSource>;
  let transport: jest.Mock;
  let service: InvestorInsightsService;
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    fake = createFakeDataSource();
    transport = jest.fn().mockResolvedValue({ ok: true, status: 200 });
    service = new InvestorInsightsService(
      fake.dataSource,
      { notificationServiceUrl: "https://notify.example.test" },
      undefined,
      transport as unknown as typeof fetch
    );
    app = createApp({ authService: createAuthServiceStub(), investorInsightsService: service });
  });

  const put = (body: unknown, token = "own") =>
    request(app)
      .put(`/api/v1/investors/${WALLET}/alert-preferences`)
      .set("Authorization", `Bearer ${token}`)
      .send(body as object);

  const preview = (body: unknown) =>
    request(app)
      .post(`/api/v1/investors/${WALLET}/alert-preferences/preview`)
      .set("Authorization", "Bearer own")
      .send(body as object);

  describe("GET", () => {
    it("returns default channels for a wallet with no stored preferences", async () => {
      const res = await request(app)
        .get(`/api/v1/investors/${WALLET}/alert-preferences`)
        .set("Authorization", "Bearer own")
        .expect(200);

      expect(res.body.data.settlement).toBe(true);
      expect(res.body.data.channels).toEqual({
        settlement: ["in_app"],
        kyc_expiry: ["in_app"],
        watchlist_change: ["in_app"],
        auto_invest: ["in_app"],
        maturity: ["in_app"],
      });
    });
  });

  describe("PUT", () => {
    it("stores supported channel choices and returns the resulting preferences", async () => {
      const res = await put({
        preferences: {
          settlement: { channels: ["in_app", "email"] },
          maturity: { enabled: false },
        },
      }).expect(200);

      expect(res.body.data.channels.settlement).toEqual(["in_app", "email"]);
      expect(res.body.data.maturity).toBe(false);
      expect(fake.rows[0]).toMatchObject({
        wallet: WALLET,
        maturityEnabled: false,
        channels: { settlement: ["in_app", "email"] },
      });
    });

    it("leaves events omitted from the update unchanged", async () => {
      await put({ preferences: { settlement: { channels: ["email"] } } }).expect(200);
      const res = await put({ preferences: { auto_invest: { channels: ["email"] } } }).expect(200);

      expect(res.body.data.channels.settlement).toEqual(["email"]);
      expect(res.body.data.channels.auto_invest).toEqual(["email"]);
      expect(res.body.data.settlement).toBe(true);
    });

    it("returns 422 field errors for an unsupported combination and writes nothing", async () => {
      const res = await put({
        preferences: { watchlist_change: { channels: ["in_app", "email"] } },
      }).expect(422);

      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe("VALIDATION_ERROR");
      expect(res.body.error.details).toEqual([
        {
          field: "preferences.watchlist_change.channels[1]",
          code: "UNSUPPORTED_COMBINATION",
          message: expect.stringContaining("Supported channels: in_app"),
        },
      ]);
      expect(fake.save).not.toHaveBeenCalled();
    });

    it("rejects the whole update when any event is invalid", async () => {
      await put({
        preferences: { settlement: { channels: ["email"] }, maturity: { channels: ["sms"] } },
      }).expect(422);
      expect(fake.save).not.toHaveBeenCalled();
    });

    it("forbids updating another wallet's preferences", async () => {
      await put({ preferences: { settlement: { enabled: false } } }, "other").expect(403);
      expect(fake.save).not.toHaveBeenCalled();
    });

    it("requires authentication", async () => {
      await request(app)
        .put(`/api/v1/investors/${WALLET}/alert-preferences`)
        .send({ preferences: { settlement: { enabled: false } } })
        .expect(401);
    });
  });

  describe("preview", () => {
    it("renders through the delivery renderer and never calls the transport", async () => {
      const fetchSpy = jest.spyOn(globalThis, "fetch");
      try {
        const res = await preview({
          event: "settlement",
          channel: "email",
          variables: { invoice_id: "INV-77", amount: "12.50 USDC" },
        }).expect(200);

        expect(res.body.data).toEqual({
          event: "settlement",
          channel: "email",
          title: "An invoice you hold has settled",
          body: "INV-77 has settled. 12.50 USDC has been distributed to your wallet.",
          variables: { invoice_id: "INV-77", amount: "12.50 USDC" },
          preview: true,
        });
        expect(transport).not.toHaveBeenCalled();
        expect(fetchSpy).not.toHaveBeenCalled();
        expect(fake.save).not.toHaveBeenCalled();
      } finally {
        fetchSpy.mockRestore();
      }
    });

    it("returns 422 for an unsupported combination", async () => {
      const res = await preview({ event: "watchlist_change", channel: "email" }).expect(422);
      expect(res.body.error.details).toEqual([
        expect.objectContaining({ field: "channel", code: "UNSUPPORTED_COMBINATION" }),
      ]);
      expect(transport).not.toHaveBeenCalled();
    });
  });

  describe("delivery", () => {
    it("sends exactly what preview renders for the same event data", async () => {
      await put({ preferences: { settlement: { channels: ["in_app", "email"] } } }).expect(200);

      await service.processEvent(
        sorobanEvent("InvoiceSettled", { wallet: WALLET, invoice_id: "INV-9", amount: "900 USDC" })
      );

      expect(transport).toHaveBeenCalledTimes(1);
      const body = JSON.parse(transport.mock.calls[0][1].body);
      expect(body.channels).toEqual(["in_app", "email"]);
      for (const channel of ["in_app", "email"] as const) {
        const expected = previewNotification({
          event: "settlement",
          channel,
          variables: { invoice_id: "INV-9", amount: "900 USDC" },
        });
        expect(body.rendered).toContainEqual({
          event: "settlement",
          channel,
          title: expected.title,
          body: expected.body,
        });
      }
    });

    it("never delivers a stored pair that is not registered, falling back to defaults", async () => {
      fake.rows.push({
        wallet: WALLET,
        settlementEnabled: true,
        kycExpiryEnabled: true,
        watchlistChangeEnabled: true,
        autoInvestEnabled: true,
        maturityEnabled: true,
        channels: { watchlist_change: ["email"] },
      } as unknown as AlertPreference);

      await service.processEvent(
        sorobanEvent("WatchlistUpdated", { wallet: WALLET, invoice_id: "INV-3", change: "funded" })
      );

      const body = JSON.parse(transport.mock.calls[0][1].body);
      expect(body.channels).toEqual(["in_app"]);
      expect(body.rendered).toEqual([
        expect.objectContaining({ channel: "in_app", body: "INV-3: funded." }),
      ]);
    });

    it("keeps stored channels when an on-chain preference update arrives", async () => {
      await put({ preferences: { maturity: { channels: ["email"] } } }).expect(200);

      await service.processEvent(
        sorobanEvent("AlertPreferenceUpdated", { wallet: WALLET, settlement: false }, "evt-pref")
      );

      const view = await service.getAlertPreferences(WALLET);
      expect(view.settlement).toBe(false);
      expect(view.channels.maturity).toEqual(["email"]);
    });
  });

  it("does not intercept other /api/v1/investors routes with its auth middleware", async () => {
    await request(app).get("/api/v1/investors/not-a-real-route").expect(404);
  });
});
