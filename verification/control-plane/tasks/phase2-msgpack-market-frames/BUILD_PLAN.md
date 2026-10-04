# BUILD_PLAN — Phase 2 MessagePack stream frames

Authority: active Phase 2 requires handling actual Alpaca stream frame encodings. Alpaca's official stream docs list `application/json` and `application/msgpack`; this slice implements local decoder support only and does not claim live qualification.

Current delta:
- Keep `decodeMarketFrame` as the common schema boundary and decode JSON strings/bytes or binary MessagePack.
- Limit frame bytes to 256 KiB; configure MessagePack string/binary/array/map/extension bounds; reject nesting over 16 levels; reuse strict existing controls and event schemas.
- Keep provider error text suppressed and reject binary/text codec mismatches.
- Add validated `ALPACA_MARKET_DATA_CODEC` (`json` default, `msgpack`) and match the WebSocket `Content-Type` header to its decoder.
- Check in static sanitized binary batch and singleton control fixtures; compare normalized output with JSON and cover malformed, oversized, deep and mixed frames.
- No migrations or broker order capabilities change. PAPER assertion and fixed data-stream host remain.

Files: `src/domain/market-state.ts`, `src/infra/alpaca-market-stream.ts`, `src/domain/config.ts`, `src/infra/config.ts`, `src/main.ts`, `config/default.json`, tests for market state/stream/config, `fixtures/market/msgpack/*.bin`, `docs/runbook.md`, dependency manifest and lockfile.

Checks: focused typecheck/tests; full `pnpm verify:offline`; config check; PAPER-only and no-live-routes guards. These are credential-free offline checks; no live stream is opened.
