import { useEffect, useState } from "react";

import { resolveMood, type Mood, type MoodSetting } from "@/map/moods";

/** Manual setting plus the mood it resolves to; "auto" re-checks the clock each minute. */
export function useMood(initial: MoodSetting = "auto") {
  const [setting, setSetting] = useState<MoodSetting>(initial);
  const [mood, setMood] = useState<Mood>(() => resolveMood(initial));

  useEffect(() => {
    setMood(resolveMood(setting));
    if (setting !== "auto") return;
    const id = setInterval(() => setMood(resolveMood("auto")), 60_000);
    return () => clearInterval(id);
  }, [setting]);

  return { setting, setSetting, mood };
}
