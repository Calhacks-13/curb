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
  if (C.showAttribution) map.addControl(new mapboxgl.AttributionControl({ compact: true }), "bottom-right");
  window.__map = map;
  document.body.classList.toggle("night", night > 0.5);

  function lerpAngle(a, b, t) {
    var d = ((b - a + 540) % 360) - 180;
    return (a + d * t + 360) % 360;
  }
  function point(id, pos, props) {
    return { type: "Feature", id: id, properties: Object.assign({ id: id }, props || {}), geometry: { type: "Point", coordinates: pos } };
  }

  // --- per-bay animation --------------------------------------------------------
  // fade (new opening), sel (selection) and pulse (route target) are eased per
  // bay and written to feature-state on the "stalls" source.

  var bays = {};    // id -> { fade, sel, selT }
  var target = null;
  var animating = false;
  var lastT = 0;
  var pulseStart = 0;

  function fs(id, obj) { map.setFeatureState({ source: "stalls", id: id }, obj); }

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
    Object.keys(bays).forEach(function (id) {
      var b = bays[id], out = null;
      if (b.fade < 1) {
        b.fade = reduceMotion ? 1 : Math.min(1, b.fade + dt / 450);
        (out = out || {}).fade = b.fade;
      }
      if (b.sel !== b.selT) {
        b.sel = Math.abs(b.selT - b.sel) < 0.01 ? b.selT : b.sel + (b.selT - b.sel) * k;
        (out = out || {}).sel = b.sel;
      }
      if (out) { fs(id, out); busy = true; }
    });
    if (target && bays[target] && !reduceMotion) {
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

  function stallColors(g) {
    var P = C.palette, pick = function (c) { return mix(c.day, c.night, g); };
    return ["match", ["get", "kind"], "fresh", pick(P.fresh), "aging", pick(P.aging), "stale", pick(P.stale), pick(P.driveway)];
  }

  function setNight(g) {
    night = g;
    if (map.getLayer(C.stallFillId)) {
      map.setPaintProperty(C.stallFillId, "fill-color", stallColors(g));
      map.setPaintProperty("stall-pulse", "line-color", stallColors(g));
      map.setPaintProperty("stall-select", "line-color", mix(C.palette.select.day, C.palette.select.night, g));
    }
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

  // --- supply ---------------------------------------------------------------------

  function setStalls(stalls) {
    var next = {};
    stalls.forEach(function (st) {
      // New openings fade in; existing ones keep their animation state.
      next[st.id] = bays[st.id] || { fade: 0, sel: st.id === selected ? 1 : 0, selT: st.id === selected ? 1 : 0 };
    });
    bays = next;
    map.getSource("stalls").setData({
      type: "FeatureCollection",
      features: stalls.map(function (st) {
        return { type: "Feature", properties: { id: st.id, kind: st.kind }, geometry: { type: "Polygon", coordinates: [st.ring] } };
      }),
    });
    Object.keys(bays).forEach(function (id) { fs(id, { fade: bays[id].fade, sel: bays[id].sel, target: id === target ? 1 : 0 }); });
    kick();
  }

  // --- callouts ---------------------------------------------------------------------

  var HOUSE = '<svg width="11" height="11" viewBox="0 0 12 12" aria-hidden="true"><path d="M6 1.1 11.2 5.5V11.2H7.6V8H4.4V11.2H0.8V5.5Z" fill="currentColor"/></svg>';
  var CHECK = '<svg width="7" height="7" viewBox="0 0 10 10" aria-hidden="true"><path d="M2 5.2 4.2 7.4 8.2 2.8" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';

  /** Parking-sign chips: solid P, outlined P, dashed P; driveways get a house (with a check once it's yours). */
  function chipHtml(kind, mine) {
    if (kind === "driveway") {
      return '<span class="chip chip-driveway">' + HOUSE + (mine ? '<span class="chip-badge">' + CHECK + "</span>" : "") + "</span>";
    }
    return '<span class="chip chip-p chip-' + kind + '">P</span>';
  }

  function escapeHtml(t) {
    return String(t).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; });
  }
  /** " • " becomes a spaced separator element so its gaps stay even in Overpass. */
  function labelHtml(label) {
    return escapeHtml(label).split(" • ").join('<span class="sep">•</span>');
  }

  var pills = {}; // id -> { marker, el }
  var selected = null;

  function setPills(list) {
    var keep = {};
    list.forEach(function (p) {
      keep[p.id] = true;
      var entry = pills[p.id];
      if (!entry) {
        var el = document.createElement("button");
        el.className = "pin";
        el.innerHTML = '<div class="pin-inner"><div class="callout"></div><div class="tail"></div></div>';
        el.addEventListener("click", function (e) {
          e.stopPropagation();
          post({ type: "spotTapped", id: p.id });
        });
        var marker = new mapboxgl.Marker({ element: el, anchor: "bottom" }).setLngLat(p.position).addTo(map);
        entry = pills[p.id] = { marker: marker, el: el, kind: null, label: null, mine: null, muted: null };
      }
      entry.marker.setLngLat(p.position);
      if (entry.kind !== p.kind || entry.label !== p.label || entry.mine !== !!p.mine || entry.muted !== !!p.muted) {
        entry.kind = p.kind;
        entry.label = p.label;
        entry.mine = !!p.mine;
        entry.muted = !!p.muted;
        entry.el.classList.toggle("is-muted", entry.muted);
        entry.el.dataset.kind = p.kind;
        entry.el.setAttribute(
          "aria-label",
          p.kind === "driveway" && p.muted
            ? "Driveway. " + p.label + "."
            : p.kind === "driveway" && !p.mine
              ? "Driveway. " + p.label + ". Guaranteed after payment."
              : p.label
        );
        entry.el.querySelector(".callout").innerHTML = chipHtml(p.kind, p.mine) + "<span>" + labelHtml(p.label) + "</span>";
      }
      entry.el.classList.toggle("is-selected", p.id === selected);
    });
    Object.keys(pills).forEach(function (id) {
      if (!keep[id]) { pills[id].marker.remove(); delete pills[id]; }
    });
    refreshPillVisibility();
  }

  function refreshPillVisibility() {
    Object.keys(pills).forEach(function (id) {
      pills[id].el.style.display = target && id !== target ? "none" : "";
    });
  }

  function selectSpot(id) {
    if (selected && bays[selected]) bays[selected].selT = 0;
    selected = id;
    if (id && bays[id]) bays[id].selT = 1;
    Object.keys(pills).forEach(function (pid) { pills[pid].el.classList.toggle("is-selected", pid === id); });
    kick();
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

  var ego = null, egoFrom = null, egoTo = null, egoT0 = 0, egoDur = 1, egoDrawn = false, lastCarMsg = 0;

  function drawEgo() {
    var src = map.getSource("ego");
    var data = { type: "FeatureCollection", features: [point("ego", ego.pos, { rotation: rotationFor(ego.heading) })] };
    // Incremental update once the feature exists, so the source isn't re-tiled every frame.
    if (egoDrawn && src.updateData) src.updateData(data);
    else { src.setData(data); egoDrawn = true; }
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

  /** Location updates glide instead of jumping. */
  function setCarPosition(pos, heading) {
    var now = performance.now();
    var next = { pos: pos, heading: heading };
    if (!ego || reduceMotion || now - lastCarMsg > 2000) {
      ego = next;
      egoTo = null;
      drawEgo();
    } else {
      egoFrom = ego;
      egoTo = next;
      egoT0 = now;
      egoDur = Math.max(80, Math.min(1000, now - lastCarMsg));
      requestAnimationFrame(egoTick);
    }
    lastCarMsg = now;
  }

  // --- autonomous demo vehicle -----------------------------------------------------

  var avMarker = null;
  var avHeading = null;
  var av = null, avFrom = null, avTo = null, avT0 = 0, avDur = 500;
  var lastAgentMsg = 0, avGeneration = 0;

  function drawAgent() {
    if (!avMarker) {
      var el = document.createElement("div");
      el.className = "av-marker";
      el.setAttribute("aria-label", "Autonomous vehicle");
      avHeading = document.createElement("span");
      avHeading.className = "av-heading";
      el.appendChild(avHeading);
      avMarker = new mapboxgl.Marker({ element: el, anchor: "center" }).setLngLat(av.pos).addTo(map);
    } else {
      avMarker.setLngLat(av.pos);
    }
    avHeading.style.transform = "rotate(" + av.heading + "deg)";
  }

  function agentTick(now, generation) {
    if (!avTo || generation !== avGeneration) return;
    var t = Math.min(1, (now - avT0) / avDur);
    av = {
      pos: [avFrom.pos[0] + (avTo.pos[0] - avFrom.pos[0]) * t, avFrom.pos[1] + (avTo.pos[1] - avFrom.pos[1]) * t],
      heading: lerpAngle(avFrom.heading, avTo.heading, t),
    };
    drawAgent();
    if (t < 1) requestAnimationFrame(function (next) { agentTick(next, generation); });
  }

  function setAgentPosition(pos, heading) {
    var now = performance.now();
    var next = { pos: pos, heading: heading };
    avGeneration += 1;
    if (!av || reduceMotion || now - lastAgentMsg > 2000) {
      av = next;
      avTo = null;
      drawAgent();
    } else {
      avFrom = av;
      avTo = next;
      avT0 = now;
      avDur = Math.max(80, Math.min(1000, now - lastAgentMsg));
      var generation = avGeneration;
      requestAnimationFrame(function (frameNow) { agentTick(frameNow, generation); });
    }
    lastAgentMsg = now;
  }

  // --- route -------------------------------------------------------------------------

  function fitLine(line) {
    var b = new mapboxgl.LngLatBounds(line[0], line[0]);
    line.forEach(function (p) { b.extend(p); });
    var pad = { top: padding.top + 40, bottom: padding.bottom + 40, left: 48, right: 48 };
    map.fitBounds(b, { padding: pad, pitch: 45, bearing: map.getBearing(), maxZoom: 17.6, duration: reduceMotion ? 0 : 1200 });
  }

  function setRoute(route, targetId, fit) {
    if (target) fs(target, { target: 0, pulse: 0 });
    target = route ? targetId : null;
    map.getSource("route").setData({
      type: "FeatureCollection",
      features: route ? [{ type: "Feature", properties: { id: "route" }, geometry: { type: "LineString", coordinates: route } }] : [],
    });
    map.setFeatureState({ source: "route", id: "route" }, { glow: night });
    if (target) {
      fs(target, { target: 1, pulse: reduceMotion ? 0.3 : 0 });
      pulseStart = performance.now();
    }
    if (route && fit) fitLine(route);
    refreshPillVisibility();
    kick();
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
    var c = map.getCenter();
    post({ type: "cameraChanged", center: [c.lng, c.lat], zoom: map.getZoom(), pitch: map.getPitch(), bearing: map.getBearing() });
  });

  map.on("error", function (e) {
    post({ type: "mapError", message: (e && e.error && e.error.message) || "map error" });
  });

  map.on("load", function () {
    ["route", "stalls"].forEach(function (id) {
      map.addSource(id, { type: "geojson", data: { type: "FeatureCollection", features: [] }, promoteId: "id" });
    });
    map.addSource("ego", { type: "geojson", data: { type: "FeatureCollection", features: [] }, dynamic: true });
    C.routeLayers.concat(C.supplyLayers).forEach(function (layer) { map.addLayer(layer); });

    Object.keys(C.models).forEach(function (id) { map.addModel(id, C.models[id]); });
    map.addLayer(C.egoLayer);
    map.setLayoutProperty("ego-car", "model-id", night > 0.5 ? C.egoModel.night : C.egoModel.day);
    setNight(night);

    map.on("click", C.stallFillId, function (e) {
      var f = e.features && e.features[0];
      if (f) post({ type: "spotTapped", id: f.properties.id });
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
      case "setStalls": return setStalls(msg.stalls);
      case "setPills": return setPills(msg.pills);
      case "selectSpot": return selectSpot(msg.id);
      case "flyTo": return flyTo(msg.camera);
      case "setPadding":
        padding = msg.padding;
        // Keep the Mapbox logo and attribution visible above native chrome.
        document.documentElement.style.setProperty("--curb-bottom", padding.bottom + "px");
        return;
      case "setRoute": return setRoute(msg.route, msg.targetId, msg.fit);
      case "setCarPosition": return setCarPosition(msg.position, msg.heading);
      case "setAgentPosition": return setAgentPosition(msg.position, msg.heading);
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
