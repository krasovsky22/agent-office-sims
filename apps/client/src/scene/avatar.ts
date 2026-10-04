/**
 * An occupant's body: a capsule, a floating nameplate, and a CEO marker.
 *
 * The nameplate is a sprite, so it faces the camera from every angle without the
 * game loop having to orient it. Its text is drawn once into a canvas when the
 * avatar is built or renamed, not per frame.
 */

import { ANIMATION_STATE, type AnimationState, OCCUPANT_HEIGHT, OCCUPANT_RADIUS } from "@sim/shared";
import * as THREE from "three";

/** Height of the nameplate above the floor. */
const NAMEPLATE_Y = OCCUPANT_HEIGHT + 0.42;

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

/**
 * The seated pose, as a squash and a lift of the standing body.
 *
 * Not an animation: this milestone has no skeleton to pose and no blending, so
 * sitting is a transform. The numbers put the crown of a sitting occupant a
 * little over a third of a metre below a standing one, which is the difference
 * that has to be legible from across the office in the other tab.
 */
const SEATED_SQUASH = 0.62;
const SEATED_LIFT = 0.3;

const LOCAL_BODY_COLOUR = 0xcfd3da;
const REMOTE_BODY_COLOUR = 0x9aa0aa;
const FACING_COLOUR = 0x5e6470;
const CEO_MARKER_COLOUR = 0xf0c650;
const CUP_COLOUR = 0xe8dcc4;

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
const CUP_GEOMETRY = new THREE.CylinderGeometry(0.05, 0.04, 0.11, 8);

const FACING_MATERIAL = new THREE.MeshLambertMaterial({ color: FACING_COLOUR });
const CEO_MARKER_MATERIAL = new THREE.MeshLambertMaterial({ color: CEO_MARKER_COLOUR });
const CUP_MATERIAL = new THREE.MeshLambertMaterial({ color: CUP_COLOUR });

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
   * Everything that changes shape between standing and sitting.
   *
   * The nameplate is deliberately not in here: it is a sprite, and a sprite
   * inherits its parent's scale, so squashing this group would squash the text.
   * Its height is adjusted directly instead.
   */
  private readonly posture = new THREE.Group();

  private readonly body: THREE.Mesh;
  private readonly bodyMaterial: THREE.MeshLambertMaterial;
  private readonly ceoMarker: THREE.Mesh;
  private readonly cup: THREE.Mesh;
  private readonly nameplate: THREE.Sprite;
  private readonly nameplateCanvas = document.createElement("canvas");
  private readonly nameplateTexture: THREE.CanvasTexture;

  private name: string;
  private isCeo: boolean;
  private animation: AnimationState = ANIMATION_STATE.idle;

  public constructor(options: AvatarOptions) {
    this.name = options.name;
    this.isCeo = options.isCeo;
    this.group.add(this.posture);

    this.bodyMaterial = new THREE.MeshLambertMaterial({
      color: options.isLocal ? LOCAL_BODY_COLOUR : REMOTE_BODY_COLOUR,
    });
    this.body = new THREE.Mesh(BODY_GEOMETRY, this.bodyMaterial);
    this.body.position.y = OCCUPANT_HEIGHT / 2;
    this.posture.add(this.body);

    // A nub on the front, so which way an avatar faces is readable at a glance.
    const facing = new THREE.Mesh(FACING_GEOMETRY, FACING_MATERIAL);
    facing.position.set(0, OCCUPANT_HEIGHT * 0.72, -OCCUPANT_RADIUS);
    this.posture.add(facing);

    this.ceoMarker = new THREE.Mesh(CEO_MARKER_GEOMETRY, CEO_MARKER_MATERIAL);
    this.ceoMarker.position.y = CEO_MARKER_Y;
    this.ceoMarker.visible = options.isCeo;
    this.posture.add(this.ceoMarker);

    // Held out to one side rather than straight ahead: a cup in front of the
    // chest is hidden behind the body from the owner's own camera, which is
    // exactly the viewer who most needs to see that the break is running.
    this.cup = new THREE.Mesh(CUP_GEOMETRY, CUP_MATERIAL);
    this.cup.position.set(OCCUPANT_RADIUS + 0.07, OCCUPANT_HEIGHT * 0.56, -OCCUPANT_RADIUS * 0.7);
    this.cup.visible = false;
    this.posture.add(this.cup);

    this.nameplateCanvas.width = NAMEPLATE_CANVAS_WIDTH;
    this.nameplateCanvas.height = NAMEPLATE_CANVAS_HEIGHT;
    drawNameplate(this.nameplateCanvas, this.name, this.isCeo);
    this.nameplateTexture = new THREE.CanvasTexture(this.nameplateCanvas);
    this.nameplateTexture.colorSpace = THREE.SRGBColorSpace;
    this.nameplate = new THREE.Sprite(
      new THREE.SpriteMaterial({ map: this.nameplateTexture, transparent: true, depthTest: false }),
    );
    this.nameplate.position.y = NAMEPLATE_Y;
    this.applyNameplateScale();
    this.group.add(this.nameplate);
  }

  public setPose(x: number, z: number, yaw: number): void {
    this.group.position.set(x, 0, z);
    this.group.rotation.y = yaw;
  }

  /**
   * Hangs the body off a seat anchor, or puts it back in the world.
   *
   * Parenting rather than positioning: once the body is a child of the desk's
   * seat anchor its place in the office comes from the layout, and the game loop
   * stops posing it at all. That is also what makes a sitter in the other tab
   * perfectly still, instead of interpolating toward a position that is not
   * changing.
   *
   * @param anchor the seat to sit on, or `undefined` to stand up.
   * @param world where a standing body belongs.
   */
  public setSeat(anchor: THREE.Object3D | undefined, world: THREE.Object3D): void {
    const parent = anchor ?? world;
    if (this.group.parent !== parent) {
      parent.add(this.group);
    }
    if (anchor !== undefined) {
      this.group.position.set(0, 0, 0);
      this.group.rotation.y = 0;
    }
  }

  /** Applies whatever the occupant is doing to the body. Cheap to call often. */
  public setAnimation(animation: AnimationState): void {
    if (animation === this.animation) {
      return;
    }
    this.animation = animation;

    const seated = animation === ANIMATION_STATE.seated;
    this.posture.scale.y = seated ? SEATED_SQUASH : 1;
    this.posture.position.y = seated ? SEATED_LIFT : 0;
    this.nameplate.position.y = seated
      ? SEATED_LIFT + NAMEPLATE_Y * SEATED_SQUASH
      : NAMEPLATE_Y;
    this.cup.visible = animation === ANIMATION_STATE.drinking;
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
  }

  private applyNameplateScale(): void {
    const aspect = NAMEPLATE_CANVAS_WIDTH / NAMEPLATE_CANVAS_HEIGHT;
    this.nameplate.scale.set(NAMEPLATE_HEIGHT * aspect, NAMEPLATE_HEIGHT, 1);
  }
}
