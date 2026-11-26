# Notification preferences and preview

Investors choose which alerts they receive and on which channels. Every
`(event, channel)` pair must be registered in the template registry,
`src/lib/notification-templates.ts`. The registry is the single source for:

- which combinations are valid,
- which variables delivery must supply (the *variable contract*), and
- how a message is rendered. Delivery and preview share one renderer.

## Supported pairs

| Event              | `in_app` | `email` |
| ------------------ | :------: | :-----: |
| `settlement`       |    ✓     |    ✓    |
| `kyc_expiry`       |    ✓     |    ✓    |
| `watchlist_change` |    ✓     |    —    |
| `auto_invest`      |    ✓     |    ✓    |
| `maturity`         |    ✓     |    ✓    |

`watchlist_change` is in-app only. It fires on every update to a watched
invoice, which is too noisy for email.

A wallet that hasn't chosen channels for an event gets `in_app` only, so
email is opt-in.

## Endpoints

All three endpoints require a bearer token. A wallet can only read or change
its own preferences; any other wallet gets `403`.

### `GET /api/v1/investors/:wallet/alert-preferences`

Returns the on/off switch for each event plus `channels`, the resolved
channel list for each event. Stored pairs that are no longer registered are
dropped from the response, and an event left with nothing falls back to the
default.

### `PUT /api/v1/investors/:wallet/alert-preferences`

```json
{
  "preferences": {
    "settlement": { "enabled": true, "channels": ["in_app", "email"] },
    "maturity": { "enabled": false }
  }
}
```

This is a partial update: events you leave out stay as they are. The request
is validated as a whole. If any field is invalid, nothing is written and the
response is `422`:

```json
{
  "success": false,
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Invalid alert preferences.",
    "details": [
      {
        "field": "preferences.watchlist_change.channels[1]",
        "code": "UNSUPPORTED_COMBINATION",
        "message": "Channel \"email\" is not supported for \"watchlist_change\". Supported channels: in_app."
      }
    ]
  }
}
```

Every invalid field is reported, not only the first one.

| Code                      | Meaning                                                  |
| ------------------------- | -------------------------------------------------------- |
| `REQUIRED`                | `preferences` is missing or empty                        |
| `UNKNOWN_EVENT`           | Key is not one of the five events                        |
| `UNKNOWN_FIELD`           | Event entry has a key other than `enabled` / `channels`  |
| `INVALID_TYPE`            | Wrong JSON type                                          |
| `UNKNOWN_CHANNEL`         | Not `in_app` or `email`                                  |
| `DUPLICATE_CHANNEL`       | Same channel listed twice                                |
| `EMPTY_CHANNELS`          | `channels: []`. Use `enabled: false` to mute an event    |
| `UNSUPPORTED_COMBINATION` | Known event and channel, but the pair isn't registered   |

### `POST /api/v1/investors/:wallet/alert-preferences/preview`

```json
{ "event": "settlement", "channel": "email", "variables": { "invoice_id": "INV-77" } }
```

Returns `{ event, channel, title, body, variables, preview: true }`. Any
variable you don't supply takes its contract sample value. A variable that
isn't in the event's contract is rejected with `UNKNOWN_VARIABLE`.

**Preview cannot send.** It calls only the pure registry functions, which do
no I/O. It never reaches the notification transport and never writes to the
database. The route tests assert both.

**Preview matches delivery.** Delivery extracts the contract variables from
the on-chain event (`alertVariablesFromEvent`) and calls the same
`renderNotification` that preview uses. Given the same variables, the output
is byte-for-byte identical.

## Variable contract

Each event declares its variables in `ALERT_VARIABLE_CONTRACT`. A variable
can have a `fallback`, used when the event data doesn't include it, so an
alert never fails over a missing optional field. A variable without a
fallback is required. If a required variable is missing at delivery time,
that channel is logged (`Investor alert render failed`) and skipped, and the
other channels still deliver. Delivery reads each variable only from the
named fields listed in `ALERT_VARIABLE_ALIASES`.

## Delivery payload

Requests to the notification service keep their existing fields and add two
more:

- `channels`: the channels that rendered successfully.
- `rendered`: one `{ event, channel, title, body }` per channel.

## Adding a template

1. Add the template under its event in `TEMPLATE_REGISTRY`.
2. If it needs a new variable, add it to `ALERT_VARIABLE_CONTRACT`, with a
   sample and preferably a fallback. Also add it to `ALERT_VARIABLE_ALIASES`.
3. Run `tests/unit/notification-templates.contract.test.ts`. The contract
   tests run against every registered pair automatically, so a new pair is
   covered as soon as it's registered.
