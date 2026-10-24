# Curb Hackathon MVP Design

**Status:** Approved on October 23, 2026
**Deadline:** Demo-ready before Sunday morning, October 25, 2026
**Team:** Three builders: backend, UI/UX, and general full-stack
**Target:** iPhone only, built with Expo/React Native

## 1. Intent

Curb helps a driver in a saturated urban neighborhood find usable parking faster and with less uncertainty than circling. It combines three kinds of supply in one current-location map:

1. Static, time-aware curb rules derived from parking signs.
2. Fresh curb availability observations derived from contributing cars' cameras.
3. Guaranteed private driveway inventory that can be reserved and paid for.

The product is not primarily a computer-vision showcase. Computer vision, Claude, Azure, x402, and Agentverse are parts of one decision system whose user-facing promise is: **show nearby parking possibilities and make their certainty legible.**

## 2. Users and Core Promise

### Driver

A driver opens Curb near the place where they want to park, sees legal curb zones, recently observed openings, and reservable driveways, inspects the evidence for an option, and chooses whether to route to it.

### Driveway owner

Any driver can also host a driveway from the same app. For the MVP, one seeded owner controls one pre-created listing.

### AV or fleet agent

An Agentverse agent queries the same availability service used by humans and receives machine-readable parking options near a coordinate.

## 3. Goals

- Convert a genuine camera observation from a moving car into a selectable parking marker on another iPhone.
- Explain the applicable parking-sign rules in plain English and preserve them as a structured weekly schedule.
- Make probabilistic curb availability visibly different from guaranteed driveway inventory.
- Complete a real x402 testnet payment and propagate the resulting booking to driver and owner views.
- Expose the same live supply to a discoverable Agentverse/ACP agent.
- Deliver an interactive, smooth, high-quality iPhone experience suitable for a five-minute hackathon demo.

## 4. Non-goals

- Citywide or arbitrary-street parking-space inference.
- Unmarked parallel-parking gap inference in the acceptance path.
- Android support.
- Destination search, adjustable search radius, or future-time curb search.
- Production authentication or user onboarding.
- Owner onboarding, multiple properties, messaging, reviews, cancellations, refunds, or calendar management.
- Production wallet custody or an external-wallet connection flow.
- Full turn-by-turn navigation, voice guidance, or background navigation.
- Temporary paper notices, construction/event restrictions, holiday calendars, sign-arrow interpretation, curb-paint interpretation, hydrant detection, driveways, or accessibility-space interpretation.
- Continuous video retention or source snapshots in the consumer interface.
- Agent-driven reservation as a required feature.

## 5. Anti-goals

The project fails even if the integrations technically work when:

- The application looks bland, generic, or visibly unfinished.
- The public-curb experience implies a reservation or guarantee.
- A false or illegal spot is presented with unjustified certainty.
- The live demo depends on an uncontrolled street event at judging time.

## 6. Constraints and Assumptions

- All implementation starts from an effectively empty repository.
- The judged demonstration is approximately five minutes.
- The driving portion will be recorded before judging from a genuine end-to-end street test.
- One reliable San Francisco block will be pre-scouted.
- Saturday morning, October 24 is the primary scouting and calibration window; Saturday afternoon is the contingency window, and Saturday afternoon or night is reserved for integrating and tuning against the collected package.
- The acceptance block will preferably contain individually marked stalls.
- A teammate's car will occupy and then vacate the target stall to create a repeatable, genuine observation.
- The same app contains both Find and Host tabs.
- Camera capture runs only while the map is open and the app is in the foreground.
- The map remains fully interactive while scanning.
- A passenger or non-driving teammate operates the app during the street test.
- The team has access to Anthropic, Azure, Coinbase/CDP, Mapbox, and Agentverse accounts and two suitable iPhones.

## 7. Product Scope

### 7.1 Demo profiles

The app opens with a one-tap seeded profile selector:

- Continue as Driver
- Continue as Driveway Owner

Each profile maps to a stable backend user ID and demo token stored locally. Both profiles can access Find and Host. Only the owner has the seeded driveway. A small account control allows profile switching. Registration, password recovery, verification, and profile editing are excluded.

### 7.2 Find map

On opening Find, the app:

1. Requests precise location and camera permission when needed.
2. Centers on the current location.
3. Queries a fixed 0.5-mile radius.
4. Begins camera scanning automatically.
5. Shows a floating live camera preview and persistent scanning indicator.
6. Keeps the map fully pannable and zoomable.

There is no pause-scanning control. Scanning stops when the map closes or the app leaves the foreground.

### 7.3 Map semantics

- **Blue curb segment:** parking is legal now; availability is unknown.
- **Green marker:** a marked curb stall was recently observed open and has high freshness.
- **Yellow marker:** the opening may still exist, but the observation is aging.
- **Gray marker:** the observation is stale and near expiry.
- **Purple marker:** a private driveway is available and guaranteed after payment.
- **Occupied stall:** stored internally but hidden from drivers.

Color is paired with text and shape; color alone must not carry meaning.

### 7.4 Curb-space details and routing

Tapping a curb marker opens a detail sheet before any route is drawn. It shows:

- Status label
- Current plain-English rules
- Observation age
- Confidence
- Distance from the driver
- Maximum permitted duration
- The next rule-change time
- `Route here` action button

`Route here` requests a route and draws it on the Curb map. The app does not implement full turn-by-turn guidance. If the selected space becomes occupied or its confidence collapses, Curb recommends a nearby replacement but does not change the route until the driver confirms.

### 7.5 Freshness

Freshness is measured from the latest confirming observation:

- 0–90 seconds: green, `Likely open`
- 90 seconds–3 minutes: yellow, `May still be open`
- 3–5 minutes: gray, `Stale observation`
- After 5 minutes: remove the opening marker and leave the blue legal-curb state

A subsequent observation that confirms the stall is open resets the timer. An occupied observation removes the opening immediately.

A curb opening becomes driver-visible only when all of the following are true:

- The stall is mapped and the camera observation passes the tuned occupancy-confidence threshold.
- Its curb zone has a previously validated structured rule.
- That rule evaluates to legal for the current time in `America/Los_Angeles`.
- It is not currently inside a street-cleaning, no-parking, or permit-only interval that excludes the demo driver.

Metered parking may remain visible with its payment requirement shown. A failed live Claude revalidation does not suppress an otherwise valid marker when a cached rule was previously validated; it retains the cached rule and records the revalidation failure. A zone with no validated rule remains blue/unknown and cannot produce a green opening marker.

### 7.6 Sign interpretation

Claude answers: **Can a driver park here now, for how long, and when does that answer change?**

Required rule types:

- Allowed versus prohibited now
- Effective days and hours
- Maximum parking duration
- Street-cleaning windows
- Permit restrictions
- Metered or paid hours
- `Except Sundays/holidays` clauses visible on the sign
- Next rule-change time
- Interpretation confidence and evidence text

Claude returns structured data, not prose alone. The full weekly schedule is stored so future-time search can be added without changing the data model. The MVP evaluates only current-time legality and the next change.

### 7.7 Driveway marketplace

#### Owner

- See one pre-created driveway listing.
- Toggle it available or unavailable.
- Set price and one availability window.
- See `Payment in progress` while held.
- See it become `Booked`.
- See payment confirmation and the testnet transaction link.

#### Driver

- See an available driveway as a purple guaranteed marker.
- Inspect price, photo, distance, and availability.
- Tap `Reserve`.
- Review a payment confirmation sheet.
- Pay through Curb's pre-funded Base Sepolia demo wallet.
- Receive confirmation and a route.
- See the listing become unavailable to other drivers.

#### Listing state machine

`UNAVAILABLE ↔ AVAILABLE → HELD → BOOKED`

- `HELD` begins when checkout starts.
- It persists until the driver cancels or payment succeeds.
- There is no automatic hold timeout in the MVP.
- A failed payment keeps checkout active so the driver may retry or cancel.
- The owner can manually return an abandoned listing to available only when no payment is actively being signed, verified, or settled. The recovery control is disabled while payment is `PROCESSING`.
- The listing's availability window is interpreted in `America/Los_Angeles` and evaluated at query time. Outside the window it is treated as unavailable without requiring a scheduled job.

### 7.8 x402 payment

The app does not contain private keys or CDP secrets. A persistent Azure-hosted TypeScript payment service owns two pre-created CDP wallets on Base Sepolia: a pre-funded demo driver wallet and a seeded owner/payee wallet. The transaction transfers testnet USDC from the driver wallet to the owner wallet.

1. The app confirms the driver's intent.
2. The payment service calls the x402-protected booking resource.
3. The resource responds with `402 Payment Required`.
4. The CDP x402 client signs and retries.
5. The facilitator verifies and settles the testnet payment.
6. The service records the transaction hash and finalizes the held booking through an idempotent, version-checked operation.
7. Web PubSub broadcasts the booking and driveway state.
8. Both phones show the confirmation and explorer link.

The UI labels this as a demo wallet. A personal embedded or connected wallet is post-MVP.

The blockchain settlement and Cosmos update cannot be one atomic transaction. Before payment, the backend creates a stable booking intent and idempotency key. Retries reuse that intent and transaction evidence rather than paying again. If settlement succeeds but the Cosmos finalization fails, the listing remains held, the payment is recorded as requiring reconciliation, and a retry finalizes the same booking from the existing transaction hash. The MVP does not attempt an automatic refund.

### 7.9 Agentverse

The required agent capability is:

> Find the best currently usable parking options within a supplied radius of these coordinates.

The agent is registered and discoverable on Agentverse and implements ACP. It calls the same nearby-parking query as the iPhone app and returns at most three ranked results with:

- Location and distance
- Curb or driveway type
- Price
- Current rules
- Confidence and freshness
- Availability
- Whether reservation is supported

Agent-driven driveway reservation and x402 payment are a stretch goal.

## 8. Visual and Interaction Quality

The chosen product-level layout is a full-screen map with a floating camera preview. This is a behavioral requirement, not a pixel specification; the UI/UX builder owns visual execution.

The experience must feel:

- **Interactive:** responsive map, selectable markers, draggable sheets, and visible live updates.
- **Smooth:** continuous transitions, non-blocking loading, stable layouts, and no abrupt state jumps.
- **High-quality:** deliberate type, spacing, iconography, color, motion, haptics, and complete states.

Required polish:

- Custom-styled map and marker system
- Smooth marker, camera-preview, and bottom-sheet transitions
- Haptics for selection, reservation, and payment success
- Designed loading, empty, success, and failure states
- No raw JSON, default alerts, browser-style forms, or placeholder-looking screens

## 9. Chosen Technical Approach

### 9.1 Approaches considered

#### A. Azure server-first pipeline — selected

Expo sends compressed frames and metadata to persistent Azure services. Azure runs vision, rules, state, payments, and real-time fan-out.

- Best sponsor alignment
- One shared source of truth
- No custom on-device ML
- Straightforward real-time phone and agent access
- Tradeoff: cellular upload latency and cloud dependency

#### B. Hybrid on-device vision — rejected for MVP

YOLO runs on the iPhone and publishes derived detections.

- Lower bandwidth and latency
- Higher native iOS/Expo integration risk
- Weaker Azure story
- Too risky before Sunday

#### C. Event-heavy Azure pipeline — rejected for MVP

Blob/Event Hubs/Functions/change feeds coordinate the workflow.

- Production-oriented scalability and decoupling
- Too many services, permissions, cold starts, and failure modes for the deadline

### 9.2 System components

#### Expo iOS application

- Expo SDK 58 / React Native / TypeScript / Expo Router
- `expo-camera`
- `expo-location`
- `@rnmapbox/maps`
- Expo development or preview build installed on the two demo iPhones
- Mapbox Directions API for route geometry; no navigation SDK

#### Vision and product API

- Python 3.11+ and FastAPI
- OpenCV and an Ultralytics YOLO model
- Anthropic Python SDK
- Cosmos DB client
- Azure Web PubSub service client
- Agentverse/ACP adapter
- Hosted as an always-warm Azure Container App

#### Payment service

- Node.js/TypeScript
- Official CDP and x402 packages
- Pre-created, pre-funded Base Sepolia wallet
- x402-protected booking resource and payment client
- Hosted as an always-warm Azure Container App

#### Azure data and realtime

- Cosmos DB for users, zones, spaces, observations, sign rules, driveways, holds, and bookings
- Azure Web PubSub for map, observation, listing, hold, booking, and payment events
- No queue, Event Hub, Function, or Blob dependency in the critical path
- No continuous frame storage

## 10. Live Vision Pipeline

### 10.1 Pre-scout calibration

Before the street test, the team:

1. Selects one block with individually marked stalls and readable signs.
2. Creates stable IDs and map coordinates/polygons for a small set of stalls.
3. Creates legal curb-zone geometry.
4. Maps the applicable sign to the zone.
5. Records one or more camera-approach checkpoints with expected heading and approximate screen-space stall/sign regions.
6. Validates the full pipeline using the actual iPhone mount and route.

This calibration is an explicit MVP constraint, not hidden simulated availability.

The initial Saturday-morning calibration package should be complete by midday so it does not block afternoon integration. If the preferred block lacks readable signs or individually marked stalls, the team switches blocks during the scouting session rather than expanding the computer-vision scope.

### 10.2 Capture

- Foreground camera preview remains smooth locally.
- The app samples approximately two compressed 720p JPEG frames per second.
- Each frame includes timestamp, latitude, longitude, GPS accuracy, heading, device ID, and session ID.
- Frames are processed transiently and discarded after inference.

### 10.3 Occupancy

- The server selects the relevant mapped checkpoint from location and heading.
- YOLO detects vehicles in the calibrated stall regions.
- An open result requires agreement across multiple nearby frames, proposed as two of the most recent three usable frames.
- Low-quality, poorly aligned, or low-confidence frames do not change state.
- Multiple frames from one pass update the same `space_id`; they do not create duplicate markers.

Exact model weights, overlap thresholds, and checkpoint tolerances are builder calls to be tuned during scouting.

### 10.4 Rules

- A cached structured rule for the mapped sign makes legality available in the fast path.
- During the live pass, the clearest calibrated sign crop is sent to Claude for revalidation.
- Claude returns schema-validated structured JSON.
- A successful revalidation updates the stored rule and broadcasts the detail change.
- If Claude fails or returns invalid data, Curb preserves the last validated rule and reports that the live revalidation failed; it does not invent a rule.

### 10.5 Publish

The API commits the updated space/observation state in Cosmos and then publishes a versioned Web PubSub event. Clients ignore events older than their current entity version.

## 11. Data Model

All locations use GeoJSON longitude/latitude order.

### User

- `id`
- `display_name`
- `demo_profile`
- `session_token_hash`

### CurbZone

- `id`
- `geometry`
- `sign_rule_id`
- `legal_status_now`
- `next_change_at`
- `version`

### ParkingSpace

- `id`
- `zone_id`
- `location`
- `stall_geometry`
- `internal_state`: `UNKNOWN | OPEN | OCCUPIED`
- `last_observed_at`
- `base_confidence`
- `version`

### Observation

- `id`
- `space_id`
- `session_id`
- `observed_at`
- `occupancy`
- `detection_confidence`
- `location_accuracy`
- `heading`
- `model_version`

### SignRule

- `id`
- `zone_id`
- `weekly_schedule`
- `max_minutes`
- `payment_rules`
- `permit_rules`
- `exceptions`
- `evidence_text`
- `interpretation_confidence`
- `last_validated_at`
- `version`

### Driveway

- `id`
- `owner_id`
- `location`
- `photo_url`
- `price_usdc`
- `availability_start`
- `availability_end`
- `availability_timezone`: `America/Los_Angeles`
- `state`: `UNAVAILABLE | AVAILABLE | HELD | BOOKED`
- `held_by_user_id`
- `version`

### Booking

- `id`
- `idempotency_key`
- `driveway_id`
- `driver_id`
- `state`: `PENDING_PAYMENT | PROCESSING | RECONCILIATION_REQUIRED | CONFIRMED | CANCELLED`
- `amount_usdc`
- `network`
- `transaction_hash`
- `created_at`
- `confirmed_at`

## 12. API Surface

Exact route naming is a builder call; the following capabilities are required:

- Start a seeded demo session and switch profile.
- Query parking within 0.5 miles of coordinates.
- Negotiate a Web PubSub client connection.
- Upload a sampled frame and its location metadata.
- Read a space and its current rules.
- Update the owner's driveway availability, price, and window.
- Start a driveway hold.
- Cancel a driveway hold.
- Run the x402 payment and confirm the booking.
- Read the booking receipt.
- Serve the Agentverse parking-search capability.

State transitions must be conditional on the current entity version so simultaneous requests cannot double-book the driveway.

## 13. Realtime Event Contract

Events include `type`, `entity_id`, `entity_version`, `occurred_at`, and the minimum updated payload.

Required event types:

- `space.opened`
- `space.refreshed`
- `space.occupied`
- `space.expired`
- `sign_rule.updated`
- `driveway.updated`
- `driveway.held`
- `driveway.released`
- `booking.confirmed`
- `payment.failed`

## 14. Performance Targets

These are engineering guardrails, not user promises.

| Operation | Expected | Maximum passing |
|---|---:|---:|
| Curb marker on second phone | 2–3 seconds | 5 seconds |
| Live Claude rule revalidation | 4–7 seconds | 10 seconds |
| x402 booking | 5–10 seconds | 15 seconds |
| Realtime state propagation after commit | Under 1 second | 2 seconds |

## 15. Five-minute Demo Narrative

Proposed sequence:

1. **Problem and promise (30 seconds):** finding legal parking is uncertain; Curb combines rules, observations, and guaranteed supply.
2. **Recorded live street run (60 seconds):** teammate vacates a marked stall; dashcam sees it; marker appears on the other phone; Claude rules and freshness are shown.
3. **Map decision flow (45 seconds):** open details, explain confidence versus guarantee, and tap `Route here`.
4. **Driveway marketplace (75 seconds):** driver reserves the purple listing; x402 testnet payment settles; driver and owner views update; open transaction receipt.
5. **Agentverse (45 seconds):** agent queries the same coordinate and returns current curb and driveway options.
6. **Architecture, sponsor value, and close (45 seconds):** Azure as the state/realtime hub; Claude for rules; x402 for physical-space payment; Agentverse for AV access.

The exact presentation pacing is left to the team, but the street video should be limited to its strongest 45–60 seconds.

## 16. Demo Reliability and Recovery

- Record multiple genuine end-to-end street runs and use the clearest successful clip.
- The five-minute indoor presentation shows the curb observation as part of the recorded genuine run. An hours-old observation is not presented in the live app as current.
- If the team needs an indoor interaction walkthrough of the same curb state, use an explicitly labeled `Demo replay` or fixture mode that bypasses freshness claims; never silently refresh an old timestamp.
- Preserve the successful run's derived observations in Cosmos for debugging or labeled replay only, without storing video frames.
- Pre-create the driver and owner CDP wallets, fund the driver wallet, and verify balances and the protected endpoint before judging.
- Keep both Azure services warm.
- Validate both iPhones, camera/location permissions, and Mapbox tokens on the event network.
- Provide a clearly labeled local fixture mode only as a last-resort UI fallback; do not represent fixture data as a live observation.
- The owner can manually recover a listing stuck in `HELD` only when its booking intent is not processing a payment.
- Failed Claude revalidation retains the last validated rule and surfaces the failure internally.

## 17. Security and Privacy Boundaries

- Do not embed Anthropic, Azure, CDP, x402, or Agentverse secrets in the Expo bundle.
- Use HTTPS for all phone-to-service traffic.
- Store only sampled derived observations and structured rules; discard raw frames and sign crops after processing.
- Do not show evidence snapshots to users.
- Use testnet funds only.
- Treat seeded authentication as demo-only and do not claim production security.
- Do not log secrets, full payment credentials, or raw image bodies.

## 18. Sponsor Integration Story

### Anthropic

Claude turns stacked parking signs into a structured weekly schedule and a current plain-English rule. Its output directly controls whether a detected opening is presented as usable.

### Microsoft Azure

Azure Container Apps run vision/product and payment services. Cosmos DB is the shared geographic/state store. Web PubSub distributes live observations, confidence changes, holds, and bookings.

### Coinbase x402

A physical driveway booking is an x402-protected resource paid in testnet USDC. The receipt is a real testnet transaction, not a mocked success screen.

### Fetch.ai

A discoverable ACP agent queries the same live availability API as human users. AV reservation is the next step, with agent-driven x402 payment as a stretch goal.

## 19. Builder-owned Decisions

The implementation team may choose without further product approval:

- Exact component library and visual styling within the quality bar.
- Exact Mapbox style, marker artwork, motion curves, spacing, and sheet dimensions.
- Exact FastAPI and Node route names.
- Exact Cosmos partition keys and container grouping.
- Exact YOLO weights, detection thresholds, and checkpoint tolerances.
- Exact Claude vision-capable model, provided it meets the schema and latency target.
- Local versus EAS iOS build workflow, provided both devices are ready.
- Test framework and internal observability tools.

## 20. Post-MVP Direction

- Unmarked curb-gap inference and broader curb mapping.
- More contributors, repeated observations, and historical availability prediction.
- Future-arrival legality search using the stored weekly schedule.
- Personal embedded or connected wallets.
- Agent reservation and x402 payment.
- Production identity, owner onboarding, disputes, refunds, and reputation.
- Full navigation, background capture where permitted, and broader city coverage.
- AV fleet APIs, access controls, and commercial data products.
