/**
 * Whether YouTube will play a video or playlist in someone else's page, asked
 * before the radio is tuned to it, so a dead or private link is refused to the
 * one who pasted it and the office keeps hearing what it was.
 *
 * YouTube's oEmbed endpoint answers exactly that, without a key: a title for a
 * link that embeds, 401 or 403 for one that may not, 400 or 404 for one that is
 * not there.
 */

import { clip, replaceControls, youtubeUrl } from "@sim/shared";

/** The subset of `fetch` the check calls, so a test can stand in for it. */
export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export type YoutubeCheck = (videoId: string, listId: string) => Promise<YoutubeAnswer>;

export type YoutubeAnswer =
  | { readonly playable: true; readonly title: string }
  | { readonly playable: false }
  /** YouTube could not be asked, or answered with something else. */
  | undefined;

const CHECK_TIMEOUT_MS = 5000;
/** Longest title kept; YouTube's own limit is 100 characters. */
const MAX_TITLE_LENGTH = 120;

export function youtubeCheck(fetchImpl: FetchLike = fetch): YoutubeCheck {
  return async (videoId, listId) => {
    const url = `https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(youtubeUrl(videoId, listId))}`;
    try {
      const response = await fetchImpl(url, { signal: AbortSignal.timeout(CHECK_TIMEOUT_MS) });
      if (response.ok) {
        const body = (await response.json()) as { title?: unknown };
        return { playable: true, title: typeof body.title === "string" ? clip(replaceControls(body.title, " "), MAX_TITLE_LENGTH) : "" };
      }
      return [400, 401, 403, 404].includes(response.status) ? { playable: false } : undefined;
    } catch {
      return undefined;
    }
  };
}
