/** What the HUD says when the office server turns a join away. */

import { ErrorCode, MatchMakeError } from "colyseus.js";
import { describe, expect, it } from "vitest";

import { describeError, isOfficeFull } from "./room.js";

describe("isOfficeFull", () => {
  it("recognises a join the office has no seat for", () => {
    const refused = new MatchMakeError("no rooms found with provided criteria", ErrorCode.MATCHMAKE_INVALID_CRITERIA);
    expect(isOfficeFull(refused)).toBe(true);
  });

  it("leaves any other matchmaking error alone", () => {
    const error = new MatchMakeError("invalid method", ErrorCode.MATCHMAKE_NO_HANDLER);
    expect(isOfficeFull(error)).toBe(false);
    expect(describeError(error)).toBe("invalid method");
  });
});
