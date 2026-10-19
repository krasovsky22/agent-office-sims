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
 * How close an occupant has to stand to an interactable's anchor before it can
 * be used. The client shows its prompt at exactly this distance and the server
 * re-checks against it, so the prompt and the server's answer agree.
 */
export const INTERACT_RANGE = 1.5;

/**
 * Multiplier applied to {@link INTERACT_RANGE} before the server refuses an
 * interaction as out of range.
 *
 * The server measures from the pose it has accepted, which trails the pose the
 * client prompted from by up to a round trip. Without this slack a player who
 * pressed the key the instant the prompt appeared would be refused. It is the
 * same bargain {@link SPEED_TOLERANCE} makes: wide enough to absorb a packet in
 * flight, far too narrow to let a modified client reach across the room.
 */
export const INTERACT_RANGE_TOLERANCE = 1.25;

/**
 * How long a coffee break holds an occupant at the machine.
 *
 * The hold expires on the server's own clock, checked in the simulation tick,
 * so no client can shorten it and nothing has to be awaited.
 */
export const COFFEE_BREAK_MS = 2500;

/**
 * How many sips a poured coffee lasts, and how far apart they come.
 *
 * The cup leaves the machine full and is drunk on the server's clock, one sip
 * per interval once the break is over, so every client sees the same cup run
 * down and vanish after the last sip, whoever is holding it.
 */
export const COFFEE_SIPS = 10;
export const COFFEE_SIP_INTERVAL_MS = 6000;

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

/**
 * Longest note the office keeps on an issue's work, in characters: why an
 * agent is stuck, or why the work changed hands.
 *
 * Truncated rather than refused, like chat. Longer than a chat line because a
 * note is read on the board at leisure rather than in a passing bubble.
 */
export const MAX_WORK_NOTE_LENGTH = 280;

/**
 * Longest message to the AI manager the server will accept, in characters.
 *
 * Truncated rather than rejected, like chat. Room for an instruction with its
 * reasons, which is longer than anything said across the office.
 */
export const MAX_MANAGER_MESSAGE_LENGTH = 400;

/**
 * Longest line the manager posts, in characters: a status report over the
 * whole board fits, a model that runs on does not fill the panel.
 */
export const MAX_MANAGER_REPLY_LENGTH = 1500;

/**
 * Longest prompt the CEO may type to a coding agent, in UTF-16 code units, as
 * a text field counts them. Refused rather than cut past it: a prompt is
 * instructions to a process that runs commands, and half of one can mean
 * something else.
 */
export const MAX_AGENT_PROMPT_LENGTH = 2000;

/**
 * Messages the CEO may send the manager back to back before the server starts
 * dropping them. Lower than chat, because each one may become a model call.
 */
export const MANAGER_BURST_ALLOWANCE = 4;

/** Rate at which that allowance is restored, in messages/second: one every four seconds. */
export const MANAGER_REFILL_PER_SECOND = 0.25;

/**
 * Prompts the CEO may send coding agents back to back before the server starts
 * dropping them. Each one is typed into a real agent's terminal and starts a
 * turn that spends money, so fewer than the manager takes.
 */
export const AGENT_PROMPT_BURST_ALLOWANCE = 3;

/** Rate at which that allowance is restored, in prompts/second: one every five seconds. */
export const AGENT_PROMPT_REFILL_PER_SECOND = 0.2;

/**
 * Keys the CEO may press on coding agents' choice screens back to back before
 * the server starts dropping them. A key starts no turn of its own, and
 * reaching the third option takes a few, so more than prompts.
 */
export const AGENT_KEY_BURST_ALLOWANCE = 8;

/** Rate at which that allowance is restored, in keys/second. */
export const AGENT_KEY_REFILL_PER_SECOND = 2;

/**
 * Edits to coding agents' profiles the CEO may send back to back before the
 * server starts dropping them. Each is written to disk by a runner, and a
 * person saves a form a few times at most, so a small one.
 */
export const AGENT_PROFILE_BURST_ALLOWANCE = 4;

/** Rate at which that allowance is restored, in edits/second. */
export const AGENT_PROFILE_REFILL_PER_SECOND = 0.2;

/**
 * Standing task commands (pause, resume, remove, check now) the CEO may send
 * back to back, all four together, before the server starts dropping them.
 * Each one waits in its runner's command queue, which issue work shares, and
 * a check asks GitHub, so a handful.
 */
export const STANDING_BURST_ALLOWANCE = 4;

/** Rate at which that allowance is restored, in commands/second: one every five seconds. */
export const STANDING_REFILL_PER_SECOND = 0.2;

/**
 * Standups the CEO may call or end back to back before the server starts
 * dropping the commands: each walks every agent across the office.
 */
export const STANDUP_CALL_BURST_ALLOWANCE = 4;

/** Rate at which that allowance is restored, in calls/second. */
export const STANDUP_CALL_REFILL_PER_SECOND = 0.2;

/**
 * How long the server holds a dropped player's place, in seconds.
 *
 * A socket that closes without the player leaving — a network blip, a laptop
 * lid — keeps its occupant, and with it the CEO role, for this long. The
 * client reconnects within it and carries on as the same person; past it the
 * player is gone and, if they were CEO, the role passes on. Long enough to ride
 * out a flaky connection, short enough that an office does not sit for minutes
 * with its CEO's chair held by someone who is not coming back.
 */
export const RECONNECT_GRACE_SECONDS = 20;
