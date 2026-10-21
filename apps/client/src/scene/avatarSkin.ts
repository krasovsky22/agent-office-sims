/**
 * What an occupant's blocky body looks like: the colours it wears, chosen from
 * who it is, and the small pixel-art texture they are painted into.
 *
 * Two rules decide the colours. A body's kind is legible at a glance: every
 * live coding agent wears a violet shirt and tie, the AI manager a crimson one
 * and the concierge a teal one, and no player's shirt is any of those. Within a
 * kind, the skin, hair, eyes and clothes are picked from a hash of the
 * occupant's name, so two players are told apart from across the office and
 * the same name always looks the same, in every tab and on every visit.
 *
 * The texture is painted into a plain byte array rather than a canvas, so it is
 * the same pixels wherever it runs, tests included, and costs no DOM.
 */

/** Which coat of paint a body is stamped out with. */
export type AvatarLook = "local" | "remote" | "liveAgent" | "manager" | "concierge";

/** The texture's size in pixels; every part of the body is unwrapped into it. */
export const SKIN_WIDTH = 64;
export const SKIN_HEIGHT = 32;

/**
 * Where a box part is unwrapped in the texture: a cross of its six faces with
 * the top and bottom over the front and one side, in pixels from the
 * texture's top-left. `w`, `h` and `d` are the box's width, height and depth.
 */
export interface BoxNet {
  readonly u: number;
  readonly v: number;
  readonly w: number;
  readonly h: number;
  readonly d: number;
}

/** A face of a box part, as the body wearing it would name it; the body faces -Z. */
export type BoxFace = "right" | "left" | "top" | "bottom" | "front" | "back";

export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

/** The body's parts' nets. Arms and legs share one net per segment, left and right alike. */
export const NET = {
  head: { u: 0, v: 0, w: 8, h: 8, d: 8 },
  torso: { u: 32, v: 0, w: 8, h: 12, d: 4 },
  upperArm: { u: 0, v: 16, w: 3, h: 6, d: 4 },
  lowerArm: { u: 14, v: 16, w: 3, h: 6, d: 4 },
  upperLeg: { u: 28, v: 16, w: 4, h: 6, d: 4 },
  lowerLeg: { u: 44, v: 16, w: 4, h: 6, d: 4 },
} as const satisfies Record<string, BoxNet>;

/** Where one face of a part sits in the texture. */
export function faceRect(net: BoxNet, face: BoxFace): Rect {
  const { u, v, w, h, d } = net;
  switch (face) {
    case "top":
      return { x: u + d, y: v, w, h: d };
    case "bottom":
      return { x: u + d + w, y: v, w, h: d };
    case "right":
      return { x: u, y: v + d, w: d, h };
    case "front":
      return { x: u + d, y: v + d, w, h };
    case "left":
      return { x: u + d + w, y: v + d, w: d, h };
    case "back":
      return { x: u + d * 2 + w, y: v + d, w, h };
  }
}

export type HairStyle = "short" | "long" | "fringe" | "buzz";

/** Every colour a body wears, as `0xRRGGBB`. */
export interface AvatarPalette {
  readonly skin: number;
  readonly hair: number;
  readonly hairStyle: HairStyle;
  readonly eyes: number;
  readonly shirt: number;
  readonly trousers: number;
  readonly shoes: number;
  /** An agent's tie, in a darker shade of its shirt; `undefined` on a player, who wears an open collar. */
  readonly tie: number | undefined;
}

/** The kinds' shirts: violet for live agents, crimson for the manager, teal for the concierge. */
export const LIVE_AGENT_SHIRT = 0x8a6cf0;
export const MANAGER_SHIRT = 0xcf3d4f;
export const CONCIERGE_SHIRT = 0x1f9e8f;

const ROLE_SHIRT: Partial<Record<AvatarLook, number>> = {
  liveAgent: LIVE_AGENT_SHIRT,
  manager: MANAGER_SHIRT,
  concierge: CONCIERGE_SHIRT,
};

const SKIN_TONES = [0xf3cfa6, 0xe8b88a, 0xd09a6c, 0xae7548, 0x8a5634, 0x5f3a22];
const HAIR_COLOURS = [0x231811, 0x14110f, 0x5a3b1e, 0x8a5a2b, 0xc9a35b, 0x9b3d1c, 0x8c8c8c];
const HAIR_STYLES: readonly HairStyle[] = ["short", "long", "fringe", "buzz"];
const EYE_COLOURS = [0x2b4f9a, 0x4a2e1a, 0x2f6b3a, 0x1d1d1d];
/** Players' shirts: bright, and clear of all three kinds' colours. */
export const PLAYER_SHIRTS = [0x3d7fd9, 0x4cc3f0, 0x46a85a, 0xe58c2f, 0xe3c443, 0xe06c9f, 0xe9e9e4, 0x6f7785];
const PLAYER_TROUSERS = [0x3b3f8f, 0x2c3a5e, 0x47474d, 0x5b4632, 0x35577a];
const PLAYER_SHOES = [0x5d5d63, 0x2b2b2e, 0x6b4a2f, 0xe8e8e8];
const AGENT_TROUSERS = 0x2a2d36;
const AGENT_SHOES = 0x1b1b1e;

/** The tie: the shirt's colour at this brightness. */
const TIE_SHADE = 0.55;

/** FNV-1a, 32-bit: a stable, well-spread hash of a name. */
export function hashIdentity(identity: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < identity.length; index += 1) {
    hash ^= identity.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** The colours a body wears: its kind's shirt, or a player's own, and the rest from its name. */
export function avatarPalette(look: AvatarLook, identity: string): AvatarPalette {
  let state = hashIdentity(identity);
  // Each draw takes the next value of a small xorshift, so the picks are independent of each other.
  const pick = <T>(choices: readonly T[]): T => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return choices[state % choices.length] as T;
  };

  const skin = pick(SKIN_TONES);
  const hair = pick(HAIR_COLOURS);
  const hairStyle = pick(HAIR_STYLES);
  const eyes = pick(EYE_COLOURS);
  const role = ROLE_SHIRT[look];
  if (role !== undefined) {
    return { skin, hair, hairStyle, eyes, shirt: role, trousers: AGENT_TROUSERS, shoes: AGENT_SHOES, tie: shade(role, TIE_SHADE) };
  }
  return {
    skin,
    hair,
    hairStyle,
    eyes,
    shirt: pick(PLAYER_SHIRTS),
    trousers: pick(PLAYER_TROUSERS),
    shoes: pick(PLAYER_SHOES),
    tie: undefined,
  };
}

/** A colour at `factor` of its brightness. */
function shade(colour: number, factor: number): number {
  const channel = (shift: number) => Math.min(255, Math.round(((colour >> shift) & 0xff) * factor));
  return (channel(16) << 16) | (channel(8) << 8) | channel(0);
}

/**
 * How much a pixel's brightness wanders from its colour, so a flat face of
 * the box reads as a pixel-art texture rather than a plastic one.
 */
const GRAIN = 0.08;

/** A fixed brightness offset per pixel in [0, 1), the same on every body. */
function grain(x: number, y: number): number {
  let n = Math.imul(x, 374761393) ^ Math.imul(y, 668265263);
  n = Math.imul(n ^ (n >>> 13), 1274126177);
  return ((n ^ (n >>> 16)) >>> 0) / 0x100000000;
}

/**
 * Paints a body's texture into `data`: `SKIN_WIDTH` by `SKIN_HEIGHT` RGBA
 * bytes, row 0 at the top of the texture.
 */
export function paintSkin(palette: AvatarPalette, data: Uint8Array): void {
  const put = (x: number, y: number, colour: number, light = 1) => {
    const offset = (y * SKIN_WIDTH + x) * 4;
    const factor = light * (1 - GRAIN + GRAIN * 2 * grain(x, y));
    data[offset] = Math.min(255, Math.round(((colour >> 16) & 0xff) * factor));
    data[offset + 1] = Math.min(255, Math.round(((colour >> 8) & 0xff) * factor));
    data[offset + 2] = Math.min(255, Math.round((colour & 0xff) * factor));
    data[offset + 3] = 255;
  };
  const fill = (rect: Rect, colour: number, light = 1) => {
    for (let y = rect.y; y < rect.y + rect.h; y += 1) {
      for (let x = rect.x; x < rect.x + rect.w; x += 1) {
        put(x, y, colour, light);
      }
    }
  };
  /** Paints rows `from` to `to` of a face, counted from its top. */
  const rows = (rect: Rect, from: number, to: number, colour: number) =>
    fill({ x: rect.x, y: rect.y + from, w: rect.w, h: Math.min(to, rect.h - 1) - from + 1 }, colour);
  const sides: readonly BoxFace[] = ["right", "front", "left", "back"];

  data.fill(0);
  paintHead(palette, put, fill, rows);

  // The torso: the shirt, a belt in the trousers' colour, and at the neck an
  // agent's collar and tie or a player's open collar.
  for (const face of sides) {
    const rect = faceRect(NET.torso, face);
    fill(rect, palette.shirt);
    rows(rect, rect.h - 1, rect.h - 1, palette.trousers);
  }
  fill(faceRect(NET.torso, "top"), palette.shirt);
  fill(faceRect(NET.torso, "bottom"), palette.trousers);
  const chest = faceRect(NET.torso, "front");
  if (palette.tie === undefined) {
    put(chest.x + 3, chest.y, palette.skin);
    put(chest.x + 4, chest.y, palette.skin);
    put(chest.x + 3, chest.y + 1, palette.skin, 0.85);
    put(chest.x + 4, chest.y + 1, palette.skin, 0.85);
  } else {
    put(chest.x + 2, chest.y, 0xf2f2f2);
    put(chest.x + 5, chest.y, 0xf2f2f2);
    for (let y = 0; y < 8; y += 1) {
      put(chest.x + 3, chest.y + y, palette.tie);
      put(chest.x + 4, chest.y + y, palette.tie);
    }
    // A name badge clipped to the pocket, so an agent reads as staff up close too.
    put(chest.x + 6, chest.y + 3, 0xf2f2f2);
  }

  // Arms: sleeves to the elbow, bare forearms and hands below it.
  for (const face of [...sides, "top", "bottom"] as const) {
    fill(faceRect(NET.upperArm, face), palette.shirt);
    fill(faceRect(NET.lowerArm, face), palette.skin);
  }

  // Legs: trousers down to the shoes.
  for (const face of [...sides, "top"] as const) {
    fill(faceRect(NET.upperLeg, face), palette.trousers);
    fill(faceRect(NET.lowerLeg, face), palette.trousers);
  }
  fill(faceRect(NET.upperLeg, "bottom"), palette.trousers);
  for (const face of sides) {
    const rect = faceRect(NET.lowerLeg, face);
    rows(rect, rect.h - 2, rect.h - 1, palette.shoes);
  }
  fill(faceRect(NET.lowerLeg, "bottom"), palette.shoes);
}

type Put = (x: number, y: number, colour: number, light?: number) => void;
type Fill = (rect: Rect, colour: number, light?: number) => void;
type Rows = (rect: Rect, from: number, to: number, colour: number) => void;

/** The head: skin, hair in its style, and a face with brows, eyes, a nose and a mouth. */
function paintHead(palette: AvatarPalette, put: Put, fill: Fill, rows: Rows): void {
  const { hair, hairStyle, skin } = palette;
  const face = faceRect(NET.head, "front");
  for (const side of ["right", "front", "left", "back", "bottom"] as const) {
    fill(faceRect(NET.head, side), skin);
  }
  fill(faceRect(NET.head, "top"), hair);

  // How far down the hair comes on the sides and the back, by style.
  const sideDepth = { short: 2, long: 6, fringe: 2, buzz: 0 }[hairStyle];
  const backDepth = { short: 5, long: 7, fringe: 5, buzz: 1 }[hairStyle];
  rows(faceRect(NET.head, "right"), 0, sideDepth, hair);
  rows(faceRect(NET.head, "left"), 0, sideDepth, hair);
  rows(faceRect(NET.head, "back"), 0, backDepth, hair);

  rows(face, 0, hairStyle === "buzz" ? 0 : 1, hair);
  if (hairStyle === "fringe") {
    for (let x = 0; x < 5; x += 1) {
      put(face.x + x, face.y + 2, hair);
    }
  }
  if (hairStyle === "long") {
    for (let y = 2; y < 7; y += 1) {
      put(face.x, face.y + y, hair);
      put(face.x + 7, face.y + y, hair);
    }
  }

  // Brows in the hair's colour over each eye; the eye a white with its iris on the inner side.
  for (const [white, iris] of [
    [1, 2],
    [6, 5],
  ] as const) {
    put(face.x + white, face.y + 3, hair, 0.9);
    put(face.x + iris, face.y + 3, hair, 0.9);
    put(face.x + white, face.y + 4, 0xf4f4f4);
    put(face.x + iris, face.y + 4, palette.eyes);
  }
  put(face.x + 3, face.y + 5, skin, 0.86);
  put(face.x + 4, face.y + 5, skin, 0.86);
  for (let x = 3; x < 5; x += 1) {
    put(face.x + x, face.y + 6, 0x7a3a2c);
  }
  put(face.x + 2, face.y + 6, skin, 0.75);
  put(face.x + 5, face.y + 6, skin, 0.75);
}
