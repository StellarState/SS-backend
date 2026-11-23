/**
 * Template registry for investor alerts (issue #811).
 *
 * Every (event, channel) pair a wallet can opt into must be registered here.
 * The registry is the single source of truth for:
 *
 * - which combinations are supported (preference validation),
 * - which variables delivery must supply (the variable contract), and
 * - how a message is rendered, for both delivery and preview.
 *
 * This module is deliberately pure: it performs no I/O and imports nothing
 * that can. Preview is built on it, so preview has no path to an external
 * transport.
 */

export const NOTIFICATION_CHANNELS = ["in_app", "email"] as const;
export type NotificationChannel = (typeof NOTIFICATION_CHANNELS)[number];

export const ALERT_EVENTS = [
  "settlement",
  "kyc_expiry",
  "watchlist_change",
  "auto_invest",
  "maturity",
] as const;
export type AlertEvent = (typeof ALERT_EVENTS)[number];

/** Channels a wallet gets for an event until it chooses otherwise. */
export const DEFAULT_ALERT_CHANNELS: readonly NotificationChannel[] = ["in_app"];

export interface VariableSpec {
  description: string;
  /** Safe, obviously fake value used by preview. */
  sample: string;
  /**
   * Text used when delivery cannot extract the variable from the event.
   * Variables without a fallback are required: rendering fails without them.
   */
  fallback?: string;
}

/**
 * The delivery variable contract: for each event, the variables delivery
 * extracts from the source event and passes to the renderer.
 */
export const ALERT_VARIABLE_CONTRACT: Readonly<
  Record<AlertEvent, Readonly<Record<string, VariableSpec>>>
> = {
  settlement: {
    invoice_id: {
      description: "Settled invoice id",
      sample: "INV-PREVIEW-0001",
      fallback: "An invoice you hold",
    },
    amount: {
      description: "Amount distributed on settlement",
      sample: "1,000.00 USDC",
      fallback: "your share",
    },
  },
  kyc_expiry: {
    wallet: { description: "Wallet whose KYC is expiring", sample: "GPREVIEW…WALLET" },
    expires_at: {
      description: "KYC expiry date (YYYY-MM-DD)",
      sample: "2030-01-01",
      fallback: "soon",
    },
  },
  watchlist_change: {
    invoice_id: {
      description: "Watchlisted invoice id",
      sample: "INV-PREVIEW-0001",
      fallback: "an invoice on your watchlist",
    },
    change: {
      description: "What changed on the invoice",
      sample: "status changed to funded",
      fallback: "was updated",
    },
  },
  auto_invest: {
    invoice_id: {
      description: "Invoice the rule invested in",
      sample: "INV-PREVIEW-0001",
      fallback: "an invoice",
    },
    amount: {
      description: "Amount the rule invested",
      sample: "250.00 USDC",
      fallback: "funds",
    },
  },
  maturity: {
    invoice_id: {
      description: "Matured invoice id",
      sample: "INV-PREVIEW-0001",
      fallback: "An invoice you hold",
    },
  },
};

interface TemplateDefinition {
  /** In-app title, or email subject. */
  title: string;
  body: string;
}

/**
 * Registered (event, channel) pairs. A channel missing under an event is an
 * unsupported combination. watchlist_change is in-app only: it fires on every
 * update to a watched invoice, which is too noisy for email.
 */
const TEMPLATE_REGISTRY: Readonly<
  Record<AlertEvent, Partial<Record<NotificationChannel, TemplateDefinition>>>
> = {
  settlement: {
    in_app: {
      title: "Invoice settled",
      body: "{{invoice_id}} has settled and {{amount}} has been distributed.",
    },
    email: {
      title: "An invoice you hold has settled",
      body: "{{invoice_id}} has settled. {{amount}} has been distributed to your wallet.",
    },
  },
  kyc_expiry: {
    in_app: {
      title: "KYC expiring",
      body: "KYC verification for {{wallet}} expires {{expires_at}}. Renew it to keep investing.",
    },
    email: {
      title: "Your KYC verification expires {{expires_at}}",
      body:
        "KYC verification for wallet {{wallet}} expires {{expires_at}}. " +
        "Renew it to keep investing without interruption.",
    },
  },
  watchlist_change: {
    in_app: {
      title: "Watchlist update",
      body: "{{invoice_id}}: {{change}}.",
    },
  },
  auto_invest: {
    in_app: {
      title: "Auto invest executed",
      body: "Your auto invest rule invested {{amount}} in {{invoice_id}}.",
    },
    email: {
      title: "Auto invest executed",
      body: "Your auto invest rule invested {{amount}} in {{invoice_id}}.",
    },
  },
  maturity: {
    in_app: {
      title: "Invoice matured",
      body: "{{invoice_id}} has reached its maturity date.",
    },
    email: {
      title: "An invoice you hold has matured",
      body: "{{invoice_id}} has reached its maturity date. Settlement follows once payment is received.",
    },
  },
};

const PLACEHOLDER = /\{\{(\w+)\}\}/g;

export interface RenderedNotification {
  event: AlertEvent;
  channel: NotificationChannel;
  title: string;
  body: string;
}

export interface RegisteredPair {
  event: AlertEvent;
  channel: NotificationChannel;
}

export class UnsupportedNotificationPairError extends Error {
  constructor(
    readonly event: string,
    readonly channel: string
  ) {
    super(`No template is registered for event "${event}" on channel "${channel}".`);
    this.name = "UnsupportedNotificationPairError";
  }
}

export class MissingTemplateVariablesError extends Error {
  constructor(
    readonly event: AlertEvent,
    readonly channel: NotificationChannel,
    readonly missing: string[]
  ) {
    super(`Cannot render ${event}/${channel}: missing required variable(s) ${missing.join(", ")}.`);
    this.name = "MissingTemplateVariablesError";
  }
}

export function isAlertEvent(value: unknown): value is AlertEvent {
  return typeof value === "string" && (ALERT_EVENTS as readonly string[]).includes(value);
}

export function isNotificationChannel(value: unknown): value is NotificationChannel {
  return typeof value === "string" && (NOTIFICATION_CHANNELS as readonly string[]).includes(value);
}

export function isSupportedPair(event: AlertEvent, channel: NotificationChannel): boolean {
  return TEMPLATE_REGISTRY[event][channel] !== undefined;
}

export function supportedChannels(event: AlertEvent): NotificationChannel[] {
  return NOTIFICATION_CHANNELS.filter((channel) => isSupportedPair(event, channel));
}

export function registeredPairs(): RegisteredPair[] {
  return ALERT_EVENTS.flatMap((event) =>
    supportedChannels(event).map((channel) => ({ event, channel }))
  );
}

/** Placeholder names a registered template references, for contract checks. */
export function templatePlaceholders(event: AlertEvent, channel: NotificationChannel): string[] {
  const template = TEMPLATE_REGISTRY[event][channel];
  if (!template) throw new UnsupportedNotificationPairError(event, channel);
  const names = new Set<string>();
  for (const text of [template.title, template.body]) {
    for (const match of text.matchAll(PLACEHOLDER)) names.add(match[1]);
  }
  return [...names];
}

/** Preview values for every variable in an event's contract. */
export function sampleVariables(event: AlertEvent): Record<string, string> {
  return Object.fromEntries(
    Object.entries(ALERT_VARIABLE_CONTRACT[event]).map(([name, spec]) => [name, spec.sample])
  );
}

/**
 * Render a registered pair. This is the only renderer: delivery and preview
 * both call it, so a preview is exactly what delivery would send for the
 * same variables. Missing optional variables take their contract fallback;
 * missing required ones throw rather than leaking `{{placeholders}}`.
 */
export function renderNotification(
  event: AlertEvent,
  channel: NotificationChannel,
  variables: Readonly<Record<string, string | undefined | null>>
): RenderedNotification {
  const template = TEMPLATE_REGISTRY[event][channel];
  if (!template) throw new UnsupportedNotificationPairError(event, channel);

  const contract = ALERT_VARIABLE_CONTRACT[event];
  const resolved: Record<string, string> = {};
  const missing: string[] = [];
  for (const name of templatePlaceholders(event, channel)) {
    const supplied = variables[name];
    if (typeof supplied === "string" && supplied.trim() !== "") {
      resolved[name] = supplied;
    } else if (contract[name]?.fallback !== undefined) {
      resolved[name] = contract[name].fallback!;
    } else {
      missing.push(name);
    }
  }
  if (missing.length > 0) throw new MissingTemplateVariablesError(event, channel, missing);

  const fill = (text: string) =>
    text.replace(PLACEHOLDER, (_match, name: string) => resolved[name]);
  return { event, channel, title: fill(template.title), body: fill(template.body) };
}

// ---------------------------------------------------------------------------
// Request validation
// ---------------------------------------------------------------------------

export type FieldErrorCode =
  | "INVALID_TYPE"
  | "REQUIRED"
  | "UNKNOWN_EVENT"
  | "UNKNOWN_CHANNEL"
  | "UNKNOWN_FIELD"
  | "UNKNOWN_VARIABLE"
  | "DUPLICATE_CHANNEL"
  | "EMPTY_CHANNELS"
  | "UNSUPPORTED_COMBINATION";

export interface FieldError {
  field: string;
  code: FieldErrorCode;
  message: string;
}

export type ValidationResult<T> = { ok: true; value: T } | { ok: false; errors: FieldError[] };

export interface AlertEventPreferenceUpdate {
  enabled?: boolean;
  channels?: NotificationChannel[];
}

export type AlertPreferenceUpdate = Partial<Record<AlertEvent, AlertEventPreferenceUpdate>>;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function unsupportedMessage(event: AlertEvent, channel: string): string {
  return (
    `Channel "${channel}" is not supported for "${event}". ` +
    `Supported channels: ${supportedChannels(event).join(", ")}.`
  );
}

/**
 * Validate a channel list for one event, reporting each bad entry at its
 * own index so clients can highlight the exact selection.
 */
function validateChannels(
  event: AlertEvent,
  raw: unknown,
  field: string,
  errors: FieldError[]
): NotificationChannel[] | undefined {
  if (!Array.isArray(raw)) {
    errors.push({ field, code: "INVALID_TYPE", message: "channels must be an array of strings." });
    return undefined;
  }
  if (raw.length === 0) {
    errors.push({
      field,
      code: "EMPTY_CHANNELS",
      message: "channels must not be empty; set enabled to false to mute this event.",
    });
    return undefined;
  }
  const seen = new Set<string>();
  const channels: NotificationChannel[] = [];
  raw.forEach((channel, index) => {
    const at = `${field}[${index}]`;
    if (!isNotificationChannel(channel)) {
      errors.push({
        field: at,
        code: "UNKNOWN_CHANNEL",
        message: `Unknown channel ${JSON.stringify(channel)}. Known channels: ${NOTIFICATION_CHANNELS.join(", ")}.`,
      });
    } else if (seen.has(channel)) {
      errors.push({
        field: at,
        code: "DUPLICATE_CHANNEL",
        message: `Channel "${channel}" is listed twice.`,
      });
    } else if (!isSupportedPair(event, channel)) {
      errors.push({
        field: at,
        code: "UNSUPPORTED_COMBINATION",
        message: unsupportedMessage(event, channel),
      });
    } else {
      channels.push(channel);
    }
    if (typeof channel === "string") seen.add(channel);
  });
  return channels;
}

/**
 * Validate `PUT /investors/:wallet/alert-preferences`. Shape:
 * `{ preferences: { [event]: { enabled?: boolean, channels?: string[] } } }`.
 * Omitted events are left unchanged.
 */
export function validateAlertPreferenceUpdate(
  input: unknown
): ValidationResult<AlertPreferenceUpdate> {
  const errors: FieldError[] = [];
  const preferences = isPlainObject(input) ? input.preferences : undefined;

  if (!isPlainObject(preferences)) {
    return {
      ok: false,
      errors: [
        {
          field: "preferences",
          code: "REQUIRED",
          message: "preferences must be an object keyed by event.",
        },
      ],
    };
  }
  if (Object.keys(preferences).length === 0) {
    return {
      ok: false,
      errors: [
        {
          field: "preferences",
          code: "REQUIRED",
          message: "preferences must include at least one event.",
        },
      ],
    };
  }

  const update: AlertPreferenceUpdate = {};
  for (const [event, entry] of Object.entries(preferences)) {
    const field = `preferences.${event}`;
    if (!isAlertEvent(event)) {
      errors.push({
        field,
        code: "UNKNOWN_EVENT",
        message: `Unknown event "${event}". Known events: ${ALERT_EVENTS.join(", ")}.`,
      });
      continue;
    }
    if (!isPlainObject(entry)) {
      errors.push({
        field,
        code: "INVALID_TYPE",
        message: "Each event preference must be an object.",
      });
      continue;
    }

    const value: AlertEventPreferenceUpdate = {};
    for (const key of Object.keys(entry)) {
      if (key !== "enabled" && key !== "channels") {
        errors.push({
          field: `${field}.${key}`,
          code: "UNKNOWN_FIELD",
          message: `Unknown field "${key}". Allowed fields: enabled, channels.`,
        });
      }
    }
    if (entry.enabled !== undefined) {
      if (typeof entry.enabled === "boolean") value.enabled = entry.enabled;
      else
        errors.push({
          field: `${field}.enabled`,
          code: "INVALID_TYPE",
          message: "enabled must be a boolean.",
        });
    }
    if (entry.channels !== undefined) {
      const channels = validateChannels(event, entry.channels, `${field}.channels`, errors);
      if (channels) value.channels = channels;
    }
    update[event] = value;
  }

  return errors.length > 0 ? { ok: false, errors } : { ok: true, value: update };
}

export interface NotificationPreviewRequest {
  event: AlertEvent;
  channel: NotificationChannel;
  variables: Record<string, string>;
}

/** Validate `POST /investors/:wallet/alert-preferences/preview`. */
export function validatePreviewRequest(
  input: unknown
): ValidationResult<NotificationPreviewRequest> {
  const errors: FieldError[] = [];
  const body = isPlainObject(input) ? input : {};

  const event = body.event;
  const channel = body.channel;
  if (event === undefined) {
    errors.push({ field: "event", code: "REQUIRED", message: "event is required." });
  } else if (!isAlertEvent(event)) {
    errors.push({
      field: "event",
      code: "UNKNOWN_EVENT",
      message: `Unknown event ${JSON.stringify(event)}. Known events: ${ALERT_EVENTS.join(", ")}.`,
    });
  }
  if (channel === undefined) {
    errors.push({ field: "channel", code: "REQUIRED", message: "channel is required." });
  } else if (!isNotificationChannel(channel)) {
    errors.push({
      field: "channel",
      code: "UNKNOWN_CHANNEL",
      message: `Unknown channel ${JSON.stringify(channel)}. Known channels: ${NOTIFICATION_CHANNELS.join(", ")}.`,
    });
  } else if (isAlertEvent(event) && !isSupportedPair(event, channel)) {
    errors.push({
      field: "channel",
      code: "UNSUPPORTED_COMBINATION",
      message: unsupportedMessage(event, channel),
    });
  }

  const variables: Record<string, string> = {};
  if (body.variables !== undefined) {
    if (!isPlainObject(body.variables)) {
      errors.push({
        field: "variables",
        code: "INVALID_TYPE",
        message: "variables must be an object of strings.",
      });
    } else {
      const contract = isAlertEvent(event) ? ALERT_VARIABLE_CONTRACT[event] : undefined;
      for (const [name, value] of Object.entries(body.variables)) {
        if (contract && !(name in contract)) {
          errors.push({
            field: `variables.${name}`,
            code: "UNKNOWN_VARIABLE",
            message: `"${name}" is not in the ${String(event)} variable contract. Known: ${Object.keys(contract).join(", ")}.`,
          });
        } else if (typeof value !== "string") {
          errors.push({
            field: `variables.${name}`,
            code: "INVALID_TYPE",
            message: "Variable values must be strings.",
          });
        } else {
          variables[name] = value;
        }
      }
    }
  }

  return errors.length > 0
    ? { ok: false, errors }
    : {
        ok: true,
        value: { event: event as AlertEvent, channel: channel as NotificationChannel, variables },
      };
}

export interface NotificationPreview extends RenderedNotification {
  /** The exact variables passed to the renderer. */
  variables: Record<string, string>;
  /** Always true: previews are rendered locally and never delivered. */
  preview: true;
}

/**
 * Render a preview using contract sample values, overridden by any caller-
 * supplied variables. Goes through {@link renderNotification}, so the result
 * matches what delivery would send for the same variables.
 */
export function previewNotification(request: NotificationPreviewRequest): NotificationPreview {
  const variables = { ...sampleVariables(request.event), ...request.variables };
  return {
    ...renderNotification(request.event, request.channel, variables),
    variables,
    preview: true,
  };
}
