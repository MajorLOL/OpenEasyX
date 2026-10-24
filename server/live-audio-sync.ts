/** Disable automatic audio repair while retaining the captured source. */
export function liveAudioSyncEnabled(value = process.env.EASYX_LIVE_AUDIO_SYNC) {
  return !/^(?:0|false|no|off)$/i.test(value?.trim() ?? "");
}

/** Incremental timestamp/sample-duration analysis; memory stays constant for long recordings. */
export class AudioGapCounter {
  private expected?: number;
  private count = 0;
  private seconds = 0;
  constructor(private tolerance = 0.1) {}
  add(line: string) {
    const [rawPts, rawDuration] = line.split(",");
    if (!rawPts?.trim()) return;
    const pts = Number(rawPts), duration = Number(rawDuration);
    if (!Number.isFinite(pts)) return;
    if (this.expected !== undefined && pts - this.expected > this.tolerance) {
      this.count += 1; this.seconds += pts - this.expected;
    }
    const end = pts + (Number.isFinite(duration) && duration > 0 ? duration : 0);
    this.expected = this.expected === undefined ? end : Math.max(this.expected, end);
  }
  result() { return { count: this.count, seconds: this.seconds }; }
}

export function countAudioGaps(packets: string, tolerance = 0.1) {
  const counter = new AudioGapCounter(tolerance);
  for (const line of packets.split(/\r?\n/)) counter.add(line);
  return counter.result();
}
