/**
 * Succession is an acceptance criterion — exactly one CEO, never two and never
 * none — so its rules get tests of their own, apart from the live-room ones in
 * `OfficeRoom.test.ts`.
 */

import { MapSchema } from "@colyseus/schema";
import { HumanPlayer, OCCUPANT_KIND, type Occupant, PLAYER_ROLE, type PlayerRole } from "@sim/shared";
import { describe, expect, it } from "vitest";

import { appointSuccessor, describeRoleProblems, findCeo, roleForArrival, takeCeoRole } from "./roles.js";

function player(id: string, role: PlayerRole): HumanPlayer {
  const occupant = new HumanPlayer();
  occupant.id = id;
  occupant.kind = OCCUPANT_KIND.human;
  occupant.role = role;
  return occupant;
}

function office(...players: HumanPlayer[]): MapSchema<Occupant> {
  const occupants = new MapSchema<Occupant>();
  for (const occupant of players) {
    occupants.set(occupant.id, occupant);
  }
  return occupants;
}

describe("roleForArrival", () => {
  it("makes the first arrival CEO and the rest executives", () => {
    expect(roleForArrival(office())).toBe(PLAYER_ROLE.ceo);
    expect(roleForArrival(office(player("dana", PLAYER_ROLE.ceo)))).toBe(PLAYER_ROLE.exec);
  });
});

describe("appointSuccessor", () => {
  const joined: Record<string, number> = { milo: 200, ines: 100, theo: 300 };
  const joinedAtOf = (id: string) => joined[id];
  const noneHeld = () => false;

  it("promotes exactly the longest-connected player", () => {
    const occupants = office(
      player("milo", PLAYER_ROLE.exec),
      player("ines", PLAYER_ROLE.exec),
      player("theo", PLAYER_ROLE.exec),
    );

    expect(appointSuccessor(occupants, joinedAtOf, noneHeld)?.id).toBe("ines");
    expect(findCeo(occupants)?.id).toBe("ines");
    expect(describeRoleProblems(occupants)).toEqual([]);
  });

  it("does nothing while someone still holds the role", () => {
    const occupants = office(player("milo", PLAYER_ROLE.ceo), player("ines", PLAYER_ROLE.exec));

    expect(appointSuccessor(occupants, joinedAtOf, noneHeld)).toBeUndefined();
    expect(findCeo(occupants)?.id).toBe("milo");
  });

  it("ranks a player with no known join time last, not first", () => {
    const occupants = office(player("ghost", PLAYER_ROLE.exec), player("theo", PLAYER_ROLE.exec));

    expect(appointSuccessor(occupants, joinedAtOf, noneHeld)?.id).toBe("theo");
  });

  it("still appoints someone when nobody's join time is known", () => {
    const occupants = office(player("ghost", PLAYER_ROLE.exec));

    expect(appointSuccessor(occupants, () => undefined, noneHeld)?.id).toBe("ghost");
    expect(describeRoleProblems(occupants)).toEqual([]);
  });

  it("passes over a dropped player for anyone still connected", () => {
    const occupants = office(
      player("milo", PLAYER_ROLE.exec),
      player("ines", PLAYER_ROLE.exec),
      player("theo", PLAYER_ROLE.exec),
    );

    expect(appointSuccessor(occupants, joinedAtOf, (id) => id === "ines")?.id).toBe("milo");
    expect(describeRoleProblems(occupants)).toEqual([]);
  });

  it("falls back to a dropped player when nobody connected is left", () => {
    const occupants = office(player("milo", PLAYER_ROLE.exec), player("theo", PLAYER_ROLE.exec));

    expect(appointSuccessor(occupants, joinedAtOf, () => true)?.id).toBe("milo");
    expect(describeRoleProblems(occupants)).toEqual([]);
  });

  it("appoints nobody in an empty office", () => {
    expect(appointSuccessor(office(), joinedAtOf, noneHeld)).toBeUndefined();
  });
});

describe("describeRoleProblems", () => {
  it("flags two CEOs, and players with none", () => {
    expect(
      describeRoleProblems(office(player("a", PLAYER_ROLE.ceo), player("b", PLAYER_ROLE.ceo))),
    ).toHaveLength(1);
    expect(describeRoleProblems(office(player("a", PLAYER_ROLE.exec)))).toHaveLength(1);
    expect(describeRoleProblems(office())).toEqual([]);
  });
});

describe("takeCeoRole", () => {
  it("hands the role to the operator and keeps its holder as an executive", () => {
    const dana = player("dana", PLAYER_ROLE.ceo);
    const ines = player("ines", PLAYER_ROLE.exec);
    const occupants = office(dana, ines);

    expect(takeCeoRole(occupants, ines)?.id).toBe("dana");
    expect(findCeo(occupants)?.id).toBe("ines");
    expect(dana.role).toBe(PLAYER_ROLE.exec);
    expect(describeRoleProblems(occupants)).toEqual([]);
  });

  it("changes nothing for a player who already holds it", () => {
    const dana = player("dana", PLAYER_ROLE.ceo);
    const occupants = office(dana, player("ines", PLAYER_ROLE.exec));

    expect(takeCeoRole(occupants, dana)).toBeUndefined();
    expect(findCeo(occupants)?.id).toBe("dana");
    expect(describeRoleProblems(occupants)).toEqual([]);
  });
});
