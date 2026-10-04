# External contract research: Alpaca stock market WebSocket frames

- Date retrieved: 2026-10-04
- Active phase: 2
- Contract question: What envelope and control-message shapes must the local market-stream fixture decoder accept before normalizing stock trade and quote data?

## Sources

| Source | Authority | Retrieved | Notes |
|---|---|---|---|
| [Alpaca WebSocket Stream](https://docs.alpaca.markets/us/docs/streaming-market-data) | official docs | 2026-10-04 | Current general stream message envelope, control messages, content types, connection and symbol limit errors. |
| [Alpaca Real-time Stock Data](https://docs.alpaca.markets/us/docs/real-time-stock-pricing-data) | official docs | 2026-10-04 | Stock trade and quote wire fields, plus additional stock channels. |

## Findings

### CURRENT

- Alpaca describes server messages as JSON arrays. Control messages with `T` equal to `error`, `success`, or `subscription` arrive as one-element arrays. Data messages may be batched into arrays with multiple elements.
- Stream content can use `application/json` or `application/msgpack`; the general stream docs also describe WebSocket compression.
- The documented success controls include `connected` and `authenticated`; subscription controls report the complete current subscription set.
- Stream error controls include distinct codes for authentication, symbol-subscription limit, connection limit, slow-client, and insufficient-subscription conditions.
- Stock trade and quote messages use `T` values `t` and `q`. The docs describe RFC-3339 timestamps, including nanosecond precision in examples.
- The stock stream documents trade `i` and trade `s` as integers; quote `bs` and `as` are integer round-lot sizes. Price fields are numbers.
- The stock quote schema documents bid and ask fields independently and does not establish an invariant that ask must be greater than or equal to bid. The local normalizer therefore validates each price without discarding crossed quotes.
- Documented stock subscription channels include trades, quotes, bars, dailyBars, updatedBars, corrections, cancelErrors, lulds, statuses, and imbalances. Trade corrections and cancel/error subscriptions are automatic when subscribing to trades.
- The current stream error table documents codes 400–407, 409, 410, and 500; 410 means invalid subscribe action for the selected feed and 500 is an internal error.

### DERIVED

- A decoder that only accepts an array of already-decoded trade/quote objects does not cover the documented JSON frame boundary or preserve control-message semantics.
- Control messages must not be silently treated as market data. Provider error codes must remain distinguishable so a symbol limit is not handled as a connection limit.
- Subscription channel names and symbols are untrusted strings. Returning arbitrary provider values can expose credential-shaped content, even when their lengths are bounded; only recognized stock channels and application-supported symbol forms should be returned.
- Provider trade IDs and lot sizes arrive as integer-valued fields. In JavaScript, integers outside the safe-integer range lose identity/ordering precision and must be rejected; price numbers need an explicit finite magnitude ceiling for local normalization.
- MessagePack support is part of the documented stream contract, but the current repository has no MessagePack decoder dependency or live SDK adapter. Fixture coverage alone cannot prove compatibility with a live stream implementation.

### RECOMMENDED

- Define a credential-free frame decoder that accepts JSON text/bytes, validates the top-level array and control-message shapes, and returns normalized data frames separately from typed control events. Keep unsupported/unknown controls explicit errors or typed unknown controls; never coerce them to trades/quotes.
- Keep MessagePack decoding behind an explicit codec boundary and add it only with a maintained decoder dependency and fixture bytes emitted by an authoritative encoder. Do not claim MessagePack support until those fixtures execute.
- Bound the local decoder to 256 KiB per frame, 100 messages per data frame, 32 subscription channels, 100 symbols per channel, and 32 characters per channel or symbol. These are application resource limits, not Alpaca protocol limits; they align with the project's bounded local-state/inspection surface.
- Bound direct batch parsing to the same 100 messages; bound historical replay fixtures to 10,000 events and restore them through bounded chunks so larger replays cannot bypass per-batch parsing limits.
- Bound queued local simulated failures to 100 per provider; reject overflow before changing the queue so repeated fault-injection requests cannot grow process memory without limit.
- Read market/account fixtures through bounded byte readers (4 MiB / 1 MiB), reject unknown fields in checked-in fixtures, and return normalized replay state from the simulated market endpoint so unexpected wire fields cannot reach HTTP responses.
- Keep replay output to 100 distinct symbols, matching the local snapshot schema's maximum state count so every persisted replay state can be restored.
- Accept safe integer error codes from 400 through 599. Preserve the numeric code, but never return or log its untrusted free-form `msg`. Normalize documented codes to stable application-owned names and map unknown in-range codes to a generic `provider_stream_error`. Never persist credentials or raw authentication payloads.
- Allow only the documented stock subscription channel keys. Accept subscription symbols only when they are `*` or match the application's configured uppercase stock-symbol grammar; this both preserves the configured universe and prevents arbitrary credential-shaped strings from entering decoded controls.
- Require safe integer trade IDs and positive safe integer trade/quote sizes. Keep prices finite and positive and reject values beyond `Number.MAX_SAFE_INTEGER` so extreme magnitudes cannot enter normalized state.

### SPECULATIVE

- Whether the production connection will select JSON or MessagePack, and whether the eventual SDK performs decompression, is not yet established because no stream adapter is present.

## Conflicts / unknowns

- No documentary conflict was found for the JSON array envelope and singleton control-message rule.
- The repository does not yet identify a production WebSocket SDK/decoder or negotiated codec. Compatibility with MessagePack, compression, and a particular client library remains unverified.
- No live PAPER test-stream observation was performed; credentials and an authorized live-session qualification were not part of this credential-free local task.

## Implementation consequences

- Offline parser tests should include JSON text and byte frames, multi-event data arrays, each documented control class, control/data shape violations, malformed JSON, frame and subscription bounds, credential-shaped subscription rejection, error-code validation and mappings for every documented code, and safe-integer/magnitude market-field limits.
- `parseMarketBatch` remains the normalized data-schema boundary; a frame decoder should delegate each data entry to it and should not mix provider controls into `MarketEvent`.
- Live codec and compression compatibility cannot be asserted from offline JSON fixtures. A MessagePack decoder change needs explicit dependency/source review and binary fixture evidence.

## Qualification procedure if needed

If live PAPER qualification later becomes authorized and credentials are available, connect once to the documented always-available test feed, authenticate without writing credentials to logs, subscribe to `FAKEPACA`, and capture sanitized envelope/control types plus representative data shapes. Record UTC time and client/SDK version, remove credentials and any sensitive headers, and do not submit trading orders. This procedure was not run for this artifact.
