/**
 * The bodies' colours and texture: a kind is told by its shirt, a name by the
 * rest, and every face of every box has its own opaque pixels to show.
 */

import { describe, expect, it } from "vitest";

import {
  type AvatarLook,
  type BoxFace,
  CONCIERGE_SHIRT,
  LIVE_AGENT_SHIRT,
  MANAGER_SHIRT,
  NET,
  PLAYER_SHIRTS,
  SKIN_HEIGHT,
  SKIN_WIDTH,
  avatarPalette,
  faceRect,
  paintSkin,
} from "./avatarSkin.js";

const NAMES = Array.from({ length: 60 }, (_unused, index) => `Player ${index}`);
const FACES: readonly BoxFace[] = ["right", "left", "top", "bottom", "front", "back"];
const ROLE_SHIRTS = [LIVE_AGENT_SHIRT, MANAGER_SHIRT, CONCIERGE_SHIRT];

describe("avatarPalette", () => {
  it("gives a name the same colours every time", () => {
    expect(avatarPalette("remote", "Ada")).toEqual(avatarPalette("remote", "Ada"));
  });

  it("dresses each kind of agent in its own shirt and a tie", () => {
    const shirts: Partial<Record<AvatarLook, number>> = {
      liveAgent: LIVE_AGENT_SHIRT,
      manager: MANAGER_SHIRT,
      concierge: CONCIERGE_SHIRT,
    };
    for (const [look, shirt] of Object.entries(shirts)) {
      for (const name of NAMES) {
        const palette = avatarPalette(look as AvatarLook, name);
        expect(palette.shirt).toBe(shirt);
        expect(palette.tie).toBeDefined();
      }
    }
  });

  it("never dresses a player in an agent's colours", () => {
    for (const look of ["local", "remote"] as const) {
      for (const name of NAMES) {
        const palette = avatarPalette(look, name);
        expect(ROLE_SHIRTS).not.toContain(palette.shirt);
        expect(PLAYER_SHIRTS).toContain(palette.shirt);
        expect(palette.tie).toBeUndefined();
      }
    }
  });

  it("looks the same for the local player as for everyone else seeing them", () => {
    expect(avatarPalette("local", "Ada")).toEqual(avatarPalette("remote", "Ada"));
  });

  it("tells most players apart by their colours", () => {
    const looks = new Set(NAMES.map((name) => JSON.stringify(avatarPalette("remote", name))));
    expect(looks.size).toBeGreaterThan(NAMES.length * 0.9);
  });

  it("varies agents of the same kind by their hair and skin", () => {
    const looks = new Set(NAMES.map((name) => JSON.stringify(avatarPalette("liveAgent", name))));
    expect(looks.size).toBeGreaterThan(NAMES.length / 2);
  });
});

describe("paintSkin", () => {
  it("paints every face of every part opaque, with no two faces sharing a pixel", () => {
    const pixels = new Uint8Array(SKIN_WIDTH * SKIN_HEIGHT * 4);
    paintSkin(avatarPalette("remote", "Ada"), pixels);
    const claimed = new Set<number>();
    let area = 0;
    for (const net of Object.values(NET)) {
      for (const face of FACES) {
        const rect = faceRect(net, face);
        expect(rect.x + rect.w).toBeLessThanOrEqual(SKIN_WIDTH);
        expect(rect.y + rect.h).toBeLessThanOrEqual(SKIN_HEIGHT);
        area += rect.w * rect.h;
        for (let y = rect.y; y < rect.y + rect.h; y += 1) {
          for (let x = rect.x; x < rect.x + rect.w; x += 1) {
            claimed.add(y * SKIN_WIDTH + x);
            expect(pixels[(y * SKIN_WIDTH + x) * 4 + 3], `${face} at ${x},${y}`).toBe(255);
          }
        }
      }
    }
    expect(claimed.size).toBe(area);
  });

  it("paints the shirt on the chest, near enough its own colour", () => {
    const palette = avatarPalette("liveAgent", "Maya");
    const pixels = new Uint8Array(SKIN_WIDTH * SKIN_HEIGHT * 4);
    paintSkin(palette, pixels);
    const chest = faceRect(NET.torso, "front");
    const offset = ((chest.y + 6) * SKIN_WIDTH + chest.x + 1) * 4;
    const red = (palette.shirt >> 16) & 0xff;
    expect(Math.abs((pixels[offset] ?? 0) - red)).toBeLessThanOrEqual(red * 0.1);
  });
});
