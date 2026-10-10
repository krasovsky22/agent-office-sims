/**
 * An occupant's body: a rigged humanoid, a floating nameplate, a CEO marker,
 * and whatever the occupant is currently expressing.
 *
 * Three things about the shape of this file are load-bearing:
 *
 * - **The capsule is still here, as the fallback.** An avatar built without a
 *   model yet stands as a capsule until {@link Avatar.useModel} upgrades it. A
 *   model that never arrives therefore leaves a body you can see and walk,
 *   rather than an invisible player.
 * - **Head-height attachments hang off {@link Avatar.headAnchor}.** The
 *   nameplate, the CEO marker, the emote sprite and the chat bubble are all
 *   children of it. It is a plain object whose height follows the pose, so
 *   nothing outside this file has to know whether the body underneath is a
 *   capsule, a standing humanoid or a seated one.
 * - **Speed is derived here, from the pose.** The walk cycle has to be played at
 *   the speed the body is moving, and that is the same measurement for the local
 *   player and for an interpolated remote one. Taking it from the rendered
 *   position means neither the controller nor the network layer has to report it.
 *
 * The nameplate is a sprite, so it faces the camera from every angle without the
 * game loop having to orient it. Its text is drawn once into a canvas when the
 * avatar is built or renamed, not per frame.
 *
 * Expression is the same for every occupant, so an agent employee gets emotes
 * and chat bubbles by being given an {@link Avatar}, with no extra work here.
 */

import {
  ANIMATION_STATE,
  type AnimationState,
  CHAT_BUBBLE_LIFETIME_MS,
  type Emote,
  EMOTE_LIFETIME_MS,
  OCCUPANT_HEIGHT,
  OCCUPANT_RADIUS,
  SPEED_TOLERANCE,
  WALK_SPEED,
} from "@sim/shared";
import * as THREE from "three";

import { EMOTE_APPEARANCE } from "../emotes.js";

import { AvatarAnimator } from "./avatarAnimator.js";
import type { AvatarModel } from "./avatarModel.js";
import { Billboard, paintEmote, paintSpeechBubble } from "./billboard.js";

/**
 * Offsets of the expression sprites above the head anchor.
 *
 * Stacked so that an occupant waving mid-sentence shows both: the emote clears
 * the nameplate, and the bubble clears the emote. The bubble is painted
 * bottom-anchored inside its own canvas, so it grows upward with its line count
 * rather than down into the emote.
 */
const EMOTE_OFFSET_Y = 0.85;
const CHAT_OFFSET_Y = 1.42;

const EMOTE_CANVAS_WIDTH = 256;
const EMOTE_CANVAS_HEIGHT = 224;
const EMOTE_WORLD_HEIGHT = 0.46;

const CHAT_CANVAS_WIDTH = 512;
const CHAT_CANVAS_HEIGHT = 224;
const CHAT_WORLD_HEIGHT = 0.62;

/**
 * Height of the attachment point everything above the head hangs from: the
 * crown of a standing occupant.
 */
const HEAD_ANCHOR_Y = OCCUPANT_HEIGHT;

/**
 * How far the head drops when seated, measured off the model's seated pose.
 *
 * The anchor follows it so a nameplate still sits above the head of someone at a
 * desk instead of floating where they used to be standing.
 */
const SEATED_HEAD_DROP = 0.18;

/** Fraction of the remaining gap the head anchor closes per second. */
const HEAD_ANCHOR_EASE_RATE = 8;

/** Nameplate height above the head anchor. */
const NAMEPLATE_OFFSET_Y = 0.42;

/** CEO marker height above the head anchor. */
const CEO_MARKER_OFFSET_Y = 0.13;

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

/** Expiry sentinel for "not showing anything". */
const NOT_SHOWING = Number.NEGATIVE_INFINITY;

const LOCAL_BODY_COLOUR = 0xcfd3da;
const REMOTE_BODY_COLOUR = 0x9aa0aa;
const FACING_COLOUR = 0x5e6470;
const CEO_MARKER_COLOUR = 0xf0c650;

/** Fraction of the gap the smoothed speed closes per second. */
const SPEED_EASE_RATE = 12;

/**
 * Fastest speed the walk scaling will believe.
 *
 * A reconciliation snap or a spawn moves the body further in one frame than any
 * walk could, and an unclamped sample would spin the walk cycle for the moment
 * it takes to decay.
 */
const MAX_TRACKED_SPEED = WALK_SPEED * SPEED_TOLERANCE;

/**
 * Shared capsule geometry. A capsule's `length` is the cylindrical section only,
 * so the total standing height is `length + 2 * radius`.
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
  /**
   * The humanoid model, or `undefined` while it is still downloading or if it
   * failed to. An avatar built without one stands as a capsule until
   * {@link Avatar.useModel} is called.
   */
  readonly model: AvatarModel | undefined;
}

/** A body, however it happens to be drawn. */
interface AvatarBody {
  readonly root: THREE.Object3D;
  /** Absent on the capsule, which has no clips to play. */
  readonly animator: AvatarAnimator | undefined;
  readonly isHumanoid: boolean;
  dispose: () => void;
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

/** The humanoid body, built once a model is available. */
function createHumanoidBody(
  model: AvatarModel,
  isLocal: boolean,
  initialAnimation: AnimationState,
): AvatarBody {
  const instance = model.createInstance(isLocal);
  const animator = new AvatarAnimator(instance.root, instance.clips);
  animator.setState(initialAnimation);

  return {
    root: instance.root,
    animator,
    isHumanoid: true,
    dispose: () => {
      animator.dispose();
      instance.dispose();
    },
  };
}

/** The capsule: the body an avatar has before the model arrives, or instead of it. */
function createCapsuleBody(isLocal: boolean): AvatarBody {
  const root = new THREE.Group();
  root.name = "avatar-capsule";

  const material = new THREE.MeshLambertMaterial({
    color: isLocal ? LOCAL_BODY_COLOUR : REMOTE_BODY_COLOUR,
  });
  const capsule = new THREE.Mesh(BODY_GEOMETRY, material);
  capsule.position.y = OCCUPANT_HEIGHT / 2;
  root.add(capsule);

  // A nub on the front, so which way an avatar faces is readable at a glance.
  const facing = new THREE.Mesh(FACING_GEOMETRY, FACING_MATERIAL);
  facing.position.set(0, OCCUPANT_HEIGHT * 0.72, -OCCUPANT_RADIUS);
  root.add(facing);

  return {
    root,
    animator: undefined,
    isHumanoid: false,
    dispose: () => {
      root.removeFromParent();
      material.dispose();
    },
  };
}

export class Avatar {
  public readonly group = new THREE.Group();

  /**
   * Where everything that belongs above an occupant's head attaches.
   *
   * Nameplate, CEO marker, emote sprite and chat bubble are all children of
   * it. Its height tracks the pose, so a child at a fixed local offset keeps
   * sitting above the head, and when the capsule is replaced by a rigged
   * mesh, re-parenting this one group to a head bone moves all of it.
   */
  public readonly headAnchor = new THREE.Object3D();

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

  private body: AvatarBody;
  private readonly isLocal: boolean;

  private name: string;
  private isCeo: boolean;
  private animation: AnimationState = ANIMATION_STATE.idle;

  private speed = 0;
  private previousX = 0;
  private previousZ = 0;
  private hasPreviousPose = false;

  public constructor(options: AvatarOptions) {
    this.name = options.name;
    this.isCeo = options.isCeo;
    this.isLocal = options.isLocal;

    this.body =
      options.model !== undefined
        ? createHumanoidBody(options.model, options.isLocal, this.animation)
        : createCapsuleBody(options.isLocal);
    this.group.add(this.body.root);

    this.headAnchor.position.y = HEAD_ANCHOR_Y;
    this.group.add(this.headAnchor);

    this.emoteBillboard.sprite.position.y = EMOTE_OFFSET_Y;
    this.headAnchor.add(this.emoteBillboard.sprite);
    this.chatBillboard.sprite.position.y = CHAT_OFFSET_Y;
    this.headAnchor.add(this.chatBillboard.sprite);

    this.ceoMarker = new THREE.Mesh(CEO_MARKER_GEOMETRY, CEO_MARKER_MATERIAL);
    this.ceoMarker.position.y = CEO_MARKER_OFFSET_Y;
    this.ceoMarker.visible = options.isCeo;
    this.headAnchor.add(this.ceoMarker);

    this.nameplateCanvas.width = NAMEPLATE_CANVAS_WIDTH;
    this.nameplateCanvas.height = NAMEPLATE_CANVAS_HEIGHT;
    drawNameplate(this.nameplateCanvas, this.name, this.isCeo);
    this.nameplateTexture = new THREE.CanvasTexture(this.nameplateCanvas);
    this.nameplateTexture.colorSpace = THREE.SRGBColorSpace;
    this.nameplate = new THREE.Sprite(
      new THREE.SpriteMaterial({ map: this.nameplateTexture, transparent: true, depthTest: false }),
    );
    this.nameplate.position.y = NAMEPLATE_OFFSET_Y;
    this.applyNameplateScale();
    this.headAnchor.add(this.nameplate);
  }

  public setPose(x: number, z: number, yaw: number): void {
    this.group.position.set(x, 0, z);
    this.group.rotation.y = yaw;
    if (!this.hasPreviousPose) {
      // The first pose is a placement, not travel: crediting the distance from
      // the origin to it would report a speed nobody moved at.
      this.previousX = x;
      this.previousZ = z;
      this.hasPreviousPose = true;
    }
  }

  /** The state the body should be in, as the replicated field reports it. */
  public setAnimation(animation: AnimationState): void {
    if (animation === this.animation) {
      return;
    }
    this.animation = animation;
    this.body.animator?.setState(animation);
  }

  /** Advances the animation and whatever follows the pose. */
  public update(deltaSeconds: number): void {
    if (deltaSeconds > 0) {
      const travelled = Math.hypot(
        this.group.position.x - this.previousX,
        this.group.position.z - this.previousZ,
      );
      const sampled = Math.min(travelled / deltaSeconds, MAX_TRACKED_SPEED);
      // Remote poses arrive at a fifth of the frame rate, so the per-frame
      // sample is steppy even when the avatar is gliding; the walk cycle is
      // played at the smoothed speed rather than the raw one.
      this.speed += (sampled - this.speed) * (1 - Math.exp(-SPEED_EASE_RATE * deltaSeconds));

      const targetY = HEAD_ANCHOR_Y - (isSeated(this.animation) ? SEATED_HEAD_DROP : 0);
      const gap = targetY - this.headAnchor.position.y;
      this.headAnchor.position.y += gap * (1 - Math.exp(-HEAD_ANCHOR_EASE_RATE * deltaSeconds));
    }

    this.previousX = this.group.position.x;
    this.previousZ = this.group.position.z;

    const animator = this.body.animator;
    if (animator !== undefined) {
      animator.setSpeed(this.speed);
      animator.update(deltaSeconds);
    }
  }

  /**
   * Replaces the capsule with the humanoid body.
   *
   * Called once the model has downloaded, which may be after some avatars have
   * already been built. Calling it on a body that is already the humanoid does
   * nothing.
   */
  public useModel(model: AvatarModel): void {
    if (this.body.isHumanoid) {
      return;
    }

    const next = createHumanoidBody(model, this.isLocal, this.animation);
    this.body.dispose();
    this.body = next;
    this.group.add(this.body.root);
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
    this.body.dispose();
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

/** Whether a state has the occupant off their feet. */
function isSeated(animation: AnimationState): boolean {
  return animation === ANIMATION_STATE.sitting || animation === ANIMATION_STATE.typing;
}
