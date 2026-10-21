/**
 * Hangs the office's wall decor: framed pictures, posters, clocks, whiteboards,
 * a shelf and the conference room's TV.
 *
 * Where each piece goes is `@sim/shared`'s `OFFICE_DECOR`, placed against the
 * wall it names; this file only decides what it looks like. None of it
 * collides or is interactive, so it is all set dressing and kept cheap: every
 * frame, bezel, shelf board and book is one instance of a single batch of unit
 * boxes, artwork is painted once into a texture shared by every frame showing
 * it, and nothing casts a shadow. The clocks move, showing the office's own
 * time of day, and the TV's screen is repainted for the channel it is on.
 */

import {
  type OfficeLayout,
  type WallArt,
  type WallDecorPlacement,
  type WallDecorSpec,
  MINUTES_PER_DAY,
  wallDecorPlacement,
} from "@sim/shared";
import * as THREE from "three";

import { TV_CANVAS_WIDTH } from "./tvScreen.js";
import { paintArt, paintClockFace, paintTvSlide, paintWhiteboard } from "./wallArt.js";

/** Pixels per metre of artwork, so a big picture is no blurrier than a small one. */
const ART_PIXELS_PER_METRE = 320;
/** Largest edge of any artwork canvas. */
const MAX_ART_PIXELS = 1024;

const FRAME_BORDER = 0.045;
const FRAME_DEPTH = 0.035;
/** How far a face stands proud of whatever it is mounted on, so the two never fight for a pixel. */
const FACE_OFFSET = 0.003;

const BEZEL = 0.035;
const TV_DEPTH = 0.05;
const WHITEBOARD_RIM = 0.03;
const WHITEBOARD_DEPTH = 0.025;
const CLOCK_DEPTH = 0.045;
const CLOCK_RIM = 0.025;

const SHELF_THICKNESS = 0.03;
const SHELF_DEPTH = 0.24;

/** Frame mouldings, picked per picture so a row of them is not all one colour. */
const FRAME_COLOURS = [0x2b2b2e, 0x7a5434, 0xc8a24a, 0xf0ede6] as const;
const CERTIFICATE_FRAME_COLOUR = 0x3a2a1a;
const SIGN_FRAME_COLOUR = 0x111318;
const BEZEL_COLOUR = 0x0d0f12;
const ALUMINIUM_COLOUR = 0xb9bec4;
const SHELF_COLOUR = 0x5a3d26;
const CLOCK_RIM_COLOUR = 0x1f2328;
const CLOCK_HAND_COLOUR = 0x15171a;
const TROPHY_COLOUR = 0xd9b13b;
const BOOK_COLOURS = [0xb23a48, 0x2f5d8a, 0x3b7d4f, 0xe0a030, 0x6d4c9f, 0x2a2a2a] as const;

/** Where the hour and minute hands of a clock point, as clockwise angles from twelve. */
export function clockHandAngles(minuteOfDay: number): { readonly hour: number; readonly minute: number } {
  const minute = ((minuteOfDay % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY;
  return {
    hour: ((minute % 720) / 720) * Math.PI * 2,
    minute: ((minute % 60) / 60) * Math.PI * 2,
  };
}

/** The office's wall decor in the scene, and the clock time it shows. */
export interface WallDecorView {
  readonly group: THREE.Group;
  /** Sets every clock's hands to a minute of the day. */
  showMinute(minuteOfDay: number): void;
  /** Repaints the TV's screen, `TV_CANVAS_WIDTH` texels wide; a layout with no TV ignores it. */
  paintTv(paint: (context: CanvasRenderingContext2D, width: number, height: number) => void): void;
}

/** One box, in a piece's own frame, for the shared instanced batch. */
interface BoxPart {
  readonly centre: THREE.Vector3;
  readonly size: THREE.Vector3;
  readonly colour: number;
}

/** A canvas texture, painted once unless the caller keeps it to repaint. */
function canvasTexture(
  width: number,
  height: number,
  maxAnisotropy: number,
  paint: (ctx: CanvasRenderingContext2D, w: number, h: number) => void,
): THREE.CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (ctx !== null) {
    paint(ctx, width, height);
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = maxAnisotropy;
  return texture;
}

/** Canvas size for a face `width` by `height` metres. */
function pixelsFor(width: number, height: number): { readonly w: number; readonly h: number } {
  const scale = Math.min(ART_PIXELS_PER_METRE, MAX_ART_PIXELS / Math.max(width, height));
  return { w: Math.max(16, Math.round(width * scale)), h: Math.max(16, Math.round(height * scale)) };
}

/** A string hash, to pick a frame colour per piece that stays put between loads. */
function hashOf(text: string): number {
  let hash = 0;
  for (const char of text) {
    hash = (Math.imul(hash, 31) + char.charCodeAt(0)) >>> 0;
  }
  return hash;
}

function frameColourFor(spec: WallDecorSpec): number {
  if (spec.art === "certificate") {
    return CERTIFICATE_FRAME_COLOUR;
  }
  if (spec.art === "officeSign") {
    return SIGN_FRAME_COLOUR;
  }
  return FRAME_COLOURS[hashOf(spec.id) % FRAME_COLOURS.length] ?? FRAME_COLOURS[0];
}

/**
 * Builds every piece of decor and adds it to the scene.
 *
 * @param maxAnisotropy the renderer's, so artwork seen at an angle down a
 * corridor stays sharp.
 */
export function buildWallDecor(
  scene: THREE.Scene,
  layout: OfficeLayout,
  decor: readonly WallDecorSpec[],
  maxAnisotropy: number,
): WallDecorView {
  const root = new THREE.Group();
  root.name = "wall-decor";

  const boxes: BoxPart[] = [];
  const boxPieces: THREE.Matrix4[] = [];
  const artMaterials = new Map<string, THREE.Material>();
  const plane = new THREE.PlaneGeometry(1, 1);
  const hands: { readonly hour: THREE.Object3D; readonly minute: THREE.Object3D }[] = [];
  const tvTextures: THREE.CanvasTexture[] = [];

  const clockFace = new THREE.MeshLambertMaterial({
    map: canvasTexture(256, 256, maxAnisotropy, (ctx, w) => paintClockFace(ctx, w)),
  });
  const clockRim = new THREE.MeshLambertMaterial({ color: CLOCK_RIM_COLOUR });
  const handMaterial = new THREE.MeshLambertMaterial({ color: CLOCK_HAND_COLOUR });
  const trophyMaterial = new THREE.MeshLambertMaterial({ color: TROPHY_COLOUR });
  const discGeometry = new THREE.CircleGeometry(0.5, 40);
  const rimGeometry = new THREE.CylinderGeometry(0.5, 0.5, 1, 40, 1, true);
  // A hand pivots at its base, the clock's centre, and points up at rest.
  const handGeometry = new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0);

  /** A material showing `art` at this aspect, shared by every frame that hangs it. */
  const artMaterial = (art: WallArt, width: number, height: number): THREE.Material => {
    const { w, h } = pixelsFor(width, height);
    const key = `${art}:${w}x${h}`;
    let material = artMaterials.get(key);
    if (material === undefined) {
      material = new THREE.MeshLambertMaterial({
        map: canvasTexture(w, h, maxAnisotropy, (ctx, cw, ch) => paintArt(ctx, art, cw, ch)),
      });
      artMaterials.set(key, material);
    }
    return material;
  };

  /** A flat face `z` in front of the wall, centred at height `y`, in a piece's frame. */
  const addFace = (
    piece: THREE.Object3D,
    material: THREE.Material,
    size: { readonly width: number; readonly height: number },
    y: number,
    z: number,
  ): void => {
    const mesh = new THREE.Mesh(plane, material);
    mesh.scale.set(size.width, size.height, 1);
    mesh.position.set(0, y, z);
    piece.add(mesh);
  };

  for (const spec of decor) {
    const placement = wallDecorPlacement(layout, spec);
    if (placement === undefined) {
      // `describeDecorProblems` reports it; a piece with no wall is not drawn.
      continue;
    }
    const piece = pieceAt(placement);
    piece.name = spec.id;
    const centreY = spec.elevation + spec.height / 2;
    const parts: BoxPart[] = [];

    switch (spec.kind) {
      case "picture":
        parts.push(box(0, centreY, FRAME_DEPTH / 2, spec.width + FRAME_BORDER * 2, spec.height + FRAME_BORDER * 2, FRAME_DEPTH, frameColourFor(spec)));
        if (spec.art !== undefined) {
          addFace(piece, artMaterial(spec.art, spec.width, spec.height), spec, centreY, FRAME_DEPTH + FACE_OFFSET);
        }
        break;
      case "poster":
        if (spec.art !== undefined) {
          addFace(piece, artMaterial(spec.art, spec.width, spec.height), spec, centreY, FACE_OFFSET);
        }
        break;
      case "tv": {
        parts.push(box(0, centreY, TV_DEPTH / 2, spec.width + BEZEL * 2, spec.height + BEZEL * 2, TV_DEPTH, BEZEL_COLOUR));
        // Lit from within, so it reads as a screen that is on; sharper than art, as it shows boards.
        const texture = canvasTexture(TV_CANVAS_WIDTH, Math.round((TV_CANVAS_WIDTH * spec.height) / spec.width), maxAnisotropy, paintTvSlide);
        tvTextures.push(texture);
        const screen = new THREE.MeshBasicMaterial({ map: texture, toneMapped: false });
        addFace(piece, screen, spec, centreY, TV_DEPTH + FACE_OFFSET);
        break;
      }
      case "whiteboard": {
        parts.push(
          box(0, centreY, WHITEBOARD_DEPTH / 2, spec.width + WHITEBOARD_RIM * 2, spec.height + WHITEBOARD_RIM * 2, WHITEBOARD_DEPTH, ALUMINIUM_COLOUR),
        );
        // The marker tray along the bottom edge.
        parts.push(box(0, spec.elevation - WHITEBOARD_RIM, 0.05, spec.width * 0.6, 0.025, 0.1, ALUMINIUM_COLOUR));
        const { w, h } = pixelsFor(spec.width, spec.height);
        const board = new THREE.MeshLambertMaterial({
          map: canvasTexture(w, h, maxAnisotropy, (ctx, cw, ch) => paintWhiteboard(ctx, cw, ch, hashOf(spec.id))),
        });
        addFace(piece, board, spec, centreY, WHITEBOARD_DEPTH + FACE_OFFSET);
        break;
      }
      case "clock": {
        const radius = spec.width / 2;
        const rim = new THREE.Mesh(rimGeometry, clockRim);
        rim.rotation.x = Math.PI / 2;
        rim.scale.set(spec.width + CLOCK_RIM * 2, CLOCK_DEPTH, spec.width + CLOCK_RIM * 2);
        rim.position.set(0, centreY, CLOCK_DEPTH / 2);
        piece.add(rim);
        const back = new THREE.Mesh(discGeometry, clockRim);
        back.scale.setScalar(spec.width + CLOCK_RIM * 2);
        back.position.set(0, centreY, FACE_OFFSET);
        piece.add(back);
        const face = new THREE.Mesh(discGeometry, clockFace);
        face.scale.setScalar(spec.width);
        face.position.set(0, centreY, CLOCK_DEPTH - 0.01);
        piece.add(face);
        const hour = new THREE.Mesh(handGeometry, handMaterial);
        hour.scale.set(radius * 0.09, radius * 0.5, 0.006);
        hour.position.set(0, centreY, CLOCK_DEPTH - 0.004);
        const minute = new THREE.Mesh(handGeometry, handMaterial);
        minute.scale.set(radius * 0.06, radius * 0.78, 0.006);
        minute.position.set(0, centreY, CLOCK_DEPTH - 0.002);
        piece.add(hour, minute);
        hands.push({ hour, minute });
        break;
      }
      case "shelf":
        parts.push(...shelfParts(spec));
        addTrophy(piece, spec, trophyMaterial);
        break;
    }

    root.add(piece);
    piece.updateMatrixWorld(true);
    for (const part of parts) {
      boxes.push(part);
      boxPieces.push(piece.matrixWorld.clone());
    }
  }

  if (boxes.length > 0) {
    const batch = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshLambertMaterial(), boxes.length);
    const local = new THREE.Matrix4();
    const colour = new THREE.Color();
    boxes.forEach((part, index) => {
      local.compose(part.centre, new THREE.Quaternion(), part.size);
      batch.setMatrixAt(index, (boxPieces[index] ?? new THREE.Matrix4()).clone().multiply(local));
      batch.setColorAt(index, colour.setHex(part.colour));
    });
    batch.instanceMatrix.needsUpdate = true;
    batch.computeBoundingSphere();
    batch.name = "wall-decor-boxes";
    root.add(batch);
  }

  scene.add(root);

  return {
    group: root,
    showMinute(minuteOfDay) {
      const angles = clockHandAngles(minuteOfDay);
      for (const clock of hands) {
        // Clockwise as seen from the front, which looks down the piece's -Z.
        clock.hour.rotation.z = -angles.hour;
        clock.minute.rotation.z = -angles.minute;
      }
    },
    paintTv(paint) {
      for (const texture of tvTextures) {
        const canvas = texture.image as HTMLCanvasElement;
        const context = canvas.getContext("2d");
        if (context !== null) {
          paint(context, canvas.width, canvas.height);
          texture.needsUpdate = true;
        }
      }
    },
  };
}

/**
 * A group on the wall face, turned so its own +Z points out into the room.
 *
 * Layout yaw 0 faces -Z, and a Three.js object faces its own +Z, so a half
 * turn more points the piece where the layout says it looks.
 */
function pieceAt(placement: WallDecorPlacement): THREE.Group {
  const piece = new THREE.Group();
  piece.position.set(placement.x, 0, placement.z);
  piece.rotation.y = placement.yaw + Math.PI;
  return piece;
}

function box(x: number, y: number, z: number, width: number, height: number, depth: number, colour: number): BoxPart {
  return { centre: new THREE.Vector3(x, y, z), size: new THREE.Vector3(width, height, depth), colour };
}

/**
 * A floating shelf and the books on it: a run of spines leaning on each
 * other from the left end, the trophy standing on the right.
 */
function shelfParts(spec: WallDecorSpec): BoxPart[] {
  const parts = [box(0, spec.elevation - SHELF_THICKNESS / 2, SHELF_DEPTH / 2, spec.width, SHELF_THICKNESS, SHELF_DEPTH, SHELF_COLOUR)];
  let x = -spec.width / 2 + 0.06;
  const end = spec.width * 0.15;
  let index = 0;
  while (x < end) {
    const thickness = 0.035 + ((index * 7) % 4) * 0.008;
    const tall = spec.height * (0.62 + ((index * 5) % 5) * 0.08);
    const colour = BOOK_COLOURS[(index * 3) % BOOK_COLOURS.length] ?? BOOK_COLOURS[0];
    parts.push(box(x + thickness / 2, spec.elevation + tall / 2, SHELF_DEPTH * 0.45, thickness, tall, SHELF_DEPTH * 0.75, colour));
    x += thickness + 0.004;
    index += 1;
    // A gap halfway, where a couple have been borrowed.
    if (index === 9) {
      x += 0.12;
    }
  }
  return parts;
}

/** A gold cup on a dark plinth, at the shelf's right-hand end. */
function addTrophy(piece: THREE.Object3D, spec: WallDecorSpec, material: THREE.Material): void {
  const x = spec.width / 2 - 0.22;
  const z = SHELF_DEPTH * 0.5;
  const plinth = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.05, 0.12), new THREE.MeshLambertMaterial({ color: 0x1f1f22 }));
  plinth.position.set(x, spec.elevation + 0.025, z);
  const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.02, 0.12, 12), material);
  stem.position.set(x, spec.elevation + 0.11, z);
  const cup = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.025, 0.13, 20), material);
  cup.position.set(x, spec.elevation + 0.235, z);
  piece.add(plinth, stem, cup);
}
