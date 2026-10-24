import { useEffect, useState } from "react";

import { resolveMood, type Mood, type MoodSetting } from "@/map/moods";

/** Manual setting plus the mood it resolves to; "auto" re-checks the clock each minute. */
export function useMood(initial: MoodSetting = "auto") {
  const [setting, setSetting] = useState<MoodSetting>(initial);
  const [, setMinute] = useState(0);

  useEffect(() => {
    if (setting !== "auto") return;
    const id = setInterval(() => setMinute((m) => m + 1), 60_000);
    return () => clearInterval(id);
  }, [setting]);

  const mood: Mood = resolveMood(setting);
  return { setting, setSetting, mood };
}
