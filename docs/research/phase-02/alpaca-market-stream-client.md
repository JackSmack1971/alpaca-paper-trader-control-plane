# External contract research: Alpaca stock market stream client

- Date retrieved: 2026-10-04
- Active phase: 2
- Contract question: Which endpoint, authentication, subscription-limit, framing, and failure behaviors must a single-owner Node.js stock market WebSocket client implement?

## Sources

| Source | Authority | Retrieved | Notes |
|---|---|---|---|
| https://docs.alpaca.markets/us/docs/streaming-market-data | official docs | 2026-10-04 | Market stream URL, test stream, message authentication, control framing, subscription behavior, error codes, and JSON/MessagePack content types. |
| https://docs.alpaca.markets/us/docs/real-time-stock-pricing-data | official docs | 2026-10-04 | Stock feeds and trade/quote message fields. |
| https://docs.alpaca.markets/us/docs/about-market-data-api | official docs | 2026-10-04 | Current Basic and Algo Trader Plus equity WebSocket symbol limits and data coverage. |
| https://nodejs.org/download/release/v22.23.3/docs/api/globals.html | official Node.js docs | 2026-10-04 | Node 22 global WebSocket is stable and browser-compatible. |
| https://github.com/websockets/ws/blob/master/doc/ws.md | official ws client documentation | 2026-10-04 | The Node WebSocket client accepts custom handshake headers. |

## Findings

### CURRENT

- Stock market data connects to `wss://stream.data.alpaca.markets/v2/{feed}`. The always-available test feed is `wss://stream.data.alpaca.markets/v2/test` and uses `FAKEPACA`.
- Trading API credentials may be sent in an authentication message after connecting as `{ action: "auth", key, secret }`; authentication must happen within 10 seconds. This avoids requiring custom opening-handshake headers.
- A stock market subscription is sent as `{ action: "subscribe", trades: [...], quotes: [...] }`. Subscription acknowledgements are singleton array control frames and contain the complete subscription set.
- Subscribing to trades automatically includes trade corrections (`T: "c"`) and trade cancels/errors (`T: "x"`) in the stream subscription. Corrections identify original and corrected trade IDs and prices; cancel events identify a trade ID and `C`/`E` action.
- Control messages (`success`, `subscription`, `error`) arrive in singleton arrays. Market data messages may be batched in arrays. JSON and MessagePack are both supported through the stream content-type selection.
- Alpaca documents code 405 for exceeding the account's stream symbol limit and 406 for exceeding its stream connection limit. It documents 407 for a slow client; that message is not guaranteed before disconnect. Error messages should be distinguished by code.
- The current regular-user equity plan table lists 30 WebSocket symbols for Basic and unlimited for Algo Trader Plus. Basic supplies real-time IEX equity data; Algo Trader Plus supplies all US stock exchanges. The default Paper/Live account plan is Basic.
- Node.js 22.23.3 documents the global WebSocket as stable and browser-compatible.
- The `ws` Node client supports custom handshake headers; version 8.22.0 is available and has no runtime dependencies. The adapter can explicitly request `Content-Type: application/json` rather than relying on an undocumented default.

### DERIVED

- A single process-level owner is necessary to avoid creating a second connection for each consumer, especially because the common account connection allowance is one.
- Message-based authentication is compatible with Node's global WebSocket and keeps the API secret out of URLs and request logs.
- The configured feed determines the path segment and must be validated against the stock-feed allow-list before a connection is opened.
- Stream symbol capacity depends on the account plan. Without an explicit configured capability, the Basic 30-symbol ceiling is the defensible bound; code 405 and 406 are provider conditions, not ordinary transient network failures.
- The existing JSON frame decoder matches the documented market-data envelope. It does not decode the distinct binary trade-update protocol; trade updates must remain outside this market stream adapter until their separate contract is implemented.

### RECOMMENDED

- Add one application-owned market stream client that is constructed at most once, accepts an injected WebSocket factory/clock for deterministic tests, and emits only normalized application-owned market events and sanitized health counters.
- Use the fixed `stream.data.alpaca.markets` host, stock path `v2`, and a validated configured feed. Do not accept arbitrary URL overrides.
- Authenticate with the documented post-connect JSON message. Send the subscription only after the validated `authenticated` control arrives. Never log outbound auth messages or raw provider frames.
- Enforce 30 distinct symbols unless configuration explicitly identifies Algo Trader Plus capability. Leave subscription acknowledgment and feed-availability errors visible as typed degraded states.
- Do not retry codes 402, 405, 406, 409, or 410 as transport failures. For unclassified disconnects and slow-client disconnects, use bounded reconnect/backoff and re-authenticate/re-subscribe once per owned connection.
- Keep MessagePack unsupported until a selected client/codec has bounded binary decoding and fixtures generated by an authoritative encoder. The existing decoder should reject binary frames explicitly.
- In local test mode, never construct the provider client; exercise the state machine through the injected socket fake and existing fixture runtime instead.

### SPECULATIVE

- No credentialed stream connection was attempted. The actual account plan, credential validity, feed entitlement, provider latency, and live disconnect/reconnect behavior remain unobserved.
- No credentialed stream connection was attempted, so the selected client’s live content negotiation and decompression behavior remain unobserved.
- Provider-specific heartbeat and close-frame behavior is not fully specified by the cited documentation and must not be invented as a contract.

## Conflicts / unknowns

- The docs permit both HTTP-header and message authentication. The implementation decision is to use message authentication, which is directly documented and works with the Node global WebSocket interface.
- The docs support both JSON and MessagePack. The client will explicitly request JSON with a handshake content-type header; binary MessagePack support remains explicitly unimplemented rather than guessed.
- The docs identify Basic and Algo Trader Plus limits, but this credential-free environment cannot establish the account's actual plan. Production startup must default to Basic capacity unless plan capability is explicitly configured.

## Implementation consequences

- Add a server-only adapter using `ws` with explicit `Content-Type: application/json`, whose URL is composed from the fixed host and a validated stock feed; no browser client and no live trading endpoint.
- Keep Alpaca key and secret in the infrastructure boundary; send them only in the documented auth message and exclude raw payloads from logs, traces, and exception text.
- Bound distinct symbols to 30 under Basic; allow the documented unlimited symbol capability only through explicit Algo Trader Plus configuration. Keep the application's own state cap independently bounded.
- Treat 405 symbol limit and 406 connection limit as distinct terminal provider errors. Authentication and feed-entitlement errors also fail closed; only transport closures use bounded reconnect behavior.
- Test connection count, URL selection, authentication ordering, subscription acknowledgment, batched JSON decode, malformed-frame counters, secret redaction, typed 405/406 behavior, reconnect/backoff bounds, stop/close behavior, and absence of any provider connection in local mode with injected fakes.
- No database migration is required for the initial in-process socket owner. Persistence of normalized market records, if needed by downstream decision replay, remains through the existing versioned market-record schema.

## Qualification procedure if needed

When credentials are available and authorized, use one application-owned connection to `wss://stream.data.alpaca.markets/v2/test`, authenticate through the documented message form, subscribe to `FAKEPACA`, and capture only sanitized control/data shapes, feed, Node/client version, and UTC observation time. Do not print credentials, raw auth frames, or provider message text. Separately qualify the configured account feed and actual symbol/connection entitlement before selecting a non-Basic plan. No live qualification was run for this research.
