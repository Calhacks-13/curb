# Unsigned Parking Openings

## Intent

“Likely open” describes observed availability, not parking legality. A qualified empty curb space can appear when no parking sign has been read.

## Behavior

- Return and display fresh, sufficiently confident open spaces in `UNKNOWN` no-rule zones.
- Continue excluding spaces in explicitly `ILLEGAL` zones.
- Remove the “Legal to park now” map legend row, blue legal-curb visualization, and related user-facing copy.
- A space without sign details shows the existing posted-sign warning in its detail sheet.

## Constraints

Do not change driveway behavior or confidence, freshness, distance, and occupied-space filters. Do not infer legality from availability.

