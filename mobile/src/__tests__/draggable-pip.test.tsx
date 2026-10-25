import { render, screen } from "@testing-library/react-native";
import { Text } from "react-native";

import { DraggablePip } from "@/components/DraggablePip";

jest.mock("react-native-reanimated", () => {
  const { View } = jest.requireActual<typeof import("react-native")>("react-native");
  return {
    __esModule: true,
    default: { View },
    useAnimatedStyle: (factory: () => object) => factory(),
    useSharedValue: (initial: unknown) => {
      let value = initial;
      return { get: () => value, set: (next: unknown) => { value = next; } };
    },
    withSpring: (value: unknown) => value,
  };
});
jest.mock("react-native-gesture-handler", () => {
  const chain: Record<string, () => unknown> = {};
  for (const method of ["enabled", "minDistance", "onStart", "onUpdate", "onEnd"]) chain[method] = () => chain;
  return {
    Gesture: { Pan: () => chain },
    GestureDetector: ({ children }: { children: React.ReactNode }) => children,
  };
});

it.each([false, true])("isolates accessibility only while expanded is %s", async (expanded) => {
  await render(
    <DraggablePip
      areaWidth={390}
      areaHeight={844}
      topInset={60}
      bottomInset={100}
      reduceMotion
      expanded={expanded}
    >
      <Text>Camera</Text>
    </DraggablePip>,
  );

  expect(screen.getByHintText("Drag to move").props.accessibilityViewIsModal).toBe(expanded);
});
