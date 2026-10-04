/**
 * Tuning values shared by the client's prediction and the server's validation.
 *
 * Anything here that both sides read must stay in this one place: if the client
 * walks at one speed and the server validates against another, honest players
 * get corrected and the movement feels like rubber-banding.
 *
 * Units are metres, seconds, and radians. Yaw is a rotation about +Y where 0
 * faces -Z, matching Three.js' default forward direction.
 */

/** Server simulation frequency. */
export const TICK_RATE_HZ = 20;

/** Milliseconds between server simulation ticks. */
export const TICK_INTERVAL_MS = 1000 / TICK_RATE_HZ;

/** How often the client reports its pose to the server. */
export const POSE_SEND_RATE_HZ = 20;

/** Milliseconds between outgoing pose messages. */
export const POSE_SEND_INTERVAL_MS = 1000 / POSE_SEND_RATE_HZ;

/** Ground speed of a walking occupant. */
export const WALK_SPEED = 3.2;

/**
 * Multiplier applied to {@link WALK_SPEED} before the server rejects a pose as
 * too fast. Absorbs frame-time jitter and a late packet without letting a
 * modified client meaningfully outrun an honest one.
 */
export const SPEED_TOLERANCE = 1.4;

/**
 * Longest interval the server will credit to a single pose message. A client
 * that goes quiet and then reports a distant pose is budgeted for this much
 * travel, not for the whole silence.
 */
export const MAX_POSE_INTERVAL_MS = 400;

/** Horizontal radius of an occupant's collision capsule. */
export const OCCUPANT_RADIUS = 0.35;

/** Total height of an occupant's capsule, floor to crown. */
export const OCCUPANT_HEIGHT = 1.7;

/**
 * Longest distance the collision resolver advances before re-testing against
 * the world. Must stay below the thinnest obstacle in the layout, or a fast
 * mover could step clean through a wall between two tests.
 *
 * @see MIN_OBSTACLE_THICKNESS
 */
export const COLLISION_SUBSTEP = 0.125;

/**
 * Thinnest obstacle the layout is allowed to contain. Walls are built at this
 * thickness, so {@link COLLISION_SUBSTEP} must remain smaller.
 */
export const MIN_OBSTACLE_THICKNESS = 0.3;

/**
 * Cap on substeps per resolve call, bounding the cost of an absurd input.
 * At {@link COLLISION_SUBSTEP} this still covers a move longer than the office
 * is wide, so legitimate motion never hits it.
 */
export const MAX_COLLISION_SUBSTEPS = 512;

/**
 * How far behind the present each remote avatar is rendered. Remote poses
 * arrive at {@link POSE_SEND_RATE_HZ}, so rendering this far back leaves two
 * samples to interpolate between and hides ordinary network jitter.
 */
export const INTERPOLATION_DELAY_MS = 100;

/** Pose samples retained per remote occupant for interpolation. */
export const POSE_BUFFER_SIZE = 24;

/**
 * How far the local player may drift from the server's authoritative pose
 * before the client eases back toward it. Must exceed the distance a player
 * covers while a pose is in flight, or every honest step triggers a correction.
 */
export const RECONCILE_THRESHOLD = 1;

/** Drift beyond which easing is abandoned and the local pose snaps. */
export const RECONCILE_SNAP_THRESHOLD = 3;

/** Fraction of the remaining error removed per second while easing. */
export const RECONCILE_EASE_RATE = 6;

/**
 * How long an emote stays above its actor's head.
 *
 * An emote is a gesture, not a status: it has to be long enough to notice from
 * across the office and short enough that a room full of people is not a wall
 * of frozen sprites.
 */
export const EMOTE_LIFETIME_MS = 2200;

/** How long a chat bubble stays above its speaker's head. */
export const CHAT_BUBBLE_LIFETIME_MS = 6000;

/**
 * Longest chat message the server will accept, in characters.
 *
 * The cap is enforced by truncation rather than rejection, so a long message
 * still says something. It bounds the bubble's text and the HUD log entry, both
 * of which are laid out for a message no longer than this.
 */
export const MAX_CHAT_LENGTH = 160;

/**
 * Chat messages a client may send back to back before the server starts
 * dropping them.
 */
export const CHAT_BURST_ALLOWANCE = 4;

/** Rate at which a client's chat allowance is restored, in messages/second. */
export const CHAT_REFILL_PER_SECOND = 0.8;

/** Emotes a client may fire back to back before the server starts dropping. */
export const EMOTE_BURST_ALLOWANCE = 3;

/** Rate at which a client's emote allowance is restored, in emotes/second. */
export const EMOTE_REFILL_PER_SECOND = 0.6;
