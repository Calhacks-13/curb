# Parking-Spot Confidence Design

**Date:** 2026-10-24  
**Status:** Implemented

## Intent

Curb should give drivers a simple, numerical trust explanation for a detected curb opening. The number should help a driver judge the evidence without exposing a diagnostics dashboard or claiming that the space will remain available until arrival.

The selected visual direction is **Option B: Probability Score**. The percentage is the focal point on the map, in spot details, and while routing. Supporting facts are limited to observation age, detection confidence, parking-rule confidence, and the interpreted rule.

## User meaning

The displayed percentage answers:

> Based on the last camera observation and how old it is, how confident is Curb that this space is still open now?

It does **not** predict availability upon arrival and does not include route ETA. Internally this is a heuristic confidence score; statistical calibration against labeled field data is outside this change.

Three concepts remain distinct:

- **Base open-space confidence:** confidence that a genuine car-sized gap was open at the last observation.
- **Detection confidence:** quality of the vehicle detections supporting that gap.
- **Observation age:** elapsed time since the last confirmed observation. This continuously reduces the displayed open-space confidence.

Parking-rule confidence remains separate and never changes the open-space percentage. It describes confidence in the sign interpretation. A rule that is currently illegal continues to exclude the space from user-facing results.

## Goals

- Replace the current hard-coded `1.0` confidence for scanner-confirmed gaps with an evidence-based base confidence.
- Decay the displayed score smoothly as the observation gets older.
- Show the current percentage on map pins, nearby results, spot details, and the active route card.
- Show observation age, raw detection confidence, and parking-rule confidence in spot details.
- Refresh the base confidence and timestamp when the gap is observed again.
- Suggest an alternate spot when the routed target is taken, disappears, or its age-adjusted confidence becomes too low.
- Keep the presentation driver-facing and concise.

## Non-goals

- Predicting whether the space will remain available at the route ETA.
- Presenting location accuracy, GPS uncertainty, raw frame counts, bounding boxes, model classes, or other engineering diagnostics.
- Statistically calibrating the percentage against a labeled production dataset.
- Changing sign detection, sign interpretation, curb-legality evaluation, gap geometry, or spot geolocation.
- Adding confidence percentages to guaranteed driveway listings.

## Selected experience

### Map and nearby list

- A curb-opening map pill uses the age-adjusted value, such as **“82% open.”**
- A nearby curb-opening row leads with the same value. It may retain distance and walking time in the existing row layout, but must not add a second “Likely open” subtitle beneath the percentage.
- Driveway labels remain unchanged.
- Within the same freshness class, higher current confidence ranks before lower current confidence, followed by distance.

### Spot details

The detail sheet shows:

1. A large whole-number percentage headed **“Chance the spot is open.”**
2. A visual meter using the same value.
3. **Last observed:** human-readable age.
4. **Detection confidence:** whole-number percentage from the supporting vehicle detections.
5. **Parking rule confidence:** whole-number percentage from `SignRuleView.interpretation_confidence`, or an em dash when no rule reading is available.
6. The existing interpreted rule summary, hours, duration, payment, and permit information.
7. The existing **Route here** action.

The approved layout removes:

- location accuracy;
- the “Likely open · 2 min walk” line beneath the main percentage;
- the “Computer vision estimate. Check posted signs when you arrive.” disclaimer.

### Active route

- The route card shows ETA and the current age-adjusted open-space percentage.
- It recalculates once per second from the stored base confidence and observation timestamp.
- It shows **“Confidence fell N% while routing”** once the rounded score is at least one percentage point below the score captured when routing began.
- A newer observation replaces the base confidence and timestamp; the route card immediately reflects the refreshed score.
- The app offers the existing alternate-spot prompt when the target is occupied/removed or its displayed current confidence falls below **50%**. The route never changes without driver confirmation.
- The threshold uses the displayed whole-number percentage so the UI never shows “50% open” while simultaneously treating the target as below 50%.
- Suggested curb alternatives must themselves display at least 50% confidence. Among eligible alternatives, retain the existing freshness-first and distance-from-target ranking.

## Confidence model

### Server-owned base evidence

The server computes and persists the base score when a gap first confirms and whenever an existing confirmed gap is refreshed.

For a confirmed `TrackedGap`:

1. Find each real vehicle track anchoring the gap. Ignore `LEFT_FRAME_ID` and `RIGHT_FRAME_ID` virtual boundaries.
2. `detection_confidence` is the minimum current confidence of the real boundary tracks. Interior gaps therefore require both sides to be strong; edge gaps use their single real boundary.
3. Add an observation counter to `TrackedGap`. Increment it each submission in which the same gap remains active.
4. `stability_confidence = min(1, observation_count / 5)`.
5. `base_confidence = clamp(0.8 * detection_confidence + 0.2 * stability_confidence, 0, 1)`.

The duration requirement remains unchanged: a gap is eligible only after it has persisted for `gap_confirm_sec` (currently two seconds). The score is an additional description of evidence, not a replacement for confirmation.

If a confirmed gap cannot resolve its real boundary track, fail closed for that gap rather than publishing invented confidence.

The current segment-level spot model remains unchanged: multiple gaps on the same road segment do not create separate persisted spots. Score all eligible confirmed gaps and choose the representative with the highest `base_confidence`, breaking ties by longer duration and then stable gap key. Use that representative gap for confidence and width on both open and refresh.

### Client-owned age decay

Every client derives the displayed current confidence from persisted fields:

```text
age_seconds = max(0, now - last_observed_at)
age_multiplier = max(0, 1 - age_seconds / 300)
current_confidence = base_confidence * age_multiplier
display_percent = round(100 * current_confidence)
```

- Device clock skew that places `last_observed_at` in the future clamps age to zero.
- Missing or invalid timestamps produce no user-visible confidence and exclude the space from the offered list.
- The current five-minute visibility limit remains authoritative. At more than 300 seconds the space disappears rather than showing 0%.
- All screens use one shared pure confidence helper so percentages cannot disagree.

## Data and contracts

`ParkingSpaceView` and the corresponding TypeScript/contracts types gain:

```text
detection_confidence: number  // finite, 0 through 1; defaults to 0 for legacy records
```

Existing `base_confidence` becomes the server-owned confidence at `last_observed_at`; it is never overwritten with an age-decayed value.

The new field flows through:

- `TrackedGap` evidence calculation;
- `SpotDocument` and `BlockObservation`;
- canonical parking repository persistence;
- detection-response self-feedback;
- nearby and detail responses;
- `space.opened` and `space.refreshed` realtime payloads;
- shared contract schemas, fixtures, and mobile API types.

Seed/demo spaces must define an explicit sample `detection_confidence`. Newly authored scanner records must always include a measured value. Existing persisted records and rolling-deployment payloads that lack the field are normalized to `0`, so the UI displays **Detection confidence: 0%**. The next real scanner refresh replaces that zero with the measured value. No database migration or fallback copied from `base_confidence` is required.

`SignRuleView.interpretation_confidence` remains the source for parking-rule confidence. It is not duplicated into `ParkingSpaceView`.

## Refresh and lifecycle behavior

- Opening a new spot writes its evidence-based `base_confidence`, `detection_confidence`, and observation timestamp.
- Refreshing a still-visible confirmed gap updates all three fields, increments the version, persists the change, and broadcasts `space.refreshed`.
- Occupied and expired behavior stays unchanged.
- Realtime and self-feedback must carry full fields so the scanning phone and other connected clients render the same score.
- The age-decay calculation is local; the server does not broadcast periodic countdown updates.

## Ranking and filtering

- Existing legality, open-state, minimum-base-confidence, radius, and five-minute freshness gates remain in force.
- Keep the backend’s current minimum base confidence of `0.8` for nearby supply.
- On mobile, order curb spaces by freshness class, then descending age-adjusted current confidence, then distance.
- Guaranteed driveways retain their existing ranking rules and never receive a decaying confidence score.

## Error and empty states

- If spot detail is still loading, show the existing loading state rather than a placeholder percentage.
- If the rule is missing or blank, show an em dash for rule confidence while retaining the existing rule-empty state.
- If detection confidence is absent in an older record or payload, normalize it to `0` and show **Detection confidence: 0%** until a real scanner refresh supplies a measured value.
- Non-finite or out-of-range confidence values are rejected at the server model boundary.

## Accessibility

- Announce the main value as “Chance the spot is open: 82 percent.”
- Each supporting value has a complete label, such as “Last observed: 18 seconds ago.”
- Do not rely on meter color alone; the numeric percentage is always present.
- Routing confidence changes use the existing polite live region and should not announce every one-second tick. Announce threshold changes or refreshed evidence only.

## Testing

### Server

- Unit-test detection confidence for interior and edge gaps.
- Unit-test observation counting, the weighted formula, clamping, and missing-boundary fail-closed behavior.
- Verify new and refreshed spots persist and broadcast both confidence fields.
- Verify detection-response self-feedback contains the fields.
- Update canonical models, contract tests, fixtures, nearby/detail tests, and serialization tests.

### Mobile

- Unit-test the shared decay helper at age zero, intermediate ages, 300 seconds, future timestamps, and invalid timestamps.
- Verify map pills, nearby rows, detail percentage, supporting statistics, and route percentage use the same rounded score.
- Verify rule confidence is separate from the open-space score.
- Verify a refreshed observation raises/replaces the routed score correctly.
- Verify the route replacement prompt appears below 50% and not at or above 50%.
- Verify the score disappears with the space after five minutes.
- Verify accessibility labels and restrained live-region announcements.

## Approaches considered

### 1. Server base score plus client-side decay — selected

The server owns evidence quality and the client owns deterministic age decay. This keeps all clients consistent without periodic server traffic and lets the route UI update smoothly offline between realtime events.

### 2. Server-calculated live scores

The server would recalculate and broadcast every age-driven change. This centralizes the value but creates continuous traffic, more realtime state, and a poorer disconnected experience.

### 3. Age-only score

Every confirmed gap would start at 100% and decay. This is cheap but makes weak and strong detections indistinguishable and repeats the current hard-coded-confidence problem.

## Success criteria

- A newly confirmed gap no longer always reports 100% confidence.
- The same spot shows the same percentage across map, nearby list, details, and route at a given instant.
- The value decreases predictably with age and refreshes when new evidence arrives.
- Drivers can see observation age, detection confidence, and rule confidence without engineering diagnostics or location accuracy.
- Other users receive the same evidence fields through realtime and subsequent nearby queries.
