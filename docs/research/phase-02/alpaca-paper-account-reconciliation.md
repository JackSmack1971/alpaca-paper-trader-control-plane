# External contract research: Alpaca PAPER account reconciliation

- Date retrieved: 2026-10-04
- Active phase: 2
- Contract question: Which read-only Trading API endpoints and authentication contract provide an authoritative PAPER account, open positions, open orders, and market clock snapshot?

## Sources

| Source | Authority | Retrieved | Notes |
|---|---|---|---|
| https://docs.alpaca.markets/us/reference/getaccount-1 | official API reference | 2026-10-04 | PAPER account endpoint and credential headers. |
| https://docs.alpaca.markets/us/reference/getallopenpositions | official API reference | 2026-10-04 | Open positions endpoint and live-valued position data. |
| https://docs.alpaca.markets/us/reference/getallorders-1 | official API reference | 2026-10-04 | Orders endpoint defaults to open; supports `status=open`, maximum limit 500. |
| https://docs.alpaca.markets/us/docs/orders-at-alpaca | official documentation | 2026-10-04 | Provider order object can carry notional and omit quantity for notional orders. |
| https://docs.alpaca.markets/us/reference/legacyclock | official API reference | 2026-10-04 | PAPER v2 market clock endpoint and response purpose. |
| https://docs.alpaca.markets/us/docs/authentication-1 | official documentation | 2026-10-04 | Trading API key and secret headers; PAPER host is separate from live host. |
| https://docs.alpaca.markets/us/docs/broker-api-rate-limits | official documentation | 2026-10-04 | Applies to Broker API; documents its 429 response and rate headers, not asserted as the Trading API contract. |

## Findings

### CURRENT

- The Trading API account endpoint is `GET https://paper-api.alpaca.markets/v2/account`.
- The open-position endpoint is `GET https://paper-api.alpaca.markets/v2/positions`; returned position market values update with price information.
- The orders endpoint is `GET https://paper-api.alpaca.markets/v2/orders`; status defaults to open, accepts `status=open`, and its documented maximum page size is 500.
- Alpaca order objects support notional orders; for these, `qty` may be null/omitted while `notional` carries the requested dollar amount.
- The market clock endpoint is `GET https://paper-api.alpaca.markets/v2/clock`; it returns timestamp, open state, and next open/close.
- Trading API credentials are the `APCA-API-KEY-ID` and `APCA-API-SECRET-KEY` headers, and the documented PAPER host is distinct from the live host.
- Alpaca documents HTTP 429 for rate-limited API requests. The cited Broker API rate-limit page describes Broker API-specific policy; its fixed numbers and header guarantees are not transferred to the Trading API here.

### DERIVED

- A full normalized account snapshot requires all four resource groups to succeed. A partial fetch must not replace the previously observed account state.
- An open-order response at the 500 item cap may be truncated; the adapter must fail closed or mark completeness unknown instead of treating a capped list as complete.
- Application-owned order state must preserve whether the order was specified by share quantity or notional value; it must not invent a share quantity for notional orders.
- Credential-free verification can exercise URL selection, headers, schema validation, response atomicity, redaction, and failure classification through an injected fetch implementation without contacting Alpaca.

### RECOMMENDED

- Implement a read-only adapter with the fixed `ALPACA_PAPER_BASE_URL`, no configurable host, and no order-writing methods.
- Normalize the joined payload through the existing application-owned `normalizeAccountState` boundary and publish only the complete normalized snapshot.
- Poll at a configurable conservative cadence, retain the last good snapshot on failure, expose sanitized status and optional rate-limit observations, and never log provider bodies or credentials.
- Keep local test mode on fixture/simulator adapters; it must not construct this client even if future configuration changes.

### SPECULATIVE

- No credentialed API request or account-plan-specific rate limit has been observed in this environment.
- The API reference pages do not expose a complete, machine-readable account response schema in the retrieved text; runtime Zod validation and sanitized qualification evidence remain necessary.

## Conflicts / unknowns

- The Broker API rate-limit page is not the Trading API contract. Exact Trading API rate limits and whether all three Broker API rate headers apply are unresolved; do not claim either from that page.
- The v2 clock response does not identify asset-specific calendars. Its session state is a US market clock input and must not be represented as a per-asset session guarantee.

## Implementation consequences

- Use only the four documented GET endpoints and the fixed PAPER host.
- Authenticate only with server-side headers, validate every external resource before normalization, bound response sizes and order counts, preserve nullable quantity/notional semantics, and suppress raw error bodies.
- Treat HTTP 429 and transport failures as typed unavailable reconciliation outcomes; do not replace last-known good state with partial or malformed data.
- Keep startup and periodic polling bounded; make cadence configurable and test rate-header handling only when headers are present.
- No schema migration is needed for an in-process first implementation; restart must trigger a fresh reconciliation when credentials are configured, while local mode restores its deterministic fixture snapshot.

## Qualification procedure if needed

When PAPER credentials are available, perform one authorized read-only account reconciliation against the fixed PAPER host, capture sanitized response field names and rate headers, redact account identifiers and values, and record the outcome under `docs/observed-responses/`. No order endpoint or write method is needed.
