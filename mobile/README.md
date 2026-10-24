# Curb mobile

Expo (SDK 58) app for finding street parking in San Francisco. Runs in Expo Go;
the map is Mapbox GL JS v3 inside a full-screen `react-native-webview`, and all
chrome (search, sheet, slider, nav) is native React Native on top.

## Run it

```bash
cp .env.example .env          # then paste your Mapbox public token (pk.…)
npx expo start                # scan the QR with the iPhone camera → Expo Go
npx expo start --tunnel       # if the Wi-Fi blocks device-to-device traffic
```

Expo Go and Expo CLI must be signed in to the same Expo account.

## Layout

```
src/
  app/index.tsx            Find screen
  api/types.ts             Backend contract (spec sections 11-13); swap for @curb/contracts
  api/client.ts            CurbApi interface + HTTP client; getApi() picks live or demo
  realtime/reducer.ts      Pure versioned event reducer (never rolls an entity back)
  realtime/webPubSub.ts    Azure Web PubSub client with fresh-URL reconnect
  features/find/           Freshness rules, option ranking, parking-state hook, clock
  demo/                    Demo replay adapter, fixture, and the required badge
  lib/laTime.ts            America/Los_Angeles wall-clock helpers
  components/              Native UI (NearbySheet, MapLegend, MoodToggle, map/CurbMap, ...)
  config/tokens.ts         Design tokens (black/white chrome, status colors, radii, Overpass)
  map/
    messages.ts            Typed app <-> map bridge (AppToMap / MapToApp)
    moods.ts               Day / dusk / night basemap presets
    mapConfig.ts           Style, camera presets, basemap config
    curbLayers.ts          Layer specs for zones, bays and the route (plain data)
    modelLayers.ts         The user's car as a 3D model layer
    models/generated.ts    glTF car model as data URIs (run scripts/build-models.mjs)
    webview/mapHtml.ts     Builds the WebView document (callout CSS lives here)
    webview/runtime.ts     JS that runs inside the WebView
  data/                    Geometry helpers and Marina street grid for the fixture
```

The map only talks to the app through `map/messages.ts`. To move to native
`@rnmapbox/maps` later, write a component that implements `MapController` and
handles the same messages; nothing in `components/` or `app/` needs to change.

## How parking is drawn

Semantics follow the MVP spec (section 7.3); color is always paired with a label
and a chip shape:

| On the map | Meaning | Shape |
|---|---|---|
| Blue curb line | Legal to park now, availability unknown | line |
| Green bay, "Likely open" | Seen open within 90 s | solid dot |
| Yellow bay, "May be open" | Seen 90 s to 3 min ago | ringed dot |
| Gray bay, "Stale" | 3 to 5 min old; hidden after 5 min | dashed ring |
| Purple bay, "$8 · Reserve" | Private driveway, guaranteed after payment | locked square |

Occupied stalls and zones that aren't legal now are never drawn. Freshness ages
locally every second (`features/find/freshness.ts`), so markers change color and
disappear on time without a server event. Map payloads are built in
`features/find/options.ts`; layer specs live in `map/curbLayers.ts`, callout CSS
in `map/webview/mapHtml.ts`.

## Connecting the real backend

Set `EXPO_PUBLIC_API_URL` (and `EXPO_PUBLIC_PAYMENTS_URL` if the payment service
is separate) in `mobile/.env`. `getApi()` then uses the HTTP client against the
routes in the plan's "Locked External Contracts" table, and realtime comes from
`POST /v1/realtime/negotiate` + Web PubSub. Without it, the app runs the in-memory
**Demo replay** adapter and shows the Demo replay badge; never present that data
as live.

Field names in `src/api/types.ts` follow the spec exactly. When
`packages/contracts` lands, replace that file with re-exports from
`@curb/contracts`.

Run the tests with `npm test` (freshness boundaries, out-of-order realtime
events, version conflicts, idempotent payment, DST).

## 3D car

The user's car is a small glTF model generated in code by `scripts/build-models.mjs`
and embedded as a data URI, so it works in Expo Go. Run `node scripts/build-models.mjs`
after editing it.

## Desktop preview of the map

`map/webview/mapHtml.ts` builds a standalone HTML page, so the map can be styled in
a desktop browser. Build it with your token, then call
`window.__curb.receive({ type: "setMood", mood: "glow", animate: true })` from the console.
