/**
 * The room's handlers for being on the floor: moving, jumping, using things,
 * emoting, chatting, and changing one's name.
 *
 * Thin, like the room's other handlers: each parses the untrusted payload and
 * hands it to the rule that decides — `../sim/movement.ts` for a pose or a
 * jump, `../sim/interaction.ts` for a chair or a coffee machine. Expression is
 * relayed rather than replicated, since a wave or a sentence is only true for
 * a moment: the sender's budget is charged, then the room broadcasts it.
 */

import { type Client, type Room } from "@colyseus/core";
import {
  CLIENT_MESSAGE,
  type EmoteEvent,
  type JumpEvent,
  type NameRejectedEvent,
  type OfficeState,
  SERVER_MESSAGE,
  type ThrottledEvent,
  nameRefusal,
  parseChatMessage,
  parseEmoteMessage,
  parseInteractMessage,
  parsePoseMessage,
  parseRenameMessage,
} from "@sim/shared";

import { recordOfficeEvent } from "../sim/events.js";
import { type InteractionHost, releaseHold, requestInteract } from "../sim/interaction.js";
import { recordPose, tryJump } from "../sim/movement.js";

/** What the handlers need from the room, named so a test can supply it. */
export interface PresenceHandlerHost {
  readonly state: OfficeState;
  /** Who is where and holding what; its motions are the poses this room has accepted. */
  readonly interaction: InteractionHost;
  /** The room's clock, which poses, jumps and holds are timed against. */
  readonly now: () => number;
  /** Charges one message against the sender's budget; `false` drops it, and the limiter says so. */
  readonly allow: (client: Client, command: ThrottledEvent["command"]) => boolean;
  /** Says something out loud on an occupant's behalf. */
  readonly say: (occupantId: string, text: string) => void;
}

export function registerPresenceHandlers(
  room: Pick<Room<OfficeState>, "onMessage" | "broadcast">,
  host: PresenceHandlerHost,
): void {
  room.onMessage(CLIENT_MESSAGE.pose, (client, raw: unknown) => {
    const pose = parsePoseMessage(raw);
    const motion = host.interaction.motions.get(client.sessionId);
    if (pose === undefined || motion === undefined) {
      // A malformed payload is dropped; another pose follows in ~50ms.
      return;
    }
    recordPose(motion, pose, host.now());
  });

  room.onMessage(CLIENT_MESSAGE.jump, (client) => {
    const occupant = host.state.occupants.get(client.sessionId);
    const motion = host.interaction.motions.get(client.sessionId);
    if (occupant === undefined || motion === undefined || !tryJump(occupant, motion, host.now())) {
      return;
    }
    // Not back to the jumper, who drew the jump the moment the key went down.
    room.broadcast(SERVER_MESSAGE.jump, { occupantId: client.sessionId } satisfies JumpEvent, { except: client });
  });

  room.onMessage(CLIENT_MESSAGE.interact, (client, raw: unknown) => {
    const message = parseInteractMessage(raw);
    if (message === undefined) {
      return;
    }
    // A refusal is not answered: the client ran the same rule before showing
    // its prompt, so a refusal means either a race it will see resolved in
    // the next patch or a client that was not asking honestly.
    const outcome = requestInteract(host.interaction, client.sessionId, message.target, host.now());
    if (outcome.result === "used") {
      // An interaction that holds nothing has no state to change, so all it
      // can do for now is leave a trace — see `sim/events.ts`. A wall board's
      // close-up is the reading client's own view, so it changes nothing here.
      recordOfficeEvent("interact", {
        actor: host.state.occupants.get(client.sessionId)?.name ?? client.sessionId,
        target: outcome.target.id,
        kind: outcome.target.kind,
      });
    }
  });

  room.onMessage(CLIENT_MESSAGE.release, (client) => {
    releaseHold(host.interaction, client.sessionId, host.now());
  });

  room.onMessage(CLIENT_MESSAGE.emote, (client, raw: unknown) => {
    const message = parseEmoteMessage(raw);
    if (message === undefined || !host.allow(client, CLIENT_MESSAGE.emote)) {
      return;
    }
    room.broadcast(SERVER_MESSAGE.emote, {
      occupantId: client.sessionId,
      emote: message.emote,
    } satisfies EmoteEvent);
  });

  room.onMessage(CLIENT_MESSAGE.chat, (client, raw: unknown) => {
    // The text is sanitized by the parser, so what goes out over the wire is
    // already capped and stripped. No client ever has to re-check it.
    const message = parseChatMessage(raw);
    if (message === undefined || !host.allow(client, CLIENT_MESSAGE.chat)) {
      return;
    }
    host.say(client.sessionId, message.text);
  });

  room.onMessage(CLIENT_MESSAGE.rename, (client, raw: unknown) => {
    const message = parseRenameMessage(raw);
    const player = host.state.occupants.get(client.sessionId);
    if (message === undefined || player === undefined || !host.allow(client, CLIENT_MESSAGE.rename)) {
      return;
    }
    const others = [...host.state.occupants.values()].filter((occupant) => occupant !== player);
    const rejection = nameRefusal(message.name, others);
    if (rejection !== undefined) {
      client.send(SERVER_MESSAGE.nameRejected, { name: message.name, rejection } satisfies NameRejectedEvent);
      return;
    }
    player.name = message.name;
  });
}
