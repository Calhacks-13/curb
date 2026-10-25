# Curb mobile

Expo SDK 58 / React Native 0.88 app for finding street parking in San Francisco.
Requires a native development build with Xcode 26.4+ and iOS 16.4+;
the map is Mapbox GL JS v3 inside a full-screen `react-native-webview`, and all
chrome (search, sheet, slider, nav) is native React Native on top.

## Run it

From `mobile/`:

```bash
cp .env.example .env          # paste your Mapbox public token (pk.…) and API URL
npm ci --prefix ..            # install workspace dependencies at the repo root
UV_CACHE_DIR=/tmp/curb-uv-cache uv run --python 3.11 scripts/export-coreml-models.py
brew install cocoapods        # once, if pod is missing
CI=1 npx expo prebuild --clean --platform ios
npx expo run:ios --device     # install native debug app and start Metro
```

Expo Go cannot load the custom CurbVision/VisionCamera native modules. For later
JS-only work, use `npx expo start` with the installed native app. Rebuild after
native dependency, configuration, or model changes. Open `ios/Curb.xcworkspace`
in Xcode, select the Curb scheme/iPhone, and set your signing team. Keep persistent
changes in `app.json` or the local module: `ios/` is ignored generated output.

The exporter downloads pinned Python dependencies, both checkpoints, and CLIP;
allow several minutes on a fresh machine. Its ignored packages total about
75 MiB under `modules/curb-vision/models/`. Xcode compiles them as
`yolov8s-seg.mlmodelc` and `yolov8m-worldv2.mlmodelc` in
`CurbVisionModels.bundle`. Fresh checkouts must export before prebuild.
See [the complete build and profiling guide](../ON_DEVICE_CV.md) for exact sign
prompts, model validation, CocoaPods/codegen troubleshooting, the simulator
compile command, signing, privacy, and physical-iPhone checks.

## Layout

```
src/
  app/index.tsx            Demo profile picker (Driver / Driveway Owner)
  app/(tabs)/find.tsx      Find: map, nearby list, details, Route here
  app/(tabs)/host.tsx      Host: the owner's driveway
  features/session/        Seeded demo session, remembered in SecureStore
  features/host/           Owner listing editor, recovery, booking receipt
  features/capture/        Detection JSON transport (one request in flight), location
  api/types.ts             Backend contract (spec sections 11-13); swap for @curb/contracts
  api/client.ts            CurbApi interface + HTTP client; getApi() picks live or demo
  realtime/reducer.ts      Pure versioned event reducer (never rolls an entity back)
  realtime/webPubSub.ts    Azure Web PubSub client with fresh-URL reconnect
  features/find/           Freshness rules, option ranking, parking-state hook, clock
  demo/                    Demo replay adapter, fixture, and the required badge
  lib/laTime.ts            America/Los_Angeles wall-clock helpers
  components/              Native UI (sheets, MapLegend, CameraOverlay in a DraggablePip, map/CurbMap, ...)
  config/tokens.ts         Design tokens (black/white chrome, status colors, radii, Overpass)
  map/
    messages.ts            Typed app <-> map bridge (AppToMap / MapToApp)
    moods.ts               Basemap preset (light day style)
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

Driveway checkout runs Reserve (hold) -> review -> pay -> confirmed, with Retry
and Cancel hold on failure and no hold countdown. In Demo replay no money moves
and the receipt says so; against the real services the receipt links the Base
Sepolia transaction. The contract has no "payment processing" event, so the
owner's Return to available button relies on the server's 409 while a payment
is in flight.

Camera: Find shows a live preview in the corner card whenever it's focused and
the app is in the foreground. On iOS with a live API and location fix,
VisionCamera v5 `useFrameOutput` calls the CoreML Nitro module on native buffers.
Physical buffer rotation keeps boxes/crops upright; every frame is disposed in
`finally`. Only boxes/classes/confidences, sign-crop JPEGs, dimensions, GPS/heading,
device/session ids, and capture time are posted as JSON to
`/v1/vision/detections`. Full frames stay on device. One request may be in flight;
intermediate results are dropped. Stop, blur, backgrounding, permission loss, and
native errors disable inference/submission. Demo replay and Android are preview
only; web shows an unavailable camera card. Android/web never load the iOS module.
Device FPS and Neural Engine placement require profiling.

Every screen has designed loading, empty, error and permission states; the map
has its own error card with Try again, and a "Reconnecting" pill shows while
realtime is down (the map keeps the last state).

Checks: `npm test`, `npm run typecheck`, `npm run lint`.

Run the tests with `npm test` (freshness boundaries, out-of-order realtime
events, version conflicts, idempotent payment, DST).

## 3D car

The user's car is a small glTF model generated in code by `scripts/build-models.mjs`
and embedded as a data URI. Run `node scripts/build-models.mjs`
after editing it.

## Desktop preview of the map

`map/webview/mapHtml.ts` builds a standalone HTML page, so the map can be styled in
a desktop browser. Build it with your token, then call
`window.__curb.receive({ type: "flyTo", camera: { center: [-122.4374, 37.8007], zoom: 18 } })` from the console.
