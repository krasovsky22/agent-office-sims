/**
 * Which camera the local player looks through, and how far out the third-person
 * one sits.
 *
 * The choice is the player's own and outlives the tab: it is kept in the
 * browser's storage rather than sent anywhere, since nobody else sees through
 * this camera. Storage that is missing, full or refused (a private window, a
 * locked-down browser) is not an error; the camera just starts where it always
 * did, behind the player.
 *
 * Zoom is a distance along the boom, stepped by the mouse wheel. Each notch
 * scales it rather than adding to it, so a notch near the player moves the
 * camera as noticeably as one far out.
 */

export const CAMERA_MODE = {
  firstPerson: "firstPerson",
  thirdPerson: "thirdPerson",
} as const;

export type CameraMode = (typeof CAMERA_MODE)[keyof typeof CAMERA_MODE];

/** Where the choice is kept in the browser's storage. */
export const CAMERA_MODE_STORAGE_KEY = "agent-office-sims.cameraMode";

/** Where the third-person camera starts: the boom length the office was framed for. */
export const DEFAULT_ZOOM_DISTANCE = 7;

/** Closest the wheel brings the camera: near enough to see over the player's shoulder, not into its head. */
export const MIN_ZOOM_DISTANCE = 2.5;

/** Farthest it goes: about half the open-plan floor in view, before the player is a speck. */
export const MAX_ZOOM_DISTANCE = 14;

/** How much one pixel of wheel travel scales the distance by, as an exponent. */
const ZOOM_PER_PIXEL = 0.0015;

/** Pixels a wheel `deltaMode` of lines or pages stands for, so every mouse zooms at about the same rate. */
const PIXELS_PER_LINE = 16;
const PIXELS_PER_PAGE = 800;

/** The mode the player last chose, or third person when none was kept or it cannot be read. */
export function readCameraMode(storage: Pick<Storage, "getItem"> | undefined): CameraMode {
  try {
    return storage?.getItem(CAMERA_MODE_STORAGE_KEY) === CAMERA_MODE.firstPerson
      ? CAMERA_MODE.firstPerson
      : CAMERA_MODE.thirdPerson;
  } catch {
    return CAMERA_MODE.thirdPerson;
  }
}

/** Keeps the choice for next time, if the browser lets it be kept. */
export function writeCameraMode(storage: Pick<Storage, "setItem"> | undefined, mode: CameraMode): void {
  try {
    storage?.setItem(CAMERA_MODE_STORAGE_KEY, mode);
  } catch {
    // Not kept: the next visit starts behind the player, which is no worse than before.
  }
}

/** The other mode. */
export function otherCameraMode(mode: CameraMode): CameraMode {
  return mode === CAMERA_MODE.firstPerson ? CAMERA_MODE.thirdPerson : CAMERA_MODE.firstPerson;
}

/**
 * The boom length after a wheel turn: scrolling down (a positive delta) pulls
 * the camera back, up brings it in, always between the two limits.
 *
 * @param deltaMode the wheel event's `deltaMode`: 0 pixels, 1 lines, 2 pages.
 */
export function zoomedDistance(distance: number, deltaY: number, deltaMode: number): number {
  const pixels = deltaY * (deltaMode === 1 ? PIXELS_PER_LINE : deltaMode === 2 ? PIXELS_PER_PAGE : 1);
  const next = distance * Math.exp(pixels * ZOOM_PER_PIXEL);
  // A wild delta overflows to infinity, which is just as far out as the limit;
  // only a delta that is not a number at all leaves the camera where it was.
  return Math.min(MAX_ZOOM_DISTANCE, Math.max(MIN_ZOOM_DISTANCE, Number.isNaN(next) ? distance : next));
}
