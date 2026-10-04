/**
 * Who is holding which interactable.
 *
 * The authoritative answer to "is that chair taken?" lives here, on the server,
 * and nowhere else. Clients are told the answer through each occupant's
 * replicated `interactableId`, but they are never asked for it: occupancy is
 * exactly the kind of check a modified client would skip.
 *
 * Two maps rather than one, because both directions are hot. The room asks
 * "what is this session holding?" every tick to decide whether a hold has run
 * out, and "who holds this id?" on every interact message. Deriving either from
 * the other would mean a scan.
 */

import type { InteractableSpec } from "@sim/shared";
import { holdMsFor } from "@sim/shared";

export interface Hold {
  readonly interactableId: string;
  /**
   * Room clock time this hold ends on its own.
   *
   * `Number.POSITIVE_INFINITY` for a hold with no duration, such as a seat: it
   * lasts until the occupant releases it or leaves. Comparing against a number
   * is what keeps the expiry check inside the simulation tick synchronous.
   */
  readonly endsAt: number;
}

export class HoldRegistry {
  private readonly bySession = new Map<string, Hold>();
  private readonly byInteractable = new Map<string, string>();

  /** The session holding an interactable, or `undefined` if it is free. */
  public holderOf(interactableId: string): string | undefined {
    return this.byInteractable.get(interactableId);
  }

  /** What a session is holding, or `undefined` if it is free. */
  public heldBy(sessionId: string): Hold | undefined {
    return this.bySession.get(sessionId);
  }

  /**
   * Records a session taking an interactable.
   *
   * The caller is expected to have authorised it first — this class enforces
   * nothing, it only remembers. Any hold the session already had is dropped, so
   * one session can never appear in two places.
   */
  public take(sessionId: string, spec: InteractableSpec, now: number): Hold {
    this.release(sessionId);
    const duration = holdMsFor(spec);
    const hold: Hold = {
      interactableId: spec.id,
      endsAt: duration <= 0 ? Number.POSITIVE_INFINITY : now + duration,
    };
    this.bySession.set(sessionId, hold);
    this.byInteractable.set(spec.id, sessionId);
    return hold;
  }

  /** Frees whatever a session was holding. Safe to call on a free session. */
  public release(sessionId: string): void {
    const existing = this.bySession.get(sessionId);
    if (existing === undefined) {
      return;
    }
    this.bySession.delete(sessionId);
    // Only clear the reverse entry if it still points at this session, so a
    // stale release cannot evict whoever took the anchor afterwards.
    if (this.byInteractable.get(existing.interactableId) === sessionId) {
      this.byInteractable.delete(existing.interactableId);
    }
  }
}
