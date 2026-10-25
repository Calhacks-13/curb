# Persisted Sign-to-Space Association Design

## Intent

A physical parking-sign pole is recorded once and may be confirmed by later scans. Every subsequently detected open curb space governed by that sign should receive its stored parking rules even when the sign is not visible in the space-detection frames.

## Goals

- Reuse a persisted street-sign reading when a later scan confirms an open space.
- Prefer a sign read in the current submission over an older persisted reading.
- Match only signs on the same directional side of the street.
- Apply the resolved rules both when a space opens and when an existing space is refreshed.
- Keep repeated sign scans deduplicated as observations of the same physical sign.

## Non-goals

- Redesigning the persisted schema around explicit zone/sign foreign keys.
- Interpreting sign arrows into geometric coverage ranges.
- Changing gap detection, sign OCR, or the mobile API contract.
- Creating multiple independently located stalls inside one current road-segment record.

## Constraints

- Continue using `road_segment_id`, which combines an approximately 11-metre position grid with travel direction.
- A nearby fallback must never cross to the opposite travel direction.
- No rule is safer than attaching a known opposite-side rule.
- Existing persisted `SignDocument` and `SpotDocument` records remain readable.

## Approaches

1. **Resolve in the detection pipeline (selected).** On space confirmation, use a reading from the current submission first; otherwise query the geolocated in-memory and persisted signs, prefer an exact `road_segment_id`, and then choose the nearest same-direction sign within a bounded radius. Copy the resolved reading onto the spot and canonical scan record. This is a focused change compatible with the current schema.
2. **Normalize the database around curb zones.** Store a sign rule once on a zone and have every spot reference the zone. This is the strongest long-term model, but it requires a schema migration and broader API changes outside this request.
3. **Resolve rules only when clients query spaces.** Leave stored spots unchanged and dynamically join nearby signs in read endpoints. This risks inconsistent behavior across realtime events, detail endpoints, and background consumers.

## Selected Behavior

When a gap is confirmed, the pipeline resolves rules in this order:

1. A sign reading produced by the current submission.
2. A geolocated in-memory or persisted sign with the exact same `road_segment_id`.
3. The nearest geolocated in-memory or persisted street sign whose direction matches the space segment, within 50 metres.
4. No sign rule if no safe match exists.

Garage and parking-lot signs are excluded. The session's unlocated `last_sign_reading` is not used, preventing rules from one block leaking to another during a drive. An existing open spot receives newly resolved rules during refresh. Re-scanning an already stored sign reuses its reading and persists its updated `last_confirmed` timestamp rather than creating another sign record.

## Success Criteria

- A sign recorded in an earlier pipeline/session is attached to a later open space on the same curb side.
- An opposite-direction sign is not attached.
- Exact-segment matches win over merely nearby matches.
- A repeated scan keeps one sign document and updates its confirmation timestamp.

