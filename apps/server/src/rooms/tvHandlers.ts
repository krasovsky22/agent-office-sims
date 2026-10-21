/**
 * The room's handler for changing the conference room's TV.
 *
 * Thin, like the radio's: the parser in `@sim/shared` has already reduced the
 * message to a channel and, for YouTube, bare ids, so all that is left is that
 * the sender stands at the TV and that YouTube will play a new link. A refusal
 * goes to the sender alone and the TV keeps showing what it had; a change
 * taken has no reply but the next patch.
 */

import { type Client, type Room } from "@colyseus/core";
import {
  CLIENT_MESSAGE,
  type OfficeLayout,
  type OfficeState,
  SERVER_MESSAGE,
  TV_INTERACTABLE_ID,
  TV_REJECTION,
  type TvRejectedEvent,
  type TvRejection,
  distanceToInteractable,
  interactableById,
  parseTvTuneMessage,
} from "@sim/shared";

import { SERVER_INTERACT_RANGE } from "../sim/interaction.js";
import type { YoutubeCheck } from "../sim/youtube.js";

/** What the handler needs from the room, named so a test can supply it. */
export interface TvHandlerHost {
  readonly state: OfficeState;
  /** The floor plan of the room's floor, where the TV hangs. */
  readonly layout: OfficeLayout;
  /** Charges one change against the sender's budget; `false` drops it, and the limiter says so. */
  readonly allow: (client: Client) => boolean;
  readonly checkYoutube: YoutubeCheck;
  /** Epoch milliseconds, which every tab measures a video's position against. */
  readonly now: () => number;
}

function refuse(client: Client, rejection: TvRejection): void {
  client.send(SERVER_MESSAGE.tvRejected, { rejection } satisfies TvRejectedEvent);
}

export function registerTvHandlers(room: Pick<Room<OfficeState>, "onMessage">, host: TvHandlerHost): void {
  const tvSpot = interactableById(host.layout, TV_INTERACTABLE_ID);

  room.onMessage(CLIENT_MESSAGE.tvTune, async (client, raw: unknown) => {
    const message = parseTvTuneMessage(raw);
    const sender = host.state.occupants.get(client.sessionId);
    if (message === undefined || sender === undefined || tvSpot === undefined) {
      return;
    }
    if (distanceToInteractable(tvSpot, sender) > SERVER_INTERACT_RANGE) {
      refuse(client, TV_REJECTION.outOfRange);
      return;
    }
    if (!host.allow(client)) {
      return;
    }
    const tv = host.state.tv;
    const { video } = message;
    if (video !== undefined) {
      const answer = await host.checkYoutube(video.videoId, video.listId);
      if (answer === undefined || !answer.playable) {
        refuse(client, answer === undefined ? TV_REJECTION.unchecked : TV_REJECTION.unplayable);
        return;
      }
      tv.videoId = video.videoId;
      tv.listId = video.listId;
      tv.title = answer.title;
      tv.startedAt = host.now();
    }
    tv.channel = message.channel;
    tv.changedBy = sender.name;
  });
}
