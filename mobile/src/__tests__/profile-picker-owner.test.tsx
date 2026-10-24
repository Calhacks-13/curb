import { fireEvent, renderRouter, screen } from "expo-router/testing-library";

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

describe("demo profile picker: owner", () => {
  it("opens Host for the driveway owner", async () => {
    await renderRouter(sessionRoutes, { initialUrl: "/" });
    fireEvent.press(await screen.findByLabelText("Continue as Driveway Owner"));
    expect(await screen.findByText("Host screen")).toBeTruthy();
    expect(mockStore.get("curb.demo-profile")).toBe("owner");
  });
});
