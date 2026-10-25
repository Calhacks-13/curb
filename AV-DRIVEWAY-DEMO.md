# AV Driveway Demo

## The demo

A blue AV dot appears on the map, drives a short route to a seeded driveway, reads the target from our DB, pays for the driveway through x402 (a real on-chain USDC transaction on Base Sepolia), and the driveway pin turns gray "Booked $5.00" on every connected phone. One spot. One route. One transaction. ~10 seconds.

---

## Step by step

```
Second 0    curl -X POST localhost:8000/v1/agent/run-demo
Second 1    Blue AV dot appears on map, starts driving toward the driveway
Second 4    AV reads the seeded driveway from the server
Second 6    AV reaches the driveway, holds it
            -> "driveway.held" broadcast -> driveway dims on all phones
Second 8    AV pays for driveway via x402 (real on-chain transaction)
            -> "booking.confirmed" broadcast -> driveway turns gray "Booked $5.00"
Second 10   AV stops at driveway. Done.
            Server logs: [AV x402] Booked driveway_av_1 — $5.00 USDC — tx: 0xabc...
```

One driveway. The AV drives to it, pays for it, parks.

---

## What already works

- AV marker on map (blue dot, smooth animation, heading)
- `agent.position` realtime events -> map
- Driveway state machine (AVAILABLE -> HELD -> BOOKED)
- Realtime reducer (mobile updates on `driveway.held`, `booking.confirmed`)
- Map renders held/booked driveways
- x402 receipt server + CDP wallet integration
- Payments service with real on-chain x402 settlement

---

## What we build

### 1. Seed one driveway on a short AV route

Add `driveway_av_1` to `public.json` near the existing demo area. Add an `av_demo` user (the AV's identity for the hold). Short route: 5-6 waypoints, ~200m, ending at the driveway.

**File:** `server/app/seed/public.json`

### 2. Rewrite `_drive_av_demo()` for one driveway

Replace the current demo loop (which books 3 curb spots) with a single-target flow:

1. Drive toward `driveway_av_1` (broadcast `agent.position` every 0.5s)
2. When close: call `driveway_service.start_hold()` -> broadcast `driveway.held`
3. Pause 2s (audience sees "on hold" state)
4. Call the payments service, which settles x402 and finalizes the booking with the real transaction hash -> broadcast `booking.confirmed`
5. AV stops. Log payment to terminal.

**File:** `server/app/routes/agent.py`

### 3. Mobile: gray "Booked $5.00" chip

Booked driveway shows as a gray chip with the dollar amount instead of dimmed purple.

**Files:** `mobile/src/features/find/options.ts`, `mobile/src/map/webview/runtime.ts`, `mobile/src/map/webview/mapHtml.ts`

---

## Environment variables required

### Server (`server/.env`)

```
CURB_PAYMENT_SERVICE_TOKEN=<shared secret>
# Optional; defaults to http://127.0.0.1:8787
CURB_PAYMENT_SERVICE_URL=http://127.0.0.1:8787
```

### Payments (`payments/.env`)

```
CDP_API_KEY_ID=<from portal.cdp.coinbase.com>
CDP_API_KEY_SECRET=<from portal.cdp.coinbase.com>
CDP_WALLET_SECRET=<from portal.cdp.coinbase.com>
CURB_API_URL=http://127.0.0.1:8000
CURB_PAYMENT_SERVICE_TOKEN=<same shared secret>
```

CDP keys are required. The entire point is real x402 transactions on Base Sepolia.

---

## How to run

```bash
# Terminal 1: server
cd server && uvicorn app.main:app --reload

# Terminal 2: payments service (required — x402)
cd payments && npm start

# Terminal 3: fund the AV wallet (one-time)
cd payments && npm run fund

# Terminal 4: mobile
cd mobile && npx expo start --clear

# Terminal 5: trigger
curl -X POST http://localhost:8000/v1/agent/run-demo \
  -H "Authorization: Bearer demo-token-driver_demo"
```

---

## Work order

| # | What | Files |
|---|------|-------|
| 1 | Seed `av_demo` user + `driveway_av_1` + short route | `public.json`, `agent.py` |
| 2 | Rewrite `_drive_av_demo()` — one driveway, hold + pay + confirm | `agent.py` |
| 3 | Gray "Booked $5.00" chip on map | `options.ts`, `runtime.ts`, `mapHtml.ts` |
| 4 | Test end-to-end | curl + mobile |

---

## Demo choices

1. **Reset** — restart the server after a run to restore the in-memory driveway to `AVAILABLE`.
2. **Label** — the final map label is exactly `Booked $5.00`.
