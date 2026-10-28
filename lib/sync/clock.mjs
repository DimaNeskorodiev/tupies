/** Hybrid logical clock stamps: fixed-width base36 wall time and counter, then the authoring node, so plain string order is causal order. */
export const GENESIS = '000000000.0000.genesis';
const MAX_FUTURE_MS = 10 * 60_000;

export function parseStamp(value) {
  const match = typeof value === 'string' && value.match(/^([0-9a-z]{9})\.([0-9a-z]{4})\.([a-zA-Z0-9_-]{1,64})$/);
  return match ? { wall: parseInt(match[1], 36), count: parseInt(match[2], 36), node: match[3] } : null;
}
const format = (wall, count, node) => `${wall.toString(36).padStart(9, '0')}.${count.toString(36).padStart(4, '0')}.${node}`;
export const compareStamps = (a, b) => (a === b ? 0 : a > b ? 1 : -1);

export class Clock {
  constructor(node, now = Date.now) { this.node = node; this.clock = now; this.wall = 0; this.count = 0; }
  now() {
    const time = this.clock();
    if (time > this.wall) { this.wall = time; this.count = 0; } else this.count++;
    if (this.count > 1_679_615) { this.wall++; this.count = 0; }
    return format(this.wall, this.count, this.node);
  }
  /** Remote stamps advance this clock so later local edits sort after what was seen, but never by more than a bounded skew. */
  observe(stamp) {
    const remote = parseStamp(stamp);
    if (!remote || remote.wall > this.clock() + MAX_FUTURE_MS) return false;
    if (remote.wall > this.wall) { this.wall = remote.wall; this.count = remote.count; }
    else if (remote.wall === this.wall) this.count = Math.max(this.count, remote.count);
    return true;
  }
  acceptable(stamp) { const remote = parseStamp(stamp); return !!remote && remote.wall <= this.clock() + MAX_FUTURE_MS; }
}
