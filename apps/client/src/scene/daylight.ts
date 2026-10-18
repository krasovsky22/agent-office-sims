/**
 * What the light looks like at each minute of the in-game day.
 *
 * A short table of moments — night, dawn, morning, noon, evening, dusk — and a
 * linear blend between neighbours, wrapping at midnight. Linear in every channel
 * means the light is continuous in time, so however the clock arrives the scene
 * never pops. The table is the only place the look of a day is decided; tuning
 * dusk is an edit to one row.
 *
 * The directional light is the sun by day and the moon by night. Each crosses
 * the sky on its own half of the day and they hand over at the horizon, where
 * the table holds the light at zero, so the change of direction is never seen.
 * Neither ever sinks below {@link MIN_ELEVATION}: the shadow camera stays where
 * `lighting.ts` aimed it and shadows stretch rather than streak off the floor.
 *
 * Sampling writes into a {@link Daylight} the caller made once, so it can run
 * every frame without allocating.
 */

import { MINUTES_PER_DAY } from "@sim/shared";
import * as THREE from "three";

/** The sun rises at 06:00 and sets at 18:00; the moon has the other twelve hours. */
const SUNRISE_MINUTE = 6 * 60;
const SUNSET_MINUTE = 18 * 60;
const HALF_DAY_MINUTES = MINUTES_PER_DAY / 2;

/** Lowest either light sits over the horizon, so shadows stay on the floor. */
const MIN_ELEVATION = THREE.MathUtils.degToRad(20);
const SUN_MAX_ELEVATION = THREE.MathUtils.degToRad(68);
const MOON_MAX_ELEVATION = THREE.MathUtils.degToRad(50);

/** Light at one moment of the day. Colours are sRGB hex, as authored. */
interface Moment {
  readonly minute: number;
  /** The directional light: the sun by day, the moon by night. */
  readonly sun: number;
  readonly sunIntensity: number;
  readonly sky: number;
  readonly ground: number;
  readonly skyIntensity: number;
  /** How far up the interior lights are, 0 off to 1 full. */
  readonly interior: number;
  /** The sky, seen over the walls and out of the street windows. */
  readonly background: number;
}

const MOONLIGHT = 0x8ea4d8;

/**
 * The day, from midnight to midnight.
 *
 * The hemisphere never drops below about half its daytime strength and the
 * interior lights are full from dusk to dawn, which is what keeps every room
 * readable at 3am. Daytime is the look the office had before the clock drove
 * it, so the opening hours are unchanged.
 */
const MOMENTS: readonly Moment[] = [
  { minute: 0, sun: MOONLIGHT, sunIntensity: 0.3, sky: 0x5b6684, ground: 0x2a2a33, skyIntensity: 0.6, interior: 1, background: 0x0a0e1c },
  { minute: 5 * 60, sun: MOONLIGHT, sunIntensity: 0.25, sky: 0x5f6a88, ground: 0x2a2a33, skyIntensity: 0.6, interior: 1, background: 0x10162a },
  { minute: 6 * 60, sun: 0xff9a5c, sunIntensity: 0, sky: 0x9c8c96, ground: 0x302d33, skyIntensity: 0.75, interior: 0.85, background: 0x7d6676 },
  { minute: 7 * 60, sun: 0xffc48f, sunIntensity: 0.75, sky: 0xd2cdcc, ground: 0x37363c, skyIntensity: 0.95, interior: 0.35, background: 0xc4b6ab },
  { minute: 9 * 60, sun: 0xffffff, sunIntensity: 1.2, sky: 0xdfe3ea, ground: 0x3a3a40, skyIntensity: 1.1, interior: 0, background: 0xa9c1d8 },
  { minute: 16 * 60, sun: 0xfff3e2, sunIntensity: 1.15, sky: 0xdfe3ea, ground: 0x3a3a40, skyIntensity: 1.1, interior: 0, background: 0xaec3d6 },
  { minute: 17 * 60 + 30, sun: 0xff9d5a, sunIntensity: 0.7, sky: 0xd8bba6, ground: 0x3a3438, skyIntensity: 0.9, interior: 0.45, background: 0xd4a68a },
  { minute: 18 * 60, sun: 0xff7a45, sunIntensity: 0, sky: 0x8a7d92, ground: 0x2f2b33, skyIntensity: 0.75, interior: 0.85, background: 0x6e5470 },
  { minute: 19 * 60, sun: MOONLIGHT, sunIntensity: 0.22, sky: 0x5f6a88, ground: 0x2a2a33, skyIntensity: 0.62, interior: 1, background: 0x161c33 },
  { minute: MINUTES_PER_DAY, sun: MOONLIGHT, sunIntensity: 0.3, sky: 0x5b6684, ground: 0x2a2a33, skyIntensity: 0.6, interior: 1, background: 0x0a0e1c },
];

/** Every colour in {@link MOMENTS}, converted once to the renderer's working space. */
interface Keyframe {
  readonly minute: number;
  readonly sun: THREE.Color;
  readonly sunIntensity: number;
  readonly sky: THREE.Color;
  readonly ground: THREE.Color;
  readonly skyIntensity: number;
  readonly interior: number;
  readonly background: THREE.Color;
}

const KEYFRAMES: readonly Keyframe[] = MOMENTS.map((moment) => ({
  ...moment,
  sun: new THREE.Color(moment.sun),
  sky: new THREE.Color(moment.sky),
  ground: new THREE.Color(moment.ground),
  background: new THREE.Color(moment.background),
}));

/** The scene's lighting at one instant, refilled in place by {@link sampleDaylight}. */
export interface Daylight {
  /** Unit vector from the floor towards the directional light. */
  readonly sunDirection: THREE.Vector3;
  readonly sunColour: THREE.Color;
  sunIntensity: number;
  readonly skyColour: THREE.Color;
  readonly groundColour: THREE.Color;
  skyIntensity: number;
  /** 0 with the interior lights off, 1 with them full. */
  interior: number;
  readonly background: THREE.Color;
}

export function createDaylight(): Daylight {
  return {
    sunDirection: new THREE.Vector3(),
    sunColour: new THREE.Color(),
    sunIntensity: 0,
    skyColour: new THREE.Color(),
    groundColour: new THREE.Color(),
    skyIntensity: 0,
    interior: 0,
    background: new THREE.Color(),
  };
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/**
 * Points `out` at the sun or moon at `minute`.
 *
 * Each rises in +X, crosses through +Z at its highest, and sets in -X, so the
 * office sees its shadows swing across the floor over the day. At the horizon
 * the two directions differ, which is why the table puts the light out there.
 */
function aimAt(minute: number, out: THREE.Vector3): void {
  const isDay = minute >= SUNRISE_MINUTE && minute < SUNSET_MINUTE;
  const sinceRise = isDay
    ? minute - SUNRISE_MINUTE
    : (minute - SUNSET_MINUTE + MINUTES_PER_DAY) % MINUTES_PER_DAY;
  const arc = (sinceRise / HALF_DAY_MINUTES) * Math.PI;
  const peak = isDay ? SUN_MAX_ELEVATION : MOON_MAX_ELEVATION;
  const elevation = MIN_ELEVATION + (peak - MIN_ELEVATION) * Math.sin(arc);
  const level = Math.cos(elevation);
  out.set(Math.cos(arc) * level, Math.sin(elevation), Math.sin(arc) * level);
}

/**
 * The light at `minuteOfDay`, which may be fractional.
 *
 * Out-of-range minutes wrap, so a caller can hand over a clock that has just
 * ticked past midnight without normalising it first.
 */
export function sampleDaylight(minuteOfDay: number, out: Daylight): Daylight {
  const minute = ((minuteOfDay % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY;

  // Ten rows: a scan is cheaper than anything cleverer, and allocates nothing.
  let index = 1;
  while (index < KEYFRAMES.length - 1 && (KEYFRAMES[index]?.minute ?? MINUTES_PER_DAY) <= minute) {
    index += 1;
  }
  const from = KEYFRAMES[index - 1];
  const to = KEYFRAMES[index];
  if (from === undefined || to === undefined) {
    throw new Error("The daylight table needs at least two moments.");
  }
  const t = (minute - from.minute) / (to.minute - from.minute);

  aimAt(minute, out.sunDirection);
  out.sunColour.lerpColors(from.sun, to.sun, t);
  out.sunIntensity = lerp(from.sunIntensity, to.sunIntensity, t);
  out.skyColour.lerpColors(from.sky, to.sky, t);
  out.groundColour.lerpColors(from.ground, to.ground, t);
  out.skyIntensity = lerp(from.skyIntensity, to.skyIntensity, t);
  out.interior = lerp(from.interior, to.interior, t);
  out.background.lerpColors(from.background, to.background, t);
  return out;
}
