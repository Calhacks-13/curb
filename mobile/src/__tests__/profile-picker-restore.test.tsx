import { renderRouter, screen } from "expo-router/testing-library";

import { sessionRoutes } from "./helpers/sessionRoutes";

jest.mock("expo-secure-store", () => {
  const mockStore = new Map<string, string>();
  return {
    mockStore,
    getItemAsync: jest.fn(async (k: string) => mockStore.get(k) ?? null),
    setItemAsync: jest.fn(async (k: string, v: string) => void mockStore.set(k, v)),
    deleteItemAsync: jest.fn(async (k: string) => void mockStore.delete(k)),
  };
});

// Expo Router keeps its in-memory URL per module registry, so each flow gets its own file.
const { mockStore } = jest.requireMock("expo-secure-store") as { mockStore: Map<string, string> };

describe("demo profile picker: restore", () => {
  it("skips the picker when a profile was saved on this device", async () => {
    mockStore.set("curb.demo-profile", "owner");
    await renderRouter(sessionRoutes, { initialUrl: "/" });
    expect(await screen.findByText("Host screen")).toBeTruthy();
  });
});
