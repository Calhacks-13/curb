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
  app/index.tsx            Find parking + navigation screen (one screen, two modes)
  components/              Native UI: SearchBar, OptionsSheet, TimeSlider, SharingLivePip,
                           MoodToggle, SpotIcon, nav/NavBanner, nav/NavBottomCard,
                           map/CurbMap (the WebView host)
  config/tokens.ts         Design tokens (black/white chrome, status colors, radii, Overpass)
  map/
    messages.ts            Typed app <-> map bridge (AppToMap / MapToApp)
    moods.ts               Day / dusk / night basemap presets
    mapConfig.ts           Style, camera presets, basemap config
    curbLayers.ts          Mapbox layer specs for curbs and the route (plain data)
    curbScene.ts           Turns segments into the bays shown on the map
    modelLayers.ts         The user's car as a 3D model layer
    models/generated.ts    glTF car model as data URIs (run scripts/build-models.mjs)
    webview/mapHtml.ts     Builds the WebView document (also holds the spot pill CSS)
    webview/runtime.ts     JS that runs inside the WebView
  data/
    types.ts               CurbSegment, the shared contract
    provider.ts            CurbDataProvider + RoutingProvider interfaces and factories
    prediction.ts          pOpen interpolation, confidence by age, labels
    spots.ts               Picks the three sheet options
    mock/                  Mock Marina data, live-update simulator, grid router
```

The map only talks to the app through `map/messages.ts`. To move to native
`@rnmapbox/maps` later, write a component that implements `MapController` and
handles the same messages; nothing in `components/` or `app/` needs to change.

## How curbs are drawn

Flat and quiet, closer to a ride-hailing map than a dashboard: color only appears
where you can park. `map/curbScene.ts` turns segments into bays: open spots are
solid green bays (lighter when the sighting is older), likely spots are green
outlines, driveways are a blue bay. Taken curb isn't drawn. No-parking and loading
curbs are thin painted edges (red / white), like real SF curbs. Callouts are white
with black type and a small status chip; the selected one inverts. Layer specs
live in `map/curbLayers.ts`, callout CSS in `map/webview/mapHtml.ts`.

## Plugging in real data (backend / CV / payments)

Everything the UI reads comes through `src/data/provider.ts`:

```ts
export interface CurbDataProvider {
  getSegments(bounds: Bounds): Promise<CurbSegment[]>;
  subscribe(bounds: Bounds, onChange: (segments: CurbSegment[]) => void): () => void;
}
export interface RoutingProvider {
  routeTo(from: LngLat, heading: number, target: CurbSegment): Promise<Route>;
}
```

1. Implement `CurbDataProvider` against the server, e.g. `src/data/api/apiProvider.ts`.
   `subscribe` should call `onChange` with the **full current list** for the bounds
   every time something changes (a WebSocket or SSE push, or polling every few
   seconds). The map diffs by `id`; changed segments fade in automatically.
2. Return it from `getCurbProvider()` in `provider.ts`. That's the only line the UI depends on.
3. Do the same for `getRoutingProvider()` when a directions service exists.
   `Route` is `{ line: [lng, lat][], lengthM, steps: { atM, maneuver, street }[] }`.

The segment shape (`src/data/types.ts`):

```ts
type CurbSegment = {
  id: string;                      // stable across updates
  coordinates: [number, number][]; // lng, lat along the block
  side: "left" | "right";          // which curb, relative to coordinate direction
  status: "open" | "likely" | "no_parking" | "loading" | "driveway" | "full";
  price?: string;                  // "Free", "$3.50/hr", "$8"
  rule?: string;                   // "2 hr, until 6 PM"
  lastSeenSeconds?: number;        // age of the last CV sighting
  predicted?: { minutesAhead: number; pOpen: number }[]; // e.g. 15, 30, 60
};
```

Notes for producers:

- **Geometry.** Send the street centerline for the block (or anything within a
  couple of meters of it) and set `side`. The map pushes the line 5.2 m to that
  side with `line-offset` (`CURB_OFFSET_M` in `map/curbLayers.ts`). For very wide
  streets (Lombard) shift the coordinates toward the curb yourself; see `widen` in
  `data/mock/marina.ts`.
- **`side`** is relative to the order of `coordinates`: `right` is the right-hand
  curb when walking from the first coordinate to the last.
- **Confidence.** Lines fade as `lastSeenSeconds` grows, using `CONFIDENCE_BY_AGE`
  in `data/prediction.ts`. Leave it undefined for purely predicted segments.
- **Predictions.** Only `open`, `likely` and `full` change with the time slider.
  "Now" uses the status itself; `predicted` covers future minutes, and the UI
  interpolates between points.
- **Payments.** Driveway rentals only need `status: "driveway"`, `price` and `rule`
  for now. Booking will hook into the "Go to this spot" CTA in `OptionsSheet`.
- **Sharing live.** `SharingLivePip` is a stub; its `onPress` is where the CV
  team's camera screen opens.

## 3D car

The user's car is a small glTF model generated in code by `scripts/build-models.mjs`
and embedded as a data URI, so it works in Expo Go. Run `node scripts/build-models.mjs`
after editing it.

## Desktop preview of the map

`map/webview/mapHtml.ts` builds a standalone HTML page, so the map can be styled in
a desktop browser. Build it with your token, then call
`window.__curb.receive({ type: "setMood", mood: "glow", animate: true })` from the console.
