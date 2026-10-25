/** @jest-environment node */

import { buildMapHtml } from "@/map/webview/mapHtml";
import type { AppToMap, MapToApp } from "@/map/messages";

const { JSDOM } = jest.requireActual("jsdom");

/** Real page/DOM/runtime; only the external Mapbox renderer is replaced. */
function mapPage() {
  const dom = new JSDOM(buildMapHtml({ token: "public-token", mood: "clay", reduceMotion: true }), { runScripts: "outside-only" });
  const window = dom.window;
  const messages: MapToApp[] = [];
  const sources = new Map<string, { data: unknown; setData(data: unknown): void }>();
  const handlers = new Map<string, (event?: unknown) => void>();
  class MapRenderer {
    on(event: string, layerOrHandler: string | ((event?: unknown) => void), handler?: (event?: unknown) => void) {
      handlers.set(handler ? `${event}:${layerOrHandler}` : event, handler ?? layerOrHandler as (event?: unknown) => void);
    }
    addSource(id: string, source: { data: unknown }) { sources.set(id, { data: source.data, setData(data) { this.data = data; } }); }
    getSource(id: string) { return sources.get(id); }
    getZoom() { return 17; }
    getLayer() { return true; }
    addControl() {}
    addLayer() {}
    addModel() {}
    setFeatureState() {}
    setLayoutProperty() {}
    setPaintProperty() {}
    jumpTo() {}
  }
  class Marker {
    element: HTMLElement;
    constructor({ element }: { element: HTMLElement }) { this.element = element; }
    setLngLat(position: number[]) { this.element.dataset.position = JSON.stringify(position); return this; }
    addTo() { window.document.body.append(this.element); return this; }
    remove() { this.element.remove(); }
  }
  window.mapboxgl = { Map: MapRenderer, Marker, AttributionControl: class {} };
  window.requestAnimationFrame = () => 1;
  window.ReactNativeWebView = { postMessage: (data: string) => messages.push(JSON.parse(data)) };
  for (const script of window.document.querySelectorAll("script:not([src])")) window.eval(script.textContent);
  const send = (message: AppToMap) => window.__curb.receive(message);
  return { dom, document: window.document as Document, window, messages, sources, handlers, send };
}

it("executes supply messages into stall polygons and semantic pin buttons, then bridges taps and removes expired pins", () => {
  const page = mapPage();
  try {
    const position: [number, number] = [-122.43597, 37.79932];
    const ring: [number, number][] = [position, [-122.4359, 37.79932], [-122.4359, 37.7994], position];
    // Messages arriving before Mapbox loads must survive the runtime queue.
    page.send({ type: "setStalls", stalls: [{ id: "fresh", kind: "fresh", ring }] });
    page.send({ type: "setPills", pills: [
      { id: "fresh", kind: "fresh", label: "Likely open", position },
      { id: "aging", kind: "aging", label: "May still be open", position },
      { id: "stale", kind: "stale", label: "Stale observation", position },
      { id: "driveway", kind: "driveway", label: "$8 • Reserve", position },
    ] });
    page.handlers.get("load")?.();
    expect(page.messages).toContainEqual({ type: "mapReady" });
    expect(page.sources.has("zones")).toBe(false);
    expect(page.sources.get("stalls")?.data).toMatchObject({ features: [{ properties: { id: "fresh", kind: "fresh" }, geometry: { type: "Polygon", coordinates: [ring] } }] });
    const pins = page.document.querySelectorAll<HTMLButtonElement>("button.pin");
    expect(pins).toHaveLength(4);
    expect(pins[0].textContent).toBe("PLikely open");
    expect(pins[1].textContent).toBe("PMay still be open");
    expect(pins[2].textContent).toBe("PStale observation");
    const styles = [0, 1, 2].map((i) => page.window.getComputedStyle(pins[i].querySelector(".chip")));
    expect(styles[0].backgroundColor).not.toBe(styles[1].backgroundColor);
    expect(styles[1].borderStyle).toBe("solid");
    expect(styles[2].borderStyle).toBe("dashed");
    expect(pins[3].querySelector("svg path")).not.toBeNull();
    expect(pins[3].getAttribute("aria-label")).toMatch(/Driveway.*guaranteed after payment/i);
    pins[0].click();
    expect(page.messages.at(-1)).toEqual({ type: "spotTapped", id: "fresh" });
    page.handlers.get("click:stall-fill")?.({ features: [{ properties: { id: "fresh" } }] });
    expect(page.messages.at(-1)).toEqual({ type: "spotTapped", id: "fresh" });

    page.send({ type: "setPills", pills: [
      { id: "driveway", kind: "driveway", label: "Booked $5.00", position, muted: true },
    ] });
    const booked = page.document.querySelector<HTMLButtonElement>("button.pin");
    expect(booked?.textContent).toContain("Booked $5.00");
    expect(booked?.classList.contains("is-muted")).toBe(true);
    expect(booked?.getAttribute("aria-label")).toBe("Driveway. Booked $5.00.");
    expect(booked?.getAttribute("aria-label")).not.toMatch(/guaranteed after payment/i);
    expect(page.window.getComputedStyle(booked!.querySelector(".callout")!).backgroundColor).toBe("rgb(242, 242, 244)");
    expect(page.window.getComputedStyle(booked!.querySelector(".chip-driveway")!).backgroundColor).toBe("rgb(199, 199, 204)");
    expect(page.window.getComputedStyle(booked!.querySelector(".tail")!).borderTopColor).toBe("rgb(242, 242, 244)");
    page.document.body.classList.add("night");
    expect(page.window.getComputedStyle(booked!.querySelector(".chip-driveway")!).backgroundColor).toBe("rgb(110, 110, 115)");

    page.send({ type: "setPills", pills: [] });
    page.send({ type: "setStalls", stalls: [] });
    expect(page.document.querySelectorAll("button.pin")).toHaveLength(0);
    expect(page.sources.get("stalls")?.data).toMatchObject({ features: [] });
  } finally { page.dom.window.close(); }
});

it("renders one blue heading-aware AV marker without replacing the ego car", () => {
  const page = mapPage();
  try {
    page.send({ type: "setCarPosition", position: [-122.42, 37.77], heading: 10 });
    page.send({ type: "setAgentPosition", position: [-122.419, 37.775], heading: 45 });
    page.handlers.get("load")?.();

    const marker = page.document.querySelector<HTMLElement>(".av-marker");
    expect(marker).not.toBeNull();
    expect(page.document.querySelectorAll(".av-marker")).toHaveLength(1);
    expect(marker?.dataset.position).toBe(JSON.stringify([-122.419, 37.775]));
    expect(marker?.querySelector<HTMLElement>(".av-heading")?.style.transform).toBe("rotate(45deg)");
    expect(page.window.getComputedStyle(marker!).backgroundColor).toBe("rgb(10, 132, 255)");
    const ego = page.sources.get("ego")?.data as { features: { geometry: { coordinates: number[] } }[] };
    expect(ego.features[0].geometry.coordinates).toEqual([-122.42, 37.77]);

    page.send({ type: "setAgentPosition", position: [-122.418, 37.776], heading: 90 });
    expect(page.document.querySelectorAll(".av-marker")).toHaveLength(1);
    expect(marker?.dataset.position).toBe(JSON.stringify([-122.418, 37.776]));
    expect(marker?.querySelector<HTMLElement>(".av-heading")?.style.transform).toBe("rotate(90deg)");
  } finally { page.dom.window.close(); }
});
