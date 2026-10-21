/**
 * The room's handler for tuning the office radio.
 *
 * Thin, like the room's others: the parser in `@sim/shared` has already
 * reduced the link to a station or bare YouTube ids, so all that is left is
 * that the sender stands at the radio and, for YouTube, that YouTube will play
 * it. A refusal goes to the sender alone and the radio keeps playing; a tune
 * taken has no reply but the next patch.
 */

import { type Client, type Room } from "@colyseus/core";
import {
  CLIENT_MESSAGE,
  OFFICE_LAYOUT,
  type OfficeState,
  RADIO_INTERACTABLE_ID,
  RADIO_REJECTION,
  type RadioRejectedEvent,
  type RadioRejection,
  SERVER_MESSAGE,
  distanceToInteractable,
  interactableById,
  parseRadioTuneMessage,
} from "@sim/shared";

import { SERVER_INTERACT_RANGE } from "../sim/interaction.js";
import type { YoutubeCheck } from "../sim/youtube.js";

/** What the handler needs from the room, named so a test can supply it. */
export interface RadioHandlerHost {
  readonly state: OfficeState;
  /** Charges one tune against the sender's budget; `false` drops it, and the limiter says so. */
  readonly allow: (client: Client) => boolean;
  readonly checkYoutube: YoutubeCheck;
  /** Epoch milliseconds, which every tab measures a video's position against. */
  readonly now: () => number;
}

function refuse(client: Client, rejection: RadioRejection): void {
  client.send(SERVER_MESSAGE.radioRejected, { rejection } satisfies RadioRejectedEvent);
}

export function registerRadioHandlers(room: Pick<Room<OfficeState>, "onMessage">, host: RadioHandlerHost): void {
  const radioSpot = interactableById(OFFICE_LAYOUT, RADIO_INTERACTABLE_ID);

  room.onMessage(CLIENT_MESSAGE.radioTune, async (client, raw: unknown) => {
    const message = parseRadioTuneMessage(raw);
    const sender = host.state.occupants.get(client.sessionId);
    if (message === undefined || sender === undefined || radioSpot === undefined) {
      return;
    }
    if (distanceToInteractable(radioSpot, sender) > SERVER_INTERACT_RANGE) {
      refuse(client, RADIO_REJECTION.outOfRange);
      return;
    }
    if (!host.allow(client)) {
      return;
    }
    const { source } = message;
    let title = "";
    if (source.kind === "youtube") {
      const answer = await host.checkYoutube(source.videoId, source.listId);
      if (answer === undefined || !answer.playable) {
        refuse(client, answer === undefined ? RADIO_REJECTION.unchecked : RADIO_REJECTION.unplayable);
        return;
      }
      title = answer.title;
    }
    const radio = host.state.radio;
    radio.stationId = source.kind === "station" ? source.stationId : "";
    radio.videoId = source.kind === "youtube" ? source.videoId : "";
    radio.listId = source.kind === "youtube" ? source.listId : "";
    radio.title = title;
    radio.startedAt = host.now();
    radio.tunedBy = sender.name;
  });
}
