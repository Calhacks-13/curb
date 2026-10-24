import { useCallback, useEffect, useRef, useState } from "react";

import { pointAtDistance, type LngLat } from "@/data/geo";

/** Simulated speed for the demo drive (~25 mph, slightly sped up so it reads on stage). */
const SIM_SPEED_MPS = 11;
const TICK_MS = 120;
/** Look this far ahead when computing heading so turns rotate smoothly. */
const HEADING_LOOKAHEAD_M = 9;

function smoothAngle(prev: number, next: number, k: number) {
  const d = ((next - prev + 540) % 360) - 180;
  return (prev + d * k + 360) % 360;
}

/** Drives a fake car along `line`, reporting position and heading every tick. */
export function useDriveSim(
  line: LngLat[] | null,
  lengthM: number,
  onPosition: (p: LngLat, heading: number, traveledM: number) => void,
) {
  const [driving, setDriving] = useState(false);
  const [traveledM, setTraveledM] = useState(0);
  const traveled = useRef(0);
  const heading = useRef(0);
  const cb = useRef(onPosition);
  useEffect(() => {
    cb.current = onPosition;
  }, [onPosition]);

  const emit = useCallback(() => {
    if (!line) return;
    const { point } = pointAtDistance(line, traveled.current);
    const ahead = pointAtDistance(line, Math.min(lengthM, traveled.current + HEADING_LOOKAHEAD_M)).heading;
    heading.current = smoothAngle(heading.current, ahead, 0.35);
    cb.current(point, heading.current, traveled.current);
  }, [line, lengthM]);

  const reset = useCallback(() => {
    traveled.current = 0;
    setTraveledM(0);
    setDriving(false);
    if (line) heading.current = pointAtDistance(line, HEADING_LOOKAHEAD_M).heading;
    emit();
  }, [line, emit]);

  useEffect(() => {
    reset();
  }, [reset]);

  useEffect(() => {
    if (!driving || !line) return;
    const id = setInterval(() => {
      traveled.current = Math.min(lengthM, traveled.current + (SIM_SPEED_MPS * TICK_MS) / 1000);
      setTraveledM(traveled.current);
      emit();
      if (traveled.current >= lengthM) setDriving(false);
    }, TICK_MS);
    return () => clearInterval(id);
  }, [driving, line, lengthM, emit]);

  const toggle = useCallback(() => {
    if (traveled.current >= lengthM) {
      traveled.current = 0;
      setTraveledM(0);
    }
    setDriving((d) => !d);
  }, [lengthM]);

  return { driving, traveledM, toggle, reset, arrived: traveledM >= lengthM && lengthM > 0 };
}
