/** What the HUD says when the office server turns a join away. */

import { ErrorCode, MatchMakeError } from "colyseus.js";
import { describe, expect, it } from "vitest";

import { describeError } from "./room.js";

describe("describeError", () => {
  it("says the office is full when the join finds no seat", () => {
    const refused = new MatchMakeError("no rooms found with provided criteria", ErrorCode.MATCHMAKE_INVALID_CRITERIA);
    expect(describeError(refused)).toBe("The office is full (16 people)");
  });

  it("passes any other matchmaking error through", () => {
    expect(describeError(new MatchMakeError("invalid method", ErrorCode.MATCHMAKE_NO_HANDLER))).toBe("invalid method");
  });
});
