# Unsigned Parking Openings

## Intent

“Likely open” describes observed availability, not parking legality. A qualified empty curb space can appear when no parking sign has been read.

## Behavior

- Return and display fresh, sufficiently confident open spaces in `UNKNOWN` no-rule zones.
- Continue excluding spaces in explicitly `ILLEGAL` zones.
- Label unsigned spaces exactly like signed ones, using the same open-confidence label (for example “80% open”).
- Remove the “Legal to park now” map legend row, blue legal-curb visualization, and related user-facing copy.
- A space without sign details shows the existing posted-sign warning in its detail sheet.

## Constraints

Do not change driveway behavior or confidence, freshness, distance, and occupied-space filters. Do not infer legality from availability.

## Approaches

1. **Availability-first with known-illegal exclusion (selected):** allow unsigned/unknown-rule openings, retain explicit illegal filtering, and remove the legal-status visualization. This matches the requested meaning of “Likely open” without presenting a legal guarantee.
2. **Copy-only removal:** remove the label but continue hiding unsigned openings. Rejected because it would not show the no-sign openings requested.
3. **Ignore legality entirely:** show all observed openings, including explicitly illegal curbs. Rejected because known restrictions should still prevent unsafe suggestions.

