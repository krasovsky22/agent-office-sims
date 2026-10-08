/**
 * Pathfinding over the layout's waypoint graph.
 *
 * The office is rooms and corridors, so the route an occupant takes is a
 * sequence of doorways and open floor rather than an arbitrary curve. That
 * makes the waypoint graph in {@link OfficeLayout.waypoints} the whole
 * navigation model: a link between two nodes asserts that an occupant can walk
 * the straight line between them, and a path is a list of node ids to visit in
 * order. Nothing here moves a body; steering along the path and resolving
 * contact belong to the caller and to `collision.ts` respectively.
 *
 * Everything in this module is a pure function of its arguments with no
 * module-level mutable state, so the client and the server can both call it,
 * and the server can call it inside its synchronous tick.
 */

import { OCCUPANT_RADIUS } from "./constants.js";
import {
  type Aabb2,
  type OfficeLayout,
  type Vec2,
  type WaypointSpec,
  collisionBoxes,
} from "./layout.js";

/**
 * Keeps a segment test from dividing by a direction component of zero.
 *
 * A segment that does not move on an axis at all is either inside that axis'
 * slab for its whole length or outside it for its whole length, which the
 * caller handles without a division.
 */
const PARALLEL_EPSILON = 1e-9;

/**
 * The route between two world positions, as waypoint ids.
 *
 * `from` and `to` are arbitrary positions — wherever a body happens to be
 * standing and wherever it was told to go — so each is first anchored to the
 * nearest waypoint it can reach in a straight line (see
 * {@link nearestWaypoint}). The returned path starts at `from`'s waypoint and
 * ends at `to`'s waypoint, including both; a caller steers to each node in
 * turn and then walks the last short leg to `to` itself. It may skip the first
 * node when it is already standing on top of it.
 *
 * Both endpoints anchoring to the same waypoint yields a single-element path,
 * which is the usual answer for two positions in the same room. An empty array
 * means there is no route: the goal's side of the graph is not connected to the
 * start's, or the layout has no waypoints at all. Nothing here throws.
 *
 * `radius` is the horizontal radius of the body being routed, used only when
 * anchoring a position to a waypoint.
 */
export function findPath(
  from: Vec2,
  to: Vec2,
  layout: OfficeLayout,
  radius = OCCUPANT_RADIUS,
): string[] {
  const start = nearestWaypoint(from, layout, radius);
  if (start === undefined) {
    return [];
  }
  const goal = nearestWaypoint(to, layout, radius);
  if (goal === undefined) {
    return [];
  }
  return findWaypointPath(start.id, goal.id, layout);
}

/**
 * The shortest route between two waypoints, as ids, inclusive of both ends.
 *
 * Breadth-first rather than A*: at this graph size the search is free either
 * way, and the links of a room-and-corridor plan are short hops between
 * adjacent doorways and open floor, so the fewest-hops route is the route a
 * person would walk. A* would buy a distance-weighted answer at the cost of a
 * priority queue and a heuristic to keep admissible, which is complexity with
 * nothing to spend it on yet.
 *
 * Neighbours are visited in the order the layout declares them, so the chosen
 * route among equally short ones is stable. An unknown id, or a goal in a
 * disconnected part of the graph, returns an empty array.
 */
export function findWaypointPath(fromId: string, toId: string, layout: OfficeLayout): string[] {
  const nodes = new Map<string, WaypointSpec>();
  for (const node of layout.waypoints) {
    nodes.set(node.id, node);
  }
  if (!nodes.has(fromId) || !nodes.has(toId)) {
    return [];
  }
  if (fromId === toId) {
    return [fromId];
  }

  // Keyed by node id, so a node is enqueued at most once and the first route
  // that reaches it is one of the shortest.
  const arrivedFrom = new Map<string, string>();
  arrivedFrom.set(fromId, fromId);
  const queue: string[] = [fromId];

  for (let head = 0; head < queue.length; head += 1) {
    const currentId = queue[head];
    if (currentId === undefined) {
      continue;
    }
    for (const linkId of nodes.get(currentId)?.links ?? []) {
      // A link to an id that no longer exists is a layout defect that
      // `describeLayoutProblems` reports; here it is simply not a route.
      if (!nodes.has(linkId) || arrivedFrom.has(linkId)) {
        continue;
      }
      arrivedFrom.set(linkId, currentId);
      if (linkId === toId) {
        return tracePath(arrivedFrom, fromId, toId);
      }
      queue.push(linkId);
    }
  }

  return [];
}

/** Walks the arrival links back from the goal and returns them start-first. */
function tracePath(arrivedFrom: Map<string, string>, fromId: string, toId: string): string[] {
  const path = [toId];
  let currentId = toId;
  while (currentId !== fromId) {
    const previousId = arrivedFrom.get(currentId);
    if (previousId === undefined) {
      // Unreachable: every id in the map was given an arrival before it was
      // enqueued, and `fromId` terminates the walk.
      return [];
    }
    path.push(previousId);
    currentId = previousId;
  }
  return path.reverse();
}

/**
 * The waypoint a body at `position` should enter the graph through.
 *
 * Plain nearest-by-distance is wrong across a wall: a body in the bullpen just
 * south of the divider is metres from a waypoint in the CEO office it would
 * have to walk through a wall to use. So nodes the body can reach in a
 * straight line are preferred, and the nearest of those wins.
 *
 * When no node is reachable the nearest one is returned anyway. A body is
 * never inside an obstacle, so this only happens when it is wedged somewhere
 * the straight-line test is too conservative about — see
 * {@link segmentHitsBox} — and returning a node there leaves the caller with a
 * route to steer rather than no route at all. `undefined` means the layout has
 * no waypoints.
 */
export function nearestWaypoint(
  position: Vec2,
  layout: OfficeLayout,
  radius = OCCUPANT_RADIUS,
): WaypointSpec | undefined {
  const boxes = collisionBoxes(layout);
  let nearest: WaypointSpec | undefined;
  let nearestDistanceSq = Number.POSITIVE_INFINITY;
  let reachable: WaypointSpec | undefined;
  let reachableDistanceSq = Number.POSITIVE_INFINITY;

  for (const node of layout.waypoints) {
    const dx = node.x - position.x;
    const dz = node.z - position.z;
    const distanceSq = dx * dx + dz * dz;
    if (distanceSq < nearestDistanceSq) {
      nearest = node;
      nearestDistanceSq = distanceSq;
    }
    if (distanceSq < reachableDistanceSq && hasClearLine(position, node, radius, boxes)) {
      reachable = node;
      reachableDistanceSq = distanceSq;
    }
  }

  return reachable ?? nearest;
}

/** Whether a body of `radius` can walk the straight line from `a` to `b`. */
function hasClearLine(a: Vec2, b: Vec2, radius: number, boxes: readonly Aabb2[]): boolean {
  for (let i = 0; i < boxes.length; i += 1) {
    const box = boxes[i];
    if (box === undefined) {
      continue;
    }
    if (segmentHitsBox(a, b, box, radius)) {
      return false;
    }
  }
  return true;
}

/**
 * Whether the segment `a`-`b` comes within `radius` of a box.
 *
 * The body's radius is absorbed by growing the box, which turns a swept circle
 * into a plain segment test. Growing an axis-aligned box squares off what
 * should be rounded corners, so a line that clips a corner diagonally reads as
 * blocked slightly before it truly is — the same conservative approximation
 * `describeLayoutProblems` uses when it checks spawn points, and in the safe
 * direction for a navigation anchor.
 */
function segmentHitsBox(a: Vec2, b: Vec2, box: Aabb2, radius: number): boolean {
  let entry = 0;
  let exit = 1;

  // The segment overlaps the grown box exactly when it is inside both of the
  // box's slabs at once, so intersect the parameter range of each.
  const slabs: readonly [number, number, number, number][] = [
    [a.x, b.x - a.x, box.minX - radius, box.maxX + radius],
    [a.z, b.z - a.z, box.minZ - radius, box.maxZ + radius],
  ];
  for (const [origin, direction, min, max] of slabs) {
    if (Math.abs(direction) < PARALLEL_EPSILON) {
      if (origin <= min || origin >= max) {
        return false;
      }
      continue;
    }
    const near = (min - origin) / direction;
    const far = (max - origin) / direction;
    entry = Math.max(entry, Math.min(near, far));
    exit = Math.min(exit, Math.max(near, far));
    if (entry >= exit) {
      return false;
    }
  }

  return true;
}
