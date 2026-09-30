/**
 * Hybrid logical clock (HLC): design.md, "Field-level change protocol". Combines a device's
 * own wall clock with a logical counter so any two changes have a total, deterministic order,
 * even across devices whose clocks disagree or briefly run backward. "Last write wins"
 * compares two HLCs only, never a field's own value, so conflict resolution works the same way
 * in an encrypted workspace, where the server cannot see the value at all.
 */

export interface Hlc {
  /** Milliseconds since epoch, from the device's own wall clock. */
  readonly physical: number;
  /** Ticks within the same `physical` millisecond, reset whenever it advances. */
  readonly counter: number;
  /** Breaks a tie when two devices produce the same (physical, counter) pair. */
  readonly deviceId: string;
}

/**
 * The next HLC for a new change on this device: always compares greater than both
 * `physicalNow` and `previous` (the last HLC this device has produced or seen, from itself or
 * a remote), even when `physicalNow` is behind `previous.physical` — a clock that runs slow,
 * or briefly goes backward. The classic HLC "tick" (Kulkarni et al.).
 */
export function nextHlc(physicalNow: number, previous: Hlc | undefined, deviceId: string): Hlc {
  if (!previous || physicalNow > previous.physical) {
    return { physical: physicalNow, counter: 0, deviceId };
  }
  return { physical: previous.physical, counter: previous.counter + 1, deviceId };
}

/** Total order across devices: physical time, then the logical counter, then device id as the final tiebreaker. */
export function compareHlc(a: Hlc, b: Hlc): -1 | 0 | 1 {
  if (a.physical !== b.physical) {
    return a.physical < b.physical ? -1 : 1;
  }
  if (a.counter !== b.counter) {
    return a.counter < b.counter ? -1 : 1;
  }
  if (a.deviceId !== b.deviceId) {
    return a.deviceId < b.deviceId ? -1 : 1;
  }
  return 0;
}
