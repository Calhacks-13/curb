// Haptics for selection, reservation and payment (spec section 8). Never let a
// haptics failure (simulator, Reduce Motion devices) break the flow.

import * as Haptics from "expo-haptics";

const safe = (p: () => Promise<void>) => p().catch(() => {});

export const haptics = {
  select: () => safe(() => Haptics.selectionAsync()),
  tap: () => safe(() => Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light)),
  hold: () => safe(() => Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium)),
  success: () => safe(() => Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success)),
  error: () => safe(() => Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error)),
};
