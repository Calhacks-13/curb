// JavaScript that runs inside the WebView page. Kept as a string because Hermes
// can't serialize functions. Reads its config from window.__CURB__ (see mapHtml.ts)
// and talks to the app through window.__curb.receive / ReactNativeWebView.postMessage.

export const MAP_RUNTIME_JS = String.raw`
(function () {
  "use strict";
  var C = window.__CURB__;
  var reduceMotion = !!C.reduceMotion;
  var currentMood = C.mood;
  var night = C.moods[currentMood].glow;
  var cancelMoodTween = null;
  var ready = false;
  var queue = [];
  var padding = { top: 0, bottom: 0, left: 0, right: 0 };

  function post(msg) {
    var s = JSON.stringify(msg);
    if (window.ReactNativeWebView) window.ReactNativeWebView.postMessage(s);
    else if (window.parent !== window) window.parent.postMessage(s, "*");
    else console.log("[curb->app]", s);
  }

  window.onerror = function (m) { post({ type: "mapError", message: String(m) }); };

  if (!C.token) {
    post({ type: "mapError", message: "Missing EXPO_PUBLIC_MAPBOX_TOKEN" });
    return;
  }
  mapboxgl.accessToken = C.token;

  var startCam = reduceMotion ? C.homeCamera : C.introCamera;
  var basemap = Object.assign({}, C.basemapStatic, C.moods[currentMood].colors, {
    lightPreset: C.moods[currentMood].lightPreset,
    theme: C.moods[currentMood].theme,
  });

  var map = new mapboxgl.Map({
    container: "map",
    style: C.styleUrl,
    config: { basemap: basemap },
    center: startCam.center,
    zoom: startCam.zoom,
    pitch: startCam.pitch,
    bearing: startCam.bearing,
    // iPhones report 3x; 2x is visually identical on a moving map and far cheaper.
    pixelRatio: Math.min(window.devicePixelRatio || 1, C.maxPixelRatio),
    antialias: false,
    attributionControl: false,
    maxPitch: 70,
  });
  map.addControl(new mapboxgl.AttributionControl({ compact: true }), "bottom-right");
  window.__map = map;
  document.body.classList.toggle("night", night > 0.5);

  // --- geo helpers ------------------------------------------------------------------

  function lerpAngle(a, b, t) {
    var d = ((b - a + 540) % 360) - 180;
    return (a + d * t + 360) % 360;
  }
  function point(id, pos, props) {
    return { type: "Feature", id: id, properties: Object.assign({ id: id }, props || {}), geometry: { type: "Point", coordinates: pos } };
  }

  // --- per-segment animation ----------------------------------------------------
  // fade (after an update) and sel (selection) ease toward targets and are written
  // to the segment's curb line and its bays.

  var feats = {};   // segmentId -> { fade, sel, selT }
  var segments = {};
  var bayIds = {};  // segmentId -> [stall ids]
  var target = null;
  var navOn = false;
  var animating = false;
  var lastT = 0;
  var pulseStart = 0;

  function fs(id, obj) {
    map.setFeatureState({ source: "curbs", id: id }, obj);
    (bayIds[id] || []).forEach(function (sid) { map.setFeatureState({ source: "stalls", id: sid }, obj); });
  }

  function kick() {
    if (animating) return;
    animating = true;
    lastT = performance.now();
    requestAnimationFrame(tick);
  }

  function tick(now) {
    var dt = Math.min(64, now - lastT);
    lastT = now;
    var k = reduceMotion ? 1 : 1 - Math.exp(-dt / 140);
    var busy = false;
    Object.keys(feats).forEach(function (id) {
      var f = feats[id], out = null;
      if (f.fade < 1) {
        f.fade = reduceMotion ? 1 : Math.min(1, f.fade + dt / 500);
        (out = out || {}).fade = f.fade;
      }
      if (f.sel !== f.selT) {
        f.sel = Math.abs(f.selT - f.sel) < 0.01 ? f.selT : f.sel + (f.selT - f.sel) * k;
        (out = out || {}).sel = f.sel;
      }
      if (out) { fs(id, out); busy = true; }
    });
    if (navOn && target && !reduceMotion) {
      fs(target, { pulse: ((now - pulseStart) % 1600) / 1600 });
      busy = true;
    }
    animating = busy;
    if (busy) requestAnimationFrame(tick);
  }

  // --- mood cross-fade ------------------------------------------------------------

  function hexToRgb(h) {
    var n = parseInt(h.slice(1), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  function mix(a, b, t) {
    var x = hexToRgb(a), y = hexToRgb(b);
    return "rgb(" + x.map(function (v, i) { return Math.round(v + (y[i] - v) * t); }).join(",") + ")";
  }
  function ease(t) { return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2; }

  function setNight(g) {
    night = g;
    Object.keys(feats).forEach(function (id) { fs(id, { glow: g }); });
    map.setFeatureState({ source: "route", id: "route" }, { glow: g });
    document.body.classList.toggle("night", g > 0.5);
  }

  function applyColors(from, to, t) {
    var a = C.moods[from], b = C.moods[to];
    Object.keys(b.colors).forEach(function (k) {
      map.setConfigProperty("basemap", k, t >= 1 ? b.colors[k] : mix(a.colors[k], b.colors[k], t));
    });
    var half = t < 0.5 ? from : to;
    document.body.style.background = C.moods[half].background;
    // Theme can't interpolate; swap it at the midpoint where both palettes are closest.
    if (map.getConfigProperty("basemap", "theme") !== C.moods[half].theme) {
      map.setConfigProperty("basemap", "theme", C.moods[half].theme);
    }
    setNight(a.glow + (b.glow - a.glow) * t);
    var egoModel = C.moods[half].glow > 0.5 ? C.egoModel.night : C.egoModel.day;
    if (map.getLayer("ego-car") && map.getLayoutProperty("ego-car", "model-id") !== egoModel) {
      map.setLayoutProperty("ego-car", "model-id", egoModel);
    }
  }

  function setMood(next, animate) {
    if (cancelMoodTween) cancelMoodTween();
    var from = currentMood;
    currentMood = next;
    map.setConfigProperty("basemap", "lightPreset", C.moods[next].lightPreset);
    if (!animate || reduceMotion || from === next) {
      applyColors(from, next, 1);
      return;
    }
    var start = performance.now(), raf = 0;
    function frame(now) {
      var t = Math.min(1, (now - start) / C.moodTransitionMs);
      applyColors(from, next, ease(t));
      if (t < 1) raf = requestAnimationFrame(frame);
    }
    raf = requestAnimationFrame(frame);
    cancelMoodTween = function () { cancelAnimationFrame(raf); };
  }

  // --- curb data ------------------------------------------------------------------

  /** Segment lines: drawn only as painted red / white curb edges. */
  function setSegments(list) {
    var features = list.map(function (s) {
      var prev = segments[s.id];
      var f = feats[s.id];
      if (!f) {
        f = feats[s.id] = { fade: 0, sel: 0, selT: 0 };
      } else if (prev && (prev.status !== s.status || (s.lastSeenSeconds || 0) < (prev.lastSeenSeconds || 0))) {
        f.fade = 0; // fresh sighting: fades back in
      }
      segments[s.id] = s;
      return {
        type: "Feature",
        properties: { id: s.id, status: s.status, sideSign: s.side === "right" ? 1 : -1 },
        geometry: { type: "LineString", coordinates: s.coordinates },
      };
    });
    map.getSource("curbs").setData({ type: "FeatureCollection", features: features });
    syncStates();
  }

  /** Bays for open, likely and driveway spots (see map/curbScene.ts). */
  function setStalls(stalls) {
    bayIds = {};
    map.getSource("stalls").setData({
      type: "FeatureCollection",
      features: stalls.map(function (st) {
        (bayIds[st.segmentId] = bayIds[st.segmentId] || []).push(st.id);
        return {
          type: "Feature",
          properties: { id: st.id, segmentId: st.segmentId, kind: st.kind, lastSeenSeconds: st.lastSeenSeconds },
          geometry: { type: "Polygon", coordinates: [st.ring] },
        };
      }),
    });
    syncStates();
  }

  function syncStates() {
    Object.keys(feats).forEach(function (id) { fs(id, { glow: night, fade: feats[id].fade, sel: feats[id].sel }); });
    if (target) fs(target, { target: 1 });
    kick();
  }

  // --- callouts ---------------------------------------------------------------------

  var LOCK = '<svg width="9" height="10" viewBox="0 0 11 12" aria-hidden="true"><rect x="1" y="5" width="9" height="7" rx="1.6" fill="currentColor"/><path d="M3 5V3.6a2.5 2.5 0 0 1 5 0V5" fill="none" stroke="currentColor" stroke-width="1.8"/></svg>';

  function chipHtml(kind) {
    if (kind === "free") return '<span class="chip chip-free">P</span>';
    if (kind === "metered") return '<span class="chip chip-metered"></span>';
    return '<span class="chip chip-driveway">' + LOCK + "</span>";
  }

  var pills = {}; // segmentId -> { marker, el }
  var selected = null;

  function setPills(list) {
    var keep = {};
    list.forEach(function (p) {
      keep[p.segmentId] = true;
      var entry = pills[p.segmentId];
      if (!entry) {
        var el = document.createElement("button");
        el.className = "pin";
        el.innerHTML = '<div class="pin-inner"><div class="callout"></div><div class="tail"></div></div>';
        el.addEventListener("click", function (e) {
          e.stopPropagation();
          post({ type: "spotTapped", segmentId: p.segmentId });
        });
        var marker = new mapboxgl.Marker({ element: el, anchor: "bottom" }).setLngLat(p.position).addTo(map);
        entry = pills[p.segmentId] = { marker: marker, el: el };
      }
      entry.marker.setLngLat(p.position);
      entry.el.dataset.kind = p.kind;
      entry.el.setAttribute("aria-label", p.label);
      var text = p.kind === "free" ? p.label.replace(/^P\s*/, "") : p.label;
      entry.el.querySelector(".callout").innerHTML = chipHtml(p.kind) + "<span>" + text + "</span>";
      entry.el.classList.toggle("is-selected", p.segmentId === selected);
    });
    Object.keys(pills).forEach(function (id) {
      if (!keep[id]) { pills[id].marker.remove(); delete pills[id]; }
    });
    refreshPillVisibility();
  }

  function refreshPillVisibility() {
    Object.keys(pills).forEach(function (id) {
      pills[id].el.style.display = navOn && id !== target ? "none" : "";
    });
  }

  function selectSpot(id) {
    if (selected && feats[selected]) feats[selected].selT = 0;
    selected = id;
    if (id && feats[id]) feats[id].selT = 1;
    Object.keys(pills).forEach(function (pid) { pills[pid].el.classList.toggle("is-selected", pid === id); });
    kick();
  }

  var destMarker = null;
  function setDestination(pos, label) {
    if (!destMarker) {
      var el = document.createElement("div");
      el.className = "dest";
      el.innerHTML = '<div class="dest-label"></div><div class="dest-pin"><div class="dest-dot"></div></div>';
      destMarker = new mapboxgl.Marker({ element: el, anchor: "bottom" }).setLngLat(pos).addTo(map);
    }
    destMarker.setLngLat(pos);
    destMarker.getElement().querySelector(".dest-label").textContent = label;
  }

  function updatePinScale() {
    var z = map.getZoom();
    var s = Math.max(0.85, Math.min(1.08, 0.75 + (z - 15) * 0.1));
    document.documentElement.style.setProperty("--pin-scale", s.toFixed(3));
  }
  map.on("zoom", updatePinScale);
  updatePinScale();

  // --- the user's car ------------------------------------------------------------------

  function rotationFor(heading) {
    return [0, 0, heading * C.headingToRotation.scale + C.headingToRotation.offset];
  }

  var ego = null; // { pos, heading } as drawn
  var egoFrom = null, egoTo = null, egoT0 = 0, egoDur = 1, egoDrawn = false;
  var follow = false, followLockedAt = 0, lastCarMsg = 0;

  function drawEgo() {
    var src = map.getSource("ego");
    var data = { type: "FeatureCollection", features: [point("ego", ego.pos, { rotation: rotationFor(ego.heading) })] };
    // Incremental update once the feature exists, so the source isn't re-tiled every frame.
    if (egoDrawn && src.updateData) src.updateData(data);
    else { src.setData(data); egoDrawn = true; }
    if (follow && performance.now() >= followLockedAt) {
      map.jumpTo({ center: ego.pos, bearing: ego.heading, zoom: C.navCamera.zoom, pitch: C.navCamera.pitch, padding: C.navCamera.padding });
    }
  }

  function egoTick(now) {
    if (!egoTo) return;
    var t = Math.min(1, (now - egoT0) / egoDur);
    ego = {
      pos: [egoFrom.pos[0] + (egoTo.pos[0] - egoFrom.pos[0]) * t, egoFrom.pos[1] + (egoTo.pos[1] - egoFrom.pos[1]) * t],
      heading: lerpAngle(egoFrom.heading, egoTo.heading, t),
    };
    drawEgo();
    if (t < 1) requestAnimationFrame(egoTick);
  }

  function setCarPosition(pos, heading, wantFollow) {
    var now = performance.now();
    var next = { pos: pos, heading: heading };
    if (wantFollow && !follow) {
      // Glide onto the car once, then lock to it every frame.
      follow = true;
      followLockedAt = now + (reduceMotion ? 0 : 1200);
      var cam = { center: pos, bearing: heading, zoom: C.navCamera.zoom, pitch: C.navCamera.pitch, padding: C.navCamera.padding };
      if (reduceMotion) map.jumpTo(cam);
      else map.flyTo(Object.assign(cam, { duration: 1200, curve: 1.1 }));
    } else if (!wantFollow) {
      follow = false;
    }
    if (!ego || reduceMotion || now - lastCarMsg > 600) {
      ego = next;
      egoTo = null;
      drawEgo();
    } else {
      egoFrom = ego;
      egoTo = next;
      egoT0 = now;
      egoDur = Math.max(60, Math.min(400, now - lastCarMsg));
      requestAnimationFrame(egoTick);
    }
    lastCarMsg = now;
  }

  // --- navigation ------------------------------------------------------------------

  function startNav(route, targetId) {
    navOn = true;
    if (target) fs(target, { target: 0, pulse: 0 });
    target = targetId;
    fs(target, { target: 1, pulse: reduceMotion ? 0.3 : 0 });
    pulseStart = performance.now();
    map.getSource("route").setData({
      type: "FeatureCollection",
      features: [{ type: "Feature", properties: { id: "route" }, geometry: { type: "LineString", coordinates: route } }],
    });
    map.setFeatureState({ source: "route", id: "route" }, { glow: night });
    refreshPillVisibility();
    kick();
  }

  function stopNav() {
    navOn = false;
    follow = false;
    if (target) fs(target, { target: 0, pulse: 0 });
    target = null;
    map.getSource("route").setData({ type: "FeatureCollection", features: [] });
    refreshPillVisibility();
  }

  // --- camera ------------------------------------------------------------------------

  function flyTo(cam) {
    var opts = {
      center: cam.center,
      zoom: cam.zoom != null ? cam.zoom : map.getZoom(),
      pitch: cam.pitch != null ? cam.pitch : map.getPitch(),
      bearing: cam.bearing != null ? cam.bearing : map.getBearing(),
      padding: Object.assign({}, padding, cam.padding || {}),
    };
    if (reduceMotion || cam.durationMs === 0) map.jumpTo(opts);
    else map.flyTo(Object.assign(opts, { duration: cam.durationMs || 1200, essential: false, curve: 1.2 }));
  }

  map.on("moveend", function () {
    if (navOn) return;
    var c = map.getCenter();
    post({ type: "cameraChanged", center: [c.lng, c.lat], zoom: map.getZoom(), pitch: map.getPitch(), bearing: map.getBearing() });
  });

  map.on("error", function (e) {
    post({ type: "mapError", message: (e && e.error && e.error.message) || "map error" });
  });

  map.on("load", function () {
    ["route", "curbs", "stalls"].forEach(function (id) {
      map.addSource(id, { type: "geojson", data: { type: "FeatureCollection", features: [] }, promoteId: "id" });
    });
    map.addSource("ego", { type: "geojson", data: { type: "FeatureCollection", features: [] }, dynamic: true });
    C.routeLayers.concat(C.curbLayers).forEach(function (layer) { map.addLayer(layer); });

    Object.keys(C.models).forEach(function (id) { map.addModel(id, C.models[id]); });
    map.addLayer(C.egoLayer);
    map.setLayoutProperty("ego-car", "model-id", night > 0.5 ? C.egoModel.night : C.egoModel.day);

    C.curbLayers.filter(function (l) { return l.source === "stalls"; }).forEach(function (layer) {
      map.on("click", layer.id, function (e) {
        var f = e.features && e.features[0];
        if (f) post({ type: "spotTapped", segmentId: f.properties.segmentId });
      });
    });

    ready = true;
    queue.splice(0).forEach(handle);
    var home = Object.assign({}, C.homeCamera, { padding: padding });
    if (reduceMotion) map.jumpTo(home);
    else map.easeTo(Object.assign(home, { duration: C.introDurationMs, easing: function (t) { return 1 - Math.pow(1 - t, 3); } }));
    post({ type: "mapReady" });
  });

  // --- inbound messages ----------------------------------------------------------------

  function handle(msg) {
    switch (msg.type) {
      case "setMood": return setMood(msg.mood, msg.animate);
      case "setReduceMotion": reduceMotion = msg.reduceMotion; return;
      case "setSegments": return setSegments(msg.segments);
      case "setStalls": return setStalls(msg.stalls);
      case "setPills": return setPills(msg.pills);
      case "setDestination": return setDestination(msg.position, msg.label);
      case "selectSpot": return selectSpot(msg.segmentId);
      case "flyTo": return flyTo(msg.camera);
      case "setPadding":
        padding = msg.padding;
        // Keep the Mapbox logo and attribution visible above native chrome.
        document.documentElement.style.setProperty("--curb-bottom", padding.bottom + "px");
        return;
      case "startNav": return startNav(msg.route, msg.targetSegmentId);
      case "stopNav": return stopNav();
      case "setCarPosition": return setCarPosition(msg.position, msg.heading, msg.follow);
    }
  }

  window.__curb = {
    receive: function (msg) {
      if (!ready) queue.push(msg);
      else handle(msg);
    },
  };
  // Browser preview: accept messages from a parent frame too.
  window.addEventListener("message", function (e) {
    try { var m = typeof e.data === "string" ? JSON.parse(e.data) : e.data; if (m && m.type) window.__curb.receive(m); } catch (_) {}
  });
})();
`;
