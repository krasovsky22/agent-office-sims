/**
 * An occupant's body: a capsule, a floating nameplate, a CEO marker, and
 * whatever the occupant is currently expressing.
 *
 * The nameplate is a sprite, so it faces the camera from every angle without the
 * game loop having to orient it. Its text is drawn once into a canvas when the
 * avatar is built or renamed, not per frame.
 *
 * **Everything overhead hangs off one anchor.** `overhead` is a group at head
 * height, and the nameplate, the emote sprite and the chat bubble are its
 * children at fixed local offsets. Two things follow from that. Overhead
 * content tracks the body for free — the game loop moves the avatar's group and
 * the anchor comes with it, with no second position to keep in step. And when
 * the capsule is replaced by a rigged mesh, re-parenting this one group to a
 * head bone moves all of it; nothing outside this class holds a position.
 *
 * Expression is the same for every occupant, so an agent employee gets emotes
 * and chat bubbles by being given an {@link Avatar}, with no extra work here.
 */

import {
  CHAT_BUBBLE_LIFETIME_MS,
  EMOTE_LIFETIME_MS,
  type Emote,
  OCCUPANT_HEIGHT,
  OCCUPANT_RADIUS,
} from "@sim/shared";
import * as THREE from "three";

import { EMOTE_APPEARANCE } from "../emotes.js";

import { Billboard, paintEmote, paintSpeechBubble } from "./billboard.js";

/** Height of the overhead anchor above the floor. */
const OVERHEAD_Y = OCCUPANT_HEIGHT;

/** Nameplate offset above {@link OVERHEAD_Y}. */
const NAMEPLATE_OFFSET = 0.42;

/**
 * Offsets of the expression sprites above {@link OVERHEAD_Y}.
 *
 * Stacked so that an occupant waving mid-sentence shows both: the emote clears
 * the nameplate, and the bubble clears the emote. The bubble is painted
 * bottom-anchored inside its own canvas, so it grows upward with its line count
 * rather than down into the emote.
 */
const EMOTE_OFFSET = 0.85;
const CHAT_OFFSET = 1.42;

const EMOTE_CANVAS_WIDTH = 256;
const EMOTE_CANVAS_HEIGHT = 224;
const EMOTE_WORLD_HEIGHT = 0.46;

const CHAT_CANVAS_WIDTH = 512;
const CHAT_CANVAS_HEIGHT = 224;
const CHAT_WORLD_HEIGHT = 0.62;

/** World height of a nameplate sprite. */
const NAMEPLATE_HEIGHT = 0.3;

/**
 * Nameplate canvas size, in pixels.
 *
 * Fixed, not fitted to the text: a canvas that changes size after its texture
 * has been uploaded makes the next upload a partial write against the old
 * dimensions, which WebGL rejects. The pill is drawn centred inside it and the
 * surrounding margin stays transparent. Wide enough for the longest name the
 * server will accept plus the CEO suffix.
 */
const NAMEPLATE_CANVAS_WIDTH = 640;
const NAMEPLATE_CANVAS_HEIGHT = 64;

const CEO_MARKER_Y = OCCUPANT_HEIGHT + 0.13;

/** Expiry sentinel for "not showing anything". */
const NOT_SHOWING = Number.NEGATIVE_INFINITY;

const LOCAL_BODY_COLOUR = 0xcfd3da;
const REMOTE_BODY_COLOUR = 0x9aa0aa;
const FACING_COLOUR = 0x5e6470;
const CEO_MARKER_COLOUR = 0xf0c650;

/**
 * Shared geometry. A capsule's `length` is the cylindrical section only, so the
 * total standing height is `length + 2 * radius`.
 */
const BODY_GEOMETRY = new THREE.CapsuleGeometry(
  OCCUPANT_RADIUS,
  OCCUPANT_HEIGHT - OCCUPANT_RADIUS * 2,
  4,
  12,
);
const FACING_GEOMETRY = new THREE.BoxGeometry(0.14, 0.14, 0.1);
const CEO_MARKER_GEOMETRY = new THREE.ConeGeometry(0.16, 0.26, 10);

const FACING_MATERIAL = new THREE.MeshLambertMaterial({ color: FACING_COLOUR });
const CEO_MARKER_MATERIAL = new THREE.MeshLambertMaterial({ color: CEO_MARKER_COLOUR });

export interface AvatarOptions {
  readonly name: string;
  readonly isCeo: boolean;
  /** The local player's body is lighter, so you can pick yourself out. */
  readonly isLocal: boolean;
}

function drawNameplate(canvas: HTMLCanvasElement, name: string, isCeo: boolean): void {
  const label = isCeo ? `${name}  ·  CEO` : name;
  const context = canvas.getContext("2d");
  if (context === null) {
    return;
  }

  context.clearRect(0, 0, canvas.width, canvas.height);
  context.font = `600 ${Math.round(NAMEPLATE_CANVAS_HEIGHT * 0.52)}px ui-sans-serif, system-ui, sans-serif`;
  context.textAlign = "center";
  context.textBaseline = "middle";

  const padding = NAMEPLATE_CANVAS_HEIGHT * 0.38;
  const pillWidth = Math.min(
    canvas.width,
    Math.ceil(context.measureText(label).width + padding * 2),
  );
  const centreX = canvas.width / 2;
  const centreY = canvas.height / 2;

  context.fillStyle = "rgba(20, 20, 24, 0.72)";
  context.beginPath();
  context.roundRect(centreX - pillWidth / 2, 0, pillWidth, canvas.height, canvas.height / 2);
  context.fill();

  context.fillStyle = isCeo ? "#f3cf6a" : "#eef0f4";
  context.fillText(label, centreX, centreY + 1);
}

export class Avatar {
  public readonly group = new THREE.Group();

  /**
   * Where overhead content hangs. See the note at the top of this file: this is
   * the single thing a rigged avatar re-parents.
   */
  private readonly overhead = new THREE.Group();

  private readonly body: THREE.Mesh;
  private readonly bodyMaterial: THREE.MeshLambertMaterial;
  private readonly ceoMarker: THREE.Mesh;
  private readonly nameplate: THREE.Sprite;
  private readonly nameplateCanvas = document.createElement("canvas");
  private readonly nameplateTexture: THREE.CanvasTexture;

  private readonly emoteBillboard = new Billboard({
    canvasWidth: EMOTE_CANVAS_WIDTH,
    canvasHeight: EMOTE_CANVAS_HEIGHT,
    worldHeight: EMOTE_WORLD_HEIGHT,
  });

  private readonly chatBillboard = new Billboard({
    canvasWidth: CHAT_CANVAS_WIDTH,
    canvasHeight: CHAT_CANVAS_HEIGHT,
    worldHeight: CHAT_WORLD_HEIGHT,
  });

  private emoteExpiresAt = NOT_SHOWING;
  private chatExpiresAt = NOT_SHOWING;

  private name: string;
  private isCeo: boolean;

  public constructor(options: AvatarOptions) {
    this.name = options.name;
    this.isCeo = options.isCeo;

    this.overhead.position.y = OVERHEAD_Y;
    this.group.add(this.overhead);

    this.emoteBillboard.sprite.position.y = EMOTE_OFFSET;
    this.overhead.add(this.emoteBillboard.sprite);
    this.chatBillboard.sprite.position.y = CHAT_OFFSET;
    this.overhead.add(this.chatBillboard.sprite);

    this.bodyMaterial = new THREE.MeshLambertMaterial({
      color: options.isLocal ? LOCAL_BODY_COLOUR : REMOTE_BODY_COLOUR,
    });
    this.body = new THREE.Mesh(BODY_GEOMETRY, this.bodyMaterial);
    this.body.position.y = OCCUPANT_HEIGHT / 2;
    this.group.add(this.body);

    // A nub on the front, so which way an avatar faces is readable at a glance.
    const facing = new THREE.Mesh(FACING_GEOMETRY, FACING_MATERIAL);
    facing.position.set(0, OCCUPANT_HEIGHT * 0.72, -OCCUPANT_RADIUS);
    this.group.add(facing);

    this.ceoMarker = new THREE.Mesh(CEO_MARKER_GEOMETRY, CEO_MARKER_MATERIAL);
    this.ceoMarker.position.y = CEO_MARKER_Y;
    this.ceoMarker.visible = options.isCeo;
    this.group.add(this.ceoMarker);

    this.nameplateCanvas.width = NAMEPLATE_CANVAS_WIDTH;
    this.nameplateCanvas.height = NAMEPLATE_CANVAS_HEIGHT;
    drawNameplate(this.nameplateCanvas, this.name, this.isCeo);
    this.nameplateTexture = new THREE.CanvasTexture(this.nameplateCanvas);
    this.nameplateTexture.colorSpace = THREE.SRGBColorSpace;
    this.nameplate = new THREE.Sprite(
      new THREE.SpriteMaterial({ map: this.nameplateTexture, transparent: true, depthTest: false }),
    );
    this.nameplate.position.y = NAMEPLATE_OFFSET;
    this.applyNameplateScale();
    this.overhead.add(this.nameplate);
  }

  public setPose(x: number, z: number, yaw: number): void {
    this.group.position.set(x, 0, z);
    this.group.rotation.y = yaw;
  }

  /** Shows an emote above the head, replacing any emote still showing. */
  public showEmote(emote: Emote, nowMs: number): void {
    const appearance = EMOTE_APPEARANCE[emote];
    this.emoteBillboard.show(paintEmote(appearance.glyph, appearance.caption));
    this.emoteExpiresAt = nowMs + EMOTE_LIFETIME_MS;
  }

  /**
   * Shows a chat bubble above the head, replacing any bubble still showing.
   *
   * `text` has already been sanitized and length-capped by the server, and is
   * painted as characters onto a canvas, so there is no markup context here for
   * it to escape into.
   */
  public showChat(text: string, nowMs: number): void {
    this.chatBillboard.show(paintSpeechBubble(text));
    this.chatExpiresAt = nowMs + CHAT_BUBBLE_LIFETIME_MS;
  }

  /**
   * Retires anything whose time is up.
   *
   * Called every frame from the game loop with the frame's timestamp, which is
   * the same clock the lifetimes were stamped against. Expiry is deliberately
   * not a `setTimeout` per emote: a timer that fires while the tab is
   * backgrounded, or after the avatar has been disposed, is a bug waiting to
   * be written, and the loop is already running.
   */
  public updateExpressions(nowMs: number): void {
    if (this.emoteBillboard.visible && nowMs >= this.emoteExpiresAt) {
      this.emoteBillboard.hide();
      this.emoteExpiresAt = NOT_SHOWING;
    }
    if (this.chatBillboard.visible && nowMs >= this.chatExpiresAt) {
      this.chatBillboard.hide();
      this.chatExpiresAt = NOT_SHOWING;
    }
  }

  /** Re-renders the nameplate only when something it shows has changed. */
  public setLabel(name: string, isCeo: boolean): void {
    if (name === this.name && isCeo === this.isCeo) {
      return;
    }
    this.name = name;
    this.isCeo = isCeo;
    this.ceoMarker.visible = isCeo;
    drawNameplate(this.nameplateCanvas, name, isCeo);
    this.nameplateTexture.needsUpdate = true;
  }

  public dispose(): void {
    this.group.removeFromParent();
    this.bodyMaterial.dispose();
    this.nameplate.material.dispose();
    this.nameplateTexture.dispose();
    this.emoteBillboard.dispose();
    this.chatBillboard.dispose();
  }

  private applyNameplateScale(): void {
    const aspect = NAMEPLATE_CANVAS_WIDTH / NAMEPLATE_CANVAS_HEIGHT;
    this.nameplate.scale.set(NAMEPLATE_HEIGHT * aspect, NAMEPLATE_HEIGHT, 1);
  }
}
