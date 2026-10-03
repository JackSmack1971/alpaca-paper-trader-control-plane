---
phase: 2
title: "ALPACA DATA AND ACCOUNT STATE"
source: docs/PROJECT_CHARTER.md
charter_sha256: 8fff9dfd9423c22da6db234e5f7d45f0f6f4414e15c131ba865f3ef7ccc6de5f
---

# PHASE 2 — ALPACA DATA AND ACCOUNT STATE

/goal Implement the Alpaca PAPER market-data and account-state integration required by the system. Treat current official Alpaca Trading API, Market Data API, paper-trading and streaming documentation as authoritative and preserve the permanent PAPER-only invariant.

Support a configurable universe of Alpaca-paper-tradable assets without assuming all symbols share identical sessions, shortability, fractional eligibility or trading capabilities.

One application process owns the multiplexed Alpaca market-data connection. Dashboard, orchestration and decision services consume normalized in-process state rather than opening independent Alpaca streams.

Account for the current plan's documented stream/subscription limits. Validate the configured universe against known limits before connecting, with an explicitly documented override only when the configured account capability supports it. Treat subscription-limit and connection-limit responses as distinct operational conditions rather than blindly reconnecting.

Normalize external data into application-owned schemas. At minimum provide:

`MarketState`
- symbol
- feed
- last trade
- bid/ask and sizes when available
- recent bar/session-derived state required downstream
- source event time
- receive time
- freshness/staleness state and reason

`AccountState`
- equity
- cash
- buying power
- positions
- open orders
- relevant account restrictions/status
- market clock/session state
- authoritative reconciliation timestamp
- source/provenance metadata

Consumers must not depend on Alpaca-specific wire payload types.

Handle:
- stream authentication;
- the actual frame encodings used by market and trade-update streams;
- array/batched market-data messages;
- control messages;
- disconnect/reconnect;
- authentication failure;
- slow-client conditions;
- malformed payloads;
- duplicated/out-of-order events;
- stale data;
- provider rate limiting;
- restart reconciliation.

Where Alpaca documentation and an official SDK exhibit incompatible authentication/frame behavior, qualify the live PAPER endpoint when credentials are available, record sanitized observed evidence, and implement the behavior supported by evidence rather than guessing.

Treat streaming trade updates as event hints. Periodic broker reconciliation remains authoritative for account/order truth. Make reconciliation cadence configurable, defaulting conservatively to approximately 60 seconds unless current API limits/evidence require otherwise.

Respect the Trading API's current account rate limits, inspect rate-limit headers where available, and use bounded retry/backoff instead of request storms.

Malformed external messages must fail schema validation, increment observability counters, and be discarded or quarantined rather than silently coerced into valid state.

Complete only when downstream modules consume normalized timestamped market/account snapshots, freshness and connection health are independently observable, restart reconciliation restores broker truth, and PAPER-only protections remain intact.

Verify with offline normalization/recovery fixtures plus the highest authorized Alpaca verification rung, including the 24/7 test stream where currently supported.

---
