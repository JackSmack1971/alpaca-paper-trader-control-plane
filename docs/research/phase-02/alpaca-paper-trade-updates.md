# External contract research: Alpaca PAPER trade updates stream

- Date retrieved: 2026-10-04
- Active phase: 2
- Contract question: Which authentication message and frame codec does the current PAPER `trade_updates` stream accept for a read-only subscriber?
- Research disposition: BLOCKED — current official documentation and the official SDK disagree on the authentication message, and no authorized PAPER credentials are available to qualify the endpoint.

## Sources

| Source | Authority | Retrieved | Notes |
|---|---|---|---|
| https://docs.alpaca.markets/us/docs/websocket-streaming | current official documentation | 2026-10-04 | PAPER stream URL, supported codecs, auth/listen messages, acknowledgements and trade event payloads. |
| https://github.com/alpacahq/alpaca-py/blob/master/alpaca/trading/stream.py | official SDK source, `master` (unversioned) | 2026-10-04 | `TradingStream` selects PAPER endpoint, sends a different JSON auth message, then listens and decodes JSON. |
| `docs/PROJECT_CHARTER.md`, Phase 2 | repository authority | 2026-10-04 | Requires qualification when documentation and official SDK behavior conflict, when credentials are available. |

## Findings

### CURRENT

- Alpaca documents the PAPER Trading API WebSocket endpoint as `wss://paper-api.alpaca.markets/stream`.
- Alpaca says the trading stream supports JSON and MessagePack. Its docs state that `trade_updates` from the PAPER endpoint use binary WebSocket frames, and that MessagePack can be requested with `Content-Type: application/msgpack`.
- The documented authentication payload is `{ "action": "auth", "key": "…", "secret": "…" }`. The documented successful acknowledgement is on `authorization` with `data.status` equal to `authorized`.
- The documented subscription is `{ "action": "listen", "data": { "streams": ["trade_updates"] } }`; the `listening` acknowledgement reports the active stream list.
- Trade-update records use the `trade_updates` envelope and include `event` and `order`. Documented events include new, fill, partial fill, canceled, expired, done-for-day, replaced, accepted, rejected, and other order lifecycle states. Fill events may include timestamp, price, quantity, and resulting position quantity.
- The official Python `TradingStream` source selects its PAPER endpoint when `paper=True`, sends `{ "action": "authenticate", "data": { "key_id": "…", "secret_key": "…" } }`, checks the authorization status, then sends the documented `listen` payload. It decodes received frames with `json.loads` and does not show a MessagePack codec in this path.

### DERIVED

- The authentication messages are incompatible: a client cannot treat both shapes as the same provider contract without observing which one the PAPER endpoint accepts.
- The word “binary” describes the WebSocket frame opcode, while the docs separately identify JSON and MessagePack as codecs. The SDK's JSON decoder could consume JSON bytes in a binary frame; source inspection alone does not prove the default PAPER payload codec. This must be distinguished during qualification.
- A successful `listening` acknowledgement is a sufficient read-only subscription check. No order needs to be submitted to establish the authentication and subscription contract.

### RECOMMENDED

- Do not implement an authenticated production `trade_updates` client until the repository-required PAPER qualification resolves the authentication conflict and selected codec.
- Keep the future stream as an event-hint source; retain REST reconciliation as the account/order authority. Do not let a stream event alone establish reconciled broker truth.
- In qualification, capture only sanitized control names, status/action values, WebSocket frame opcode, codec parse result, SDK version/commit, client version, and UTC time. Never persist credentials, account identifiers, order contents, or raw frames.

### SPECULATIVE

- The endpoint may accept either authentication shape, or SDK and documentation behavior may target different server generations. Neither possibility is established by the sources above.
- Binary frames may carry JSON when JSON is selected. The documentation does not specify the default codec for PAPER trade-update frames precisely enough to assert this.

## Conflicts / unknowns

- The current official documentation specifies `action: "auth"` with top-level `key` and `secret`; the official SDK source specifies `action: "authenticate"` with nested `key_id` and `secret_key`. No documented version, account tier, or publication note explains the difference.
- The endpoint's accepted auth shape, default serialization of binary frames, and relation between the unversioned SDK source and the currently documented PAPER service remain unresolved.
- No Alpaca credentials are available in this credential-free local environment. Therefore the required endpoint qualification cannot be performed here. Per the Phase 2 charter and external-contract evidence policy, the stream implementation choice remains BLOCKED rather than inferred from one source.

## Implementation consequences

- Keep the existing credential-free fixture replay and simulated account/order resources separate from the authenticated provider stream. They do not resolve the provider authentication contract.
- Do not add a client that silently chooses one auth shape, retries alternate credentials, or treats a mock acknowledgement as observed provider behavior.
- When qualification becomes authorized, request JSON explicitly where the endpoint supports the JSON content type; capture whether the PAPER server returns text or binary frames and parse the payload using the negotiated codec. Bound frame size, validate event schemas, sanitize errors, and treat stream messages as hints subject to periodic REST reconciliation.
- Keep provider stream status, local simulator status, and REST reconciliation freshness observable independently.

## Qualification procedure if needed

With authorized PAPER credentials, open one bounded connection to the fixed PAPER stream endpoint. On the first fresh connection, send only the documented authentication form and record its sanitized acknowledgement or rejection. If rejected, close it; on a separate fresh connection, send only the official SDK form and record its sanitized acknowledgement or rejection. For whichever form is accepted, request only `trade_updates`, capture the `listening` acknowledgement and frame opcode/JSON parse result, then close the socket. Do not submit, cancel, or replace any order. Record UTC time, SDK commit/version, Node/client version, endpoint class (`PAPER`), payload shape, response shape and remaining limits under `docs/observed-responses/`; omit credentials, account data and raw frames.
