import { describe, expect, it } from "vitest";

import { MAX_NAME_LENGTH } from "./messages.js";
import { NAME_REJECTION, type NamedOccupant, arrivalName, nameRefusal } from "./playerName.js";
import { OCCUPANT_KIND } from "./state.js";

const OFFICE: readonly NamedOccupant[] = [
  { name: "AI Manager", kind: OCCUPANT_KIND.manager },
  { name: "Concierge", kind: OCCUPANT_KIND.concierge },
  { name: "Lena", kind: OCCUPANT_KIND.liveAgent },
  { name: "Dana", kind: OCCUPANT_KIND.human },
];

describe("nameRefusal", () => {
  it("refuses a player's name, ignoring case, and the manager's, the concierge's and an agent's", () => {
    expect(nameRefusal("dana", OFFICE)).toBe(NAME_REJECTION.taken);
    expect(nameRefusal("AI MANAGER", OFFICE)).toBe(NAME_REJECTION.reserved);
    expect(nameRefusal("Concierge", OFFICE)).toBe(NAME_REJECTION.reserved);
    expect(nameRefusal("Lena", OFFICE)).toBe(NAME_REJECTION.reserved);
    expect(nameRefusal("Maya", OFFICE)).toBeUndefined();
  });
});

describe("arrivalName", () => {
  it("keeps a free name", () => {
    expect(arrivalName("Maya", "Guest 5", OFFICE)).toBe("Maya");
  });

  it("numbers a name another player has, past every variant taken too", () => {
    expect(arrivalName("Dana", "Guest 5", OFFICE)).toBe("Dana 2");
    expect(arrivalName("Dana", "Guest 5", [...OFFICE, { name: "Dana 2", kind: OCCUPANT_KIND.human }])).toBe("Dana 3");
  });

  it("falls back to the generated name for no name and for one the manager, concierge or an agent has", () => {
    expect(arrivalName(undefined, "Guest 5", OFFICE)).toBe("Guest 5");
    expect(arrivalName("AI Manager", "Guest 5", OFFICE)).toBe("Guest 5");
    expect(arrivalName("lena", "Guest 5", [...OFFICE, { name: "Guest 5", kind: OCCUPANT_KIND.human }])).toBe("Guest 5 2");
  });

  it("keeps a numbered variant of a full-length name to the nameplate's length", () => {
    const long = "x".repeat(MAX_NAME_LENGTH);
    const named = arrivalName(long, "Guest 5", [{ name: long, kind: OCCUPANT_KIND.human }]);
    expect(named).toBe(`${"x".repeat(MAX_NAME_LENGTH - 2)} 2`);
  });
});
