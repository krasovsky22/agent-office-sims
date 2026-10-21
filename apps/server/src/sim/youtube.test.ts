/** Asking YouTube's oEmbed endpoint whether the radio may play a link. */

import { describe, expect, it } from "vitest";

import { youtubeCheck } from "./youtube.js";

const answering = (status: number, body: unknown = {}) => () => Promise.resolve(new Response(JSON.stringify(body), { status }));

describe("youtubeCheck", () => {
  it("takes a link that embeds, with its title cleaned", async () => {
    let asked = "";
    const check = youtubeCheck((url) => {
      asked = url;
      return answering(200, { title: "Lo-fi\u0007 beats" })();
    });
    expect(await check("dQw4w9WgXcQ", "")).toEqual({ playable: true, title: "Lo-fi  beats" });
    expect(asked).toBe("https://www.youtube.com/oembed?format=json&url=https%3A%2F%2Fwww.youtube.com%2Fwatch%3Fv%3DdQw4w9WgXcQ");
  });

  it.each([400, 401, 403, 404])("refuses a link YouTube answers %i for", async (status) => {
    expect(await youtubeCheck(answering(status))("dQw4w9WgXcQ", "")).toEqual({ playable: false });
  });

  it("cannot say for an outage or a network failure", async () => {
    expect(await youtubeCheck(answering(503))("dQw4w9WgXcQ", "")).toBeUndefined();
    expect(await youtubeCheck(() => Promise.reject(new Error("offline")))("dQw4w9WgXcQ", "")).toBeUndefined();
  });
});
