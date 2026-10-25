# Palace of Fine Arts presentation supply

`palace.json` contains nearby street geometry from © OpenStreetMap contributors,
licensed under ODbL 1.0: https://www.openstreetmap.org/copyright.
The source ways are recorded in the fixture. Parking observations and regulations
are synthetic presentation data, not verified street regulations or availability.
They use the ordinary map markers, confidence, freshness and detail components.

Authenticated load (the request below keeps sightings current for 30 minutes):

```sh
curl -X POST http://localhost:8000/v1/demo/palace \
  -H 'Authorization: Bearer demo-token-driver_demo' \
  -H 'Content-Type: application/json' \
  -d '{"keep_fresh_seconds":1800}'
```

Startup also adds three nearby residential driveway listings with ordinary purple
markers and reservation support. Repeated starts preserve existing listings and bookings.

The fixture shows eight open stalls spread around the Palace. It mixes
normal freshness bands, several
sign-rule profiles and unsigned curbs. It persists to the same canonical repository
and publishes the usual realtime events, so phones sharing the API see the same
supply. No phone rebuild or frontend mode change is needed.

IDs use the internal `palace-v1:` namespace. Repeated loads refresh those records
and increment entity versions rather than creating duplicates. Other observations,
recorded signs, driveways and bookings are not changed. A refresh loop runs every
30 seconds for the selected duration (0 to 3600 seconds), and ends on shutdown;
after it ends, normal five-minute observation expiry applies.

To stop refreshing and retire only this scenario's markers:

```sh
curl -X POST http://localhost:8000/v1/demo/palace/reset \
  -H 'Authorization: Bearer demo-token-driver_demo'
```

Reset preserves zone/rule records for idempotent reloads, marks the scenario's
spaces unknown, and broadcasts expiry. Existing real CV records are untouched.

Loading automatically retires excess older Palace spaces and disables unused,
unreserved Palace driveways. Actual CV observations and other listings are preserved.
