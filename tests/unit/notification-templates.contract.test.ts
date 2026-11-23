import {
  ALERT_EVENTS,
  ALERT_VARIABLE_CONTRACT,
  DEFAULT_ALERT_CHANNELS,
  MissingTemplateVariablesError,
  NOTIFICATION_CHANNELS,
  UnsupportedNotificationPairError,
  isSupportedPair,
  previewNotification,
  registeredPairs,
  renderNotification,
  sampleVariables,
  supportedChannels,
  templatePlaceholders,
  validateAlertPreferenceUpdate,
  validatePreviewRequest,
} from "@/lib/notification-templates";
import {
  ALERT_VARIABLE_ALIASES,
  alertVariablesFromEvent,
} from "@/services/investor-insights.service";

/**
 * Issue #811 contract tests. Every registered (event, channel) pair is
 * exercised individually, so registering a new template without honouring
 * the variable contract fails here rather than at delivery time.
 */
const pairs = registeredPairs();
const unsupported = ALERT_EVENTS.flatMap((event) =>
  NOTIFICATION_CHANNELS.filter((channel) => !isSupportedPair(event, channel)).map((channel) => ({
    event,
    channel,
  }))
);

describe("notification template registry", () => {
  it("registers at least one pair and covers every event", () => {
    expect(pairs.length).toBeGreaterThan(0);
    for (const event of ALERT_EVENTS) {
      expect(supportedChannels(event).length).toBeGreaterThan(0);
    }
  });

  it("supports the default channels for every event, so defaults always deliver", () => {
    for (const event of ALERT_EVENTS) {
      for (const channel of DEFAULT_ALERT_CHANNELS) {
        expect(isSupportedPair(event, channel)).toBe(true);
      }
    }
  });

  it("has delivery extraction rules for exactly the contract variables", () => {
    for (const event of ALERT_EVENTS) {
      expect(Object.keys(ALERT_VARIABLE_ALIASES[event]).sort()).toEqual(
        Object.keys(ALERT_VARIABLE_CONTRACT[event]).sort()
      );
    }
  });
});

describe.each(pairs)("registered pair $event/$channel", ({ event, channel }) => {
  const contract = ALERT_VARIABLE_CONTRACT[event];

  it("only references variables declared in the delivery contract", () => {
    for (const name of templatePlaceholders(event, channel)) {
      expect(Object.keys(contract)).toContain(name);
    }
  });

  it("renders sample variables with no unresolved placeholders", () => {
    const rendered = renderNotification(event, channel, sampleVariables(event));
    expect(rendered.title).not.toMatch(/\{\{|\}\}/);
    expect(rendered.body).not.toMatch(/\{\{|\}\}/);
    expect(rendered.title.trim()).not.toBe("");
    expect(rendered.body.trim()).not.toBe("");
  });

  it("substitutes every supplied variable into the output", () => {
    const variables = Object.fromEntries(
      Object.keys(contract).map((name) => [name, `<<${name}-value>>`])
    );
    const rendered = renderNotification(event, channel, variables);
    for (const name of templatePlaceholders(event, channel)) {
      expect(`${rendered.title} ${rendered.body}`).toContain(`<<${name}-value>>`);
    }
  });

  it("uses fallbacks for absent optional variables and fails on absent required ones", () => {
    const required = templatePlaceholders(event, channel).filter(
      (name) => contract[name].fallback === undefined
    );
    if (required.length === 0) {
      const rendered = renderNotification(event, channel, {});
      expect(`${rendered.title} ${rendered.body}`).not.toMatch(/\{\{|\}\}/);
      return;
    }
    expect(() => renderNotification(event, channel, {})).toThrow(MissingTemplateVariablesError);
    try {
      renderNotification(event, channel, {});
    } catch (error) {
      expect((error as MissingTemplateVariablesError).missing.sort()).toEqual(required.sort());
    }
  });

  it("previews identically to a delivery render with the same variables", () => {
    const preview = previewNotification({ event, channel, variables: {} });
    const delivered = renderNotification(event, channel, preview.variables);
    expect({ title: preview.title, body: preview.body }).toEqual({
      title: delivered.title,
      body: delivered.body,
    });
    expect(preview.preview).toBe(true);
  });

  it("previews identically to what delivery renders from a real event payload", () => {
    const data: Record<string, unknown> = {};
    for (const [name, aliases] of Object.entries(ALERT_VARIABLE_ALIASES[event])) {
      if (aliases.length > 0) data[aliases[0]] = `event-${name}`;
    }
    const wallet = "GCONTRACTWALLET";
    const deliveryVariables = alertVariablesFromEvent(event, data, wallet);

    const delivered = renderNotification(event, channel, deliveryVariables);
    const preview = previewNotification({ event, channel, variables: deliveryVariables });
    expect(preview.title).toBe(delivered.title);
    expect(preview.body).toBe(delivered.body);
  });

  it("is accepted by preference validation", () => {
    const result = validateAlertPreferenceUpdate({
      preferences: { [event]: { enabled: true, channels: [channel] } },
    });
    expect(result).toEqual({
      ok: true,
      value: { [event]: { enabled: true, channels: [channel] } },
    });
  });

  it("is accepted by preview validation", () => {
    expect(validatePreviewRequest({ event, channel }).ok).toBe(true);
  });
});

describe("unsupported pairs", () => {
  it("includes at least one combination, so validation has something to reject", () => {
    expect(unsupported.length).toBeGreaterThan(0);
  });

  it.each(unsupported)("$event/$channel is rejected everywhere", ({ event, channel }) => {
    expect(() => renderNotification(event, channel, sampleVariables(event))).toThrow(
      UnsupportedNotificationPairError
    );

    const update = validateAlertPreferenceUpdate({
      preferences: { [event]: { channels: ["in_app", channel] } },
    });
    expect(update.ok).toBe(false);
    if (!update.ok) {
      expect(update.errors).toEqual([
        expect.objectContaining({
          field: `preferences.${event}.channels[1]`,
          code: "UNSUPPORTED_COMBINATION",
        }),
      ]);
    }

    const preview = validatePreviewRequest({ event, channel });
    expect(preview.ok).toBe(false);
    if (!preview.ok) {
      expect(preview.errors).toEqual([
        expect.objectContaining({ field: "channel", code: "UNSUPPORTED_COMBINATION" }),
      ]);
    }
  });
});

describe("preference update validation", () => {
  it.each([
    [undefined, "preferences", "REQUIRED"],
    [{ preferences: [] }, "preferences", "REQUIRED"],
    [{ preferences: {} }, "preferences", "REQUIRED"],
    [{ preferences: { bogus: {} } }, "preferences.bogus", "UNKNOWN_EVENT"],
    [{ preferences: { maturity: true } }, "preferences.maturity", "INVALID_TYPE"],
    [
      { preferences: { maturity: { enabled: "yes" } } },
      "preferences.maturity.enabled",
      "INVALID_TYPE",
    ],
    [
      { preferences: { maturity: { channels: "email" } } },
      "preferences.maturity.channels",
      "INVALID_TYPE",
    ],
    [
      { preferences: { maturity: { channels: [] } } },
      "preferences.maturity.channels",
      "EMPTY_CHANNELS",
    ],
    [
      { preferences: { maturity: { channels: ["sms"] } } },
      "preferences.maturity.channels[0]",
      "UNKNOWN_CHANNEL",
    ],
    [
      { preferences: { maturity: { channels: [7] } } },
      "preferences.maturity.channels[0]",
      "UNKNOWN_CHANNEL",
    ],
    [
      { preferences: { maturity: { channels: ["in_app", "in_app"] } } },
      "preferences.maturity.channels[1]",
      "DUPLICATE_CHANNEL",
    ],
    [{ preferences: { maturity: { mute: true } } }, "preferences.maturity.mute", "UNKNOWN_FIELD"],
  ])("rejects %j at %s with %s", (input, field, code) => {
    const result = validateAlertPreferenceUpdate(input);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toContainEqual(expect.objectContaining({ field, code }));
    }
  });

  it("reports every bad field at once rather than stopping at the first", () => {
    const result = validateAlertPreferenceUpdate({
      preferences: {
        watchlist_change: { channels: ["email"] },
        maturity: { enabled: "no", channels: ["sms"] },
        bogus: {},
      },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.map((error) => error.field).sort()).toEqual([
        "preferences.bogus",
        "preferences.maturity.channels[0]",
        "preferences.maturity.enabled",
        "preferences.watchlist_change.channels[0]",
      ]);
    }
  });
});

describe("preview validation", () => {
  it("requires event and channel", () => {
    const result = validatePreviewRequest({});
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.map((error) => [error.field, error.code])).toEqual([
        ["event", "REQUIRED"],
        ["channel", "REQUIRED"],
      ]);
    }
  });

  it("rejects variables outside the event's contract and non-string values", () => {
    const result = validatePreviewRequest({
      event: "maturity",
      channel: "in_app",
      variables: { invoice_id: 42, amount: "1" },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toEqual([
        expect.objectContaining({ field: "variables.invoice_id", code: "INVALID_TYPE" }),
        expect.objectContaining({ field: "variables.amount", code: "UNKNOWN_VARIABLE" }),
      ]);
    }
  });

  it("overrides sample values with supplied variables", () => {
    const preview = previewNotification({
      event: "maturity",
      channel: "in_app",
      variables: { invoice_id: "INV-42" },
    });
    expect(preview.body).toBe("INV-42 has reached its maturity date.");
    expect(preview.variables).toEqual({ invoice_id: "INV-42" });
  });
});
