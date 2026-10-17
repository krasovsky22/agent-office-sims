/**
 * An occupant's body: a rigged humanoid, a floating nameplate, a CEO marker,
 * and whatever the occupant is currently expressing.
 *
 * Players, live agents and the manager are all built here, so they cannot
 * drift apart in how they move, sit or emote. What differs is identity, and it
 * is meant to read at a glance: each kind wears a colour of its own and says
 * on its nameplate what it is.
 *
 * Three things about the shape of this file are load-bearing:
 *
 * - **The capsule is still here, as the fallback.** An avatar built without a
 *   model yet stands as a capsule until {@link Avatar.useModel} upgrades it. A
 *   model that never arrives therefore leaves a body you can see and walk,
 *   rather than an invisible player.
 * - **Head-height attachments hang off {@link Avatar.headAnchor}.** The
 *   nameplate, the CEO marker or the manager's badge, the emote sprite and the
 *   chat bubble are all children of it. It is a plain object whose height follows the pose, so
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
 * Expression is the same for every occupant, so an agent gets emotes and chat
 * bubbles by being given an {@link Avatar}, with no extra work here; they only
 * sit higher, above whatever badge and second line it carries.
 *
 * A live coding agent's shell is a colour of its own, and its nameplate's
 * second line says what it is working on, so nobody walks up to one expecting
 * a colleague to answer.
 *
 * The AI manager has a crimson shell, its title under its name, and a badge
 * over its head saying whether it is ready or thinking.
 */

import {
  ANIMATION_STATE,
  type AnimationState,
  CHAT_BUBBLE_LIFETIME_MS,
  type Emote,
  EMOTE_LIFETIME_MS,
  type ManagerStatus,
  OCCUPANT_HEIGHT,
  OCCUPANT_KIND,
  OCCUPANT_RADIUS,
  type OccupantKind,
  SPEED_TOLERANCE,
  WALK_SPEED,
} from "@sim/shared";
import * as THREE from "three";

import { type BadgeAppearance, MANAGER_STATUS_APPEARANCE } from "../managerStatus.js";
import { EMOTE_APPEARANCE } from "../emotes.js";

import { AvatarAnimator } from "./avatarAnimator.js";
import type { AvatarLook, AvatarModel } from "./avatarModel.js";
import { Billboard, paintBeacon, paintEmote, paintSpeechBubble, paintStatusBadge } from "./billboard.js";

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
 * The manager's status badge, in the slot just over the head where a player's
 * CEO marker would be — the manager is never CEO.
 *
 * Its lettering is a little taller than a nameplate's, because it is the one
 * thing on the manager that changes and the floor is read by it.
 */
const BADGE_OFFSET_Y = 0.18;
const BADGE_CANVAS_WIDTH = 384;
const BADGE_CANVAS_HEIGHT = 72;
const BADGE_WORLD_HEIGHT = 0.28;

/**
 * A live agent's needs-you beacon, in the same slot just over the head: a live
 * agent has no status badge and is never CEO, so the slot is free. A little
 * shorter than a badge so it clears the two-line nameplate above it.
 */
const BEACON_OFFSET_Y = 0.13;
const BEACON_WORLD_HEIGHT = 0.22;
const BEACON_LABEL = "Needs you";

/** The beacon's swell, as a fraction of its size, and how many times a second it swells. */
const BEACON_PULSE = 0.08;
const BEACON_PULSE_HZ = 1.2;

/**
 * How much higher the manager's nameplate, and then its emotes and bubbles,
 * sit than a player's.
 *
 * The nameplate clears the badge beneath it; the expressions clear the
 * nameplate's extra line on top of that. The manager saying something while
 * thinking therefore shows all four, stacked, without any overlapping.
 */
const BADGED_NAMEPLATE_LIFT = 0.2;
const BADGED_EXPRESSION_LIFT = 0.31;

/**
 * Height of the attachment point everything above the head hangs from: the
 * crown of a standing occupant.
 */
const HEAD_ANCHOR_Y = OCCUPANT_HEIGHT;

/**
 * The capsule's seated pose, as a squash and a lift of the standing body.
 *
 * The capsule has no skeleton to pose, so sitting is a transform. The numbers
 * put the crown of a sitting capsule a little over a third of a metre below a
 * standing one, which is the difference that has to be legible from across the
 * office in the other tab.
 */
const CAPSULE_SEATED_SQUASH = 0.62;
const CAPSULE_SEATED_LIFT = 0.3;
const CAPSULE_SEATED_HEAD_DROP =
  OCCUPANT_HEIGHT - (CAPSULE_SEATED_LIFT + OCCUPANT_HEIGHT * CAPSULE_SEATED_SQUASH);

/** Fraction of the remaining gap the head anchor closes per second. */
const HEAD_ANCHOR_EASE_RATE = 8;

/**
 * Fraction of the remaining gap the body closes per second when it moves
 * between a chair and the floor beside it.
 *
 * Sitting down snaps the pose onto the seat and standing up onto the spot
 * behind the chair, both from the shared layout; drawn as given, the body would
 * jump. Easing it over about as long as the pose takes to blend is what makes
 * getting up read as stepping back out of the chair.
 */
const SEAT_GLIDE_RATE = 10;

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
 *
 * An agent's or the manager's is taller by a line, for its task or title, and
 * fixed the same way; an occupant's kind never changes, so neither does which
 * of the two it has.
 */
const NAMEPLATE_CANVAS_WIDTH = 640;
const NAMEPLATE_CANVAS_HEIGHT = 64;
const AGENT_NAMEPLATE_CANVAS_HEIGHT = 108;

/**
 * How much higher a live agent's emotes and bubbles sit over its two-line
 * nameplate. It has no badge, so only the extra line has to be cleared; the
 * plate itself grows upward by half of this, so its name line stays where a
 * player's would be.
 */
const LIVE_AGENT_EXPRESSION_LIFT =
  (NAMEPLATE_HEIGHT * (AGENT_NAMEPLATE_CANVAS_HEIGHT - NAMEPLATE_CANVAS_HEIGHT)) /
  NAMEPLATE_CANVAS_HEIGHT;

/** Lettering of each nameplate line, as a fraction of a one-line plate's height. */
const NAME_FONT_SCALE = 0.52;
const TITLE_FONT_SCALE = 0.42;

/** Expiry sentinel for "not showing anything". */
const NOT_SHOWING = Number.NEGATIVE_INFINITY;

const LOCAL_BODY_COLOUR = 0xcfd3da;
const REMOTE_BODY_COLOUR = 0x9aa0aa;
/** The fallback capsule's version of the live agents' violet shell in `avatarModel.ts`. */
const LIVE_AGENT_BODY_COLOUR = 0x8a6cf0;
/** A live agent's task line: the same violet, lifted to read on the dark pill. */
const LIVE_AGENT_CAPTION_COLOUR = "#c9bcff";
/** The fallback capsule's version of the manager's crimson shell in `avatarModel.ts`. */
const MANAGER_BODY_COLOUR = 0xcf3d4f;
/** The manager's title on its nameplate: the same crimson, lifted to read on the dark pill. */
const MANAGER_TITLE_COLOUR = "#ff9aa5";
const FACING_COLOUR = 0x5e6470;
const CEO_MARKER_COLOUR = 0xf0c650;
const CUP_COLOUR = 0xe8dcc4;

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
const CUP_GEOMETRY = new THREE.CylinderGeometry(0.05, 0.04, 0.11, 8);

const FACING_MATERIAL = new THREE.MeshLambertMaterial({ color: FACING_COLOUR });
const CEO_MARKER_MATERIAL = new THREE.MeshLambertMaterial({ color: CEO_MARKER_COLOUR });
const CUP_MATERIAL = new THREE.MeshLambertMaterial({ color: CUP_COLOUR });

export interface AvatarOptions {
  readonly name: string;
  readonly kind: OccupantKind;
  readonly isCeo: boolean;
  /** The manager's job title, shown under its name; `""` for anyone else. */
  readonly jobTitle: string;
  /** A live coding agent's task, shown under its name; `""` for anyone else. */
  readonly caption: string;
  /** Whether a live coding agent is stuck until a person acts, which shows its beacon. */
  readonly needsInput: boolean;
  /** The AI manager's status, shown on its badge; `undefined` for anyone else. */
  readonly managerStatus: ManagerStatus | undefined;
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
  /**
   * How far the head drops when seated.
   *
   * The head anchor follows it so a nameplate still sits above the head of
   * someone at a desk instead of floating where they used to be standing.
   */
  readonly seatedHeadDrop: number;
  dispose: () => void;
}

/**
 * Paints a nameplate: the name, with a CEO suffix for the CEO, and on a second
 * line beneath it the manager's job title or a live agent's task, cut short
 * with an ellipsis rather than overflowing.
 */
function drawNameplate(
  canvas: HTMLCanvasElement,
  name: string,
  isCeo: boolean,
  subtitle: string,
  kind: OccupantKind,
): void {
  const isLiveAgent = kind === OCCUPANT_KIND.liveAgent;
  const label = isCeo ? `${name}  ·  CEO` : isLiveAgent ? `${name}  ·  agent` : name;
  const context = canvas.getContext("2d");
  if (context === null) {
    return;
  }

  const nameFont = `600 ${Math.round(NAMEPLATE_CANVAS_HEIGHT * NAME_FONT_SCALE)}px ui-sans-serif, system-ui, sans-serif`;
  const titleFont = `500 ${Math.round(NAMEPLATE_CANVAS_HEIGHT * TITLE_FONT_SCALE)}px ui-sans-serif, system-ui, sans-serif`;

  context.clearRect(0, 0, canvas.width, canvas.height);
  context.textAlign = "center";
  context.textBaseline = "middle";

  const padding = NAMEPLATE_CANVAS_HEIGHT * 0.38;
  context.font = titleFont;
  const hasTitleLine = subtitle !== "";
  const title = fitText(context, subtitle, canvas.width - padding * 2);
  const titleWidth = hasTitleLine ? context.measureText(title).width : 0;
  context.font = nameFont;
  const textWidth = Math.max(context.measureText(label).width, titleWidth);
  const pillWidth = Math.min(canvas.width, Math.ceil(textWidth + padding * 2));
  const centreX = canvas.width / 2;

  context.fillStyle = "rgba(20, 20, 24, 0.72)";
  context.beginPath();
  context.roundRect(
    centreX - pillWidth / 2,
    0,
    pillWidth,
    canvas.height,
    Math.min(canvas.height, NAMEPLATE_CANVAS_HEIGHT) / 2,
  );
  context.fill();

  if (!hasTitleLine) {
    context.fillStyle = isCeo ? "#f3cf6a" : "#eef0f4";
    context.fillText(label, centreX, canvas.height / 2 + 1);
    return;
  }

  // Two lines, split so the name keeps a one-line plate's lettering.
  const nameY = canvas.height * 0.36;
  const titleY = canvas.height * 0.73;
  context.fillStyle = "#eef0f4";
  context.fillText(label, centreX, nameY);
  context.font = titleFont;
  context.fillStyle = isLiveAgent ? LIVE_AGENT_CAPTION_COLOUR : MANAGER_TITLE_COLOUR;
  context.fillText(title, centreX, titleY);
}

/** `text`, or as much of it as fits in `maxWidth` followed by an ellipsis. */
function fitText(context: CanvasRenderingContext2D, text: string, maxWidth: number): string {
  if (context.measureText(text).width <= maxWidth) {
    return text;
  }
  const characters = Array.from(text);
  while (characters.length > 0 && context.measureText(`${characters.join("")}…`).width > maxWidth) {
    characters.pop();
  }
  return `${characters.join("").trimEnd()}…`;
}

/** The humanoid body, built once a model is available. */
function createHumanoidBody(
  model: AvatarModel,
  look: AvatarLook,
  initialAnimation: AnimationState,
): AvatarBody {
  const instance = model.createInstance(look);
  const animator = new AvatarAnimator(instance.root, instance.clips);
  animator.setState(initialAnimation);

  return {
    root: instance.root,
    animator,
    isHumanoid: true,
    seatedHeadDrop: instance.seatedHeadDrop,
    dispose: () => {
      animator.dispose();
      instance.dispose();
    },
  };
}

const CAPSULE_COLOUR: Record<AvatarLook, number> = {
  local: LOCAL_BODY_COLOUR,
  remote: REMOTE_BODY_COLOUR,
  liveAgent: LIVE_AGENT_BODY_COLOUR,
  manager: MANAGER_BODY_COLOUR,
};

/** The capsule: the body an avatar has before the model arrives, or instead of it. */
function createCapsuleBody(look: AvatarLook): AvatarBody {
  const root = new THREE.Group();
  root.name = "avatar-capsule";

  const material = new THREE.MeshLambertMaterial({ color: CAPSULE_COLOUR[look] });
  const capsule = new THREE.Mesh(BODY_GEOMETRY, material);
  capsule.position.y = OCCUPANT_HEIGHT / 2;
  // The body is the only part of an avatar that casts: a shadow under a player
  // is what sells them standing on the floor, and the nub and the CEO cone are
  // too small to read as anything but noise.
  capsule.castShadow = true;
  root.add(capsule);

  // A nub on the front, so which way an avatar faces is readable at a glance.
  const facing = new THREE.Mesh(FACING_GEOMETRY, FACING_MATERIAL);
  facing.position.set(0, OCCUPANT_HEIGHT * 0.72, -OCCUPANT_RADIUS);
  root.add(facing);

  return {
    root,
    animator: undefined,
    isHumanoid: false,
    seatedHeadDrop: CAPSULE_SEATED_HEAD_DROP,
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
   * Nameplate, CEO marker, status badge, needs-you beacon, emote sprite and
   * chat bubble are all children of it. Its height tracks the pose, so a child at a fixed local offset keeps
   * sitting above the head, and when the capsule is replaced by a rigged
   * mesh, re-parenting this one group to a head bone moves all of it.
   */
  public readonly headAnchor = new THREE.Object3D();

  private readonly ceoMarker: THREE.Mesh;
  private readonly cup: THREE.Mesh;
  /** Kept across a change of body, so a body swapped in while hidden stays hidden. */
  private bodyHidden = false;
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

  /** The manager's status badge; absent on anyone else. */
  private readonly badge: Billboard | undefined;
  /** The label the badge last showed, so it is repainted only on a change. */
  private badgeLabel: string | undefined;

  /** A live agent's needs-you beacon; absent on anyone else. */
  private readonly beacon: Billboard | undefined;
  /** The beacon's size at rest, which its pulse swells from. */
  private readonly beaconScale = new THREE.Vector2();

  private emoteExpiresAt = NOT_SHOWING;
  private chatExpiresAt = NOT_SHOWING;

  private body: AvatarBody;
  private readonly look: AvatarLook;
  private readonly isLiveAgent: boolean;
  private readonly kind: OccupantKind;

  private name: string;
  private isCeo: boolean;
  /** The nameplate's second line: the manager's job title or a live agent's task. */
  private subtitle: string;
  private animation: AnimationState = ANIMATION_STATE.idle;

  private speed = 0;
  private previousX = 0;
  private previousZ = 0;
  private hasPreviousPose = false;

  /** The pose as given, before the glide below is added to it. */
  private poseX = 0;
  private poseZ = 0;
  /** How far the drawn body still is from the pose, after a sit or a stand. */
  private glideX = 0;
  private glideZ = 0;

  public constructor(options: AvatarOptions) {
    this.kind = options.kind;
    const isManager = options.kind === OCCUPANT_KIND.manager;
    this.isLiveAgent = options.kind === OCCUPANT_KIND.liveAgent;
    this.name = options.name;
    this.isCeo = options.isCeo;
    this.subtitle = this.isLiveAgent ? options.caption : options.jobTitle;
    this.look = this.isLiveAgent
      ? "liveAgent"
      : isManager
        ? "manager"
        : options.isLocal
          ? "local"
          : "remote";

    this.body =
      options.model !== undefined
        ? createHumanoidBody(options.model, this.look, this.animation)
        : createCapsuleBody(this.look);
    this.group.add(this.body.root);

    // Held out to one side rather than straight ahead: a cup in front of the
    // chest is hidden behind the body from the owner's own camera, which is
    // exactly the viewer who most needs to see that the break is running.
    this.cup = new THREE.Mesh(CUP_GEOMETRY, CUP_MATERIAL);
    this.cup.position.set(OCCUPANT_RADIUS + 0.07, OCCUPANT_HEIGHT * 0.56, -OCCUPANT_RADIUS * 0.7);
    this.cup.visible = false;
    this.group.add(this.cup);

    this.headAnchor.position.y = HEAD_ANCHOR_Y;
    this.group.add(this.headAnchor);

    const lift = isManager
      ? BADGED_EXPRESSION_LIFT
      : this.isLiveAgent
        ? LIVE_AGENT_EXPRESSION_LIFT
        : 0;
    this.emoteBillboard.sprite.position.y = EMOTE_OFFSET_Y + lift;
    this.headAnchor.add(this.emoteBillboard.sprite);
    this.chatBillboard.sprite.position.y = CHAT_OFFSET_Y + lift;
    this.headAnchor.add(this.chatBillboard.sprite);

    if (isManager) {
      this.badge = new Billboard({
        canvasWidth: BADGE_CANVAS_WIDTH,
        canvasHeight: BADGE_CANVAS_HEIGHT,
        worldHeight: BADGE_WORLD_HEIGHT,
      });
      this.badge.sprite.position.y = BADGE_OFFSET_Y;
      this.headAnchor.add(this.badge.sprite);
      this.setManagerStatus(options.managerStatus);
    }

    if (this.isLiveAgent) {
      this.beacon = new Billboard({
        canvasWidth: BADGE_CANVAS_WIDTH,
        canvasHeight: BADGE_CANVAS_HEIGHT,
        worldHeight: BEACON_WORLD_HEIGHT,
      });
      this.beacon.sprite.position.y = BEACON_OFFSET_Y;
      this.beaconScale.set(this.beacon.sprite.scale.x, this.beacon.sprite.scale.y);
      this.headAnchor.add(this.beacon.sprite);
      this.setNeedsInput(options.needsInput);
    }

    this.ceoMarker = new THREE.Mesh(CEO_MARKER_GEOMETRY, CEO_MARKER_MATERIAL);
    this.ceoMarker.position.y = CEO_MARKER_OFFSET_Y;
    this.ceoMarker.visible = options.isCeo;
    this.headAnchor.add(this.ceoMarker);

    this.nameplateCanvas.width = NAMEPLATE_CANVAS_WIDTH;
    this.nameplateCanvas.height =
      isManager || this.isLiveAgent ? AGENT_NAMEPLATE_CANVAS_HEIGHT : NAMEPLATE_CANVAS_HEIGHT;
    drawNameplate(this.nameplateCanvas, this.name, this.isCeo, this.subtitle, this.kind);
    this.nameplateTexture = new THREE.CanvasTexture(this.nameplateCanvas);
    this.nameplateTexture.colorSpace = THREE.SRGBColorSpace;
    this.nameplate = new THREE.Sprite(
      new THREE.SpriteMaterial({ map: this.nameplateTexture, transparent: true, depthTest: false }),
    );
    this.nameplate.position.y =
      NAMEPLATE_OFFSET_Y +
      (isManager ? BADGED_NAMEPLATE_LIFT : this.isLiveAgent ? LIVE_AGENT_EXPRESSION_LIFT / 2 : 0);
    this.applyNameplateScale();
    this.headAnchor.add(this.nameplate);
  }

  public setPose(x: number, z: number, yaw: number): void {
    this.poseX = x;
    this.poseZ = z;
    this.group.position.set(x + this.glideX, 0, z + this.glideZ);
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
    if (isSeated(animation) !== isSeated(this.animation) && this.hasPreviousPose) {
      // Carry on from where the body was drawn last frame, and ease from there
      // to the pose it has just been given.
      this.glideX = this.previousX - this.poseX;
      this.glideZ = this.previousZ - this.poseZ;
      this.group.position.set(this.previousX, 0, this.previousZ);
    }
    this.animation = animation;
    this.body.animator?.setState(animation);
    this.applyCapsulePosture();
  }

  /** Shows or hides the coffee cup a break at the machine puts in hand. */
  public setHoldingCup(holding: boolean): void {
    this.cup.visible = holding;
  }

  /** Advances the animation and whatever follows the pose. */
  public update(deltaSeconds: number): void {
    if (deltaSeconds > 0) {
      const settle = Math.exp(-SEAT_GLIDE_RATE * deltaSeconds);
      this.glideX *= settle;
      this.glideZ *= settle;
      this.group.position.set(this.poseX + this.glideX, 0, this.poseZ + this.glideZ);

      const travelled = Math.hypot(
        this.group.position.x - this.previousX,
        this.group.position.z - this.previousZ,
      );
      const sampled = Math.min(travelled / deltaSeconds, MAX_TRACKED_SPEED);
      // Remote poses arrive at a fifth of the frame rate, so the per-frame
      // sample is steppy even when the avatar is gliding; the walk cycle is
      // played at the smoothed speed rather than the raw one.
      this.speed += (sampled - this.speed) * (1 - Math.exp(-SPEED_EASE_RATE * deltaSeconds));

      const targetY = HEAD_ANCHOR_Y - (isSeated(this.animation) ? this.body.seatedHeadDrop : 0);
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

    const next = createHumanoidBody(model, this.look, this.animation);
    this.body.dispose();
    this.body = next;
    this.body.root.visible = !this.bodyHidden;
    this.group.add(this.body.root);
  }

  /**
   * Hides the body, and only the body: what floats over its head still shows.
   * For a seated agent the camera has leaned in over, which is where its head is.
   */
  public setBodyHidden(hidden: boolean): void {
    this.bodyHidden = hidden;
    this.body.root.visible = !hidden;
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
    if (this.beacon?.visible === true) {
      const swell = 1 + BEACON_PULSE * Math.sin((nowMs / 1000) * BEACON_PULSE_HZ * Math.PI * 2);
      this.beacon.sprite.scale.set(this.beaconScale.x * swell, this.beaconScale.y * swell, 1);
    }
  }

  /** Re-renders the nameplate only when something it shows has changed. */
  public setLabel(name: string, isCeo: boolean, subtitle: string): void {
    if (name === this.name && isCeo === this.isCeo && subtitle === this.subtitle) {
      return;
    }
    this.name = name;
    this.isCeo = isCeo;
    this.subtitle = subtitle;
    this.ceoMarker.visible = isCeo;
    drawNameplate(this.nameplateCanvas, name, isCeo, subtitle, this.kind);
    this.nameplateTexture.needsUpdate = true;
  }

  /**
   * Shows a live agent's needs-you beacon while it is stuck until a person
   * acts, and takes it down when it resumes. Does nothing on anyone else.
   */
  public setNeedsInput(needsInput: boolean): void {
    const beacon = this.beacon;
    if (beacon === undefined || beacon.visible === needsInput) {
      return;
    }
    if (needsInput) {
      beacon.show(paintBeacon(BEACON_LABEL));
    } else {
      beacon.hide();
    }
  }

  /** Repaints the manager's badge, only when its status has changed. Does nothing on anyone else. */
  public setManagerStatus(status: ManagerStatus | undefined): void {
    if (this.kind === OCCUPANT_KIND.manager) {
      this.showBadge(status === undefined ? undefined : MANAGER_STATUS_APPEARANCE[status]);
    }
  }

  private showBadge(appearance: BadgeAppearance | undefined): void {
    const badge = this.badge;
    if (badge === undefined || appearance?.label === this.badgeLabel) {
      return;
    }
    this.badgeLabel = appearance?.label;
    if (appearance === undefined) {
      badge.hide();
      return;
    }
    badge.show(paintStatusBadge(appearance.label, appearance.colour));
  }

  public dispose(): void {
    this.group.removeFromParent();
    this.body.dispose();
    this.nameplate.material.dispose();
    this.nameplateTexture.dispose();
    this.emoteBillboard.dispose();
    this.chatBillboard.dispose();
    this.badge?.dispose();
    this.beacon?.dispose();
  }

  /**
   * Squashes the capsule into a seated pose, or stands it back up.
   *
   * The humanoid sits by playing its clip, so this leaves it alone.
   */
  private applyCapsulePosture(): void {
    if (this.body.isHumanoid) {
      return;
    }
    const seated = isSeated(this.animation);
    this.body.root.scale.y = seated ? CAPSULE_SEATED_SQUASH : 1;
    this.body.root.position.y = seated ? CAPSULE_SEATED_LIFT : 0;
  }

  /** Keeps the lettering one size: a taller canvas makes a taller sprite. */
  private applyNameplateScale(): void {
    const unit = NAMEPLATE_HEIGHT / NAMEPLATE_CANVAS_HEIGHT;
    this.nameplate.scale.set(
      this.nameplateCanvas.width * unit,
      this.nameplateCanvas.height * unit,
      1,
    );
  }
}

/** Whether a state has the occupant off their feet. */
function isSeated(animation: AnimationState): boolean {
  return animation === ANIMATION_STATE.sitting || animation === ANIMATION_STATE.typing;
}
