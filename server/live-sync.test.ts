import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { Database } from "./database.js";
import { PluginManager } from "./plugin-manager.js";
import { countAudioGaps, DownloadQueue, liveAudioSyncEnabled } from "./downloader.js";
import { LIVE_AUDIO_SYNC_FILTER, recordingEncodingArgs, recordingSyncArgs } from "./output-settings.js";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
const temp = (name: string) => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), `${name}-`)); dirs.push(dir); return dir; };
async function waitFor(check: () => boolean, ms = 20_000) {
  const deadline = Date.now() + ms;
  while (!check()) { if (Date.now() > deadline) throw new Error("Timed out"); await new Promise((resolve) => setTimeout(resolve, 50)); }
}
const probe = (file: string, args: string[]) => execFileSync("ffprobe", ["-v", "error", ...args, "-of", "csv=p=0", file]).toString().trim();
/** Seconds of audio a player that simply plays the samples back to back would hear. */
const playedAudioSeconds = (file: string, dir: string) => {
  const wav = path.join(dir, `${path.basename(file)}.wav`);
  execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-i", file, "-map", "0:a:0", "-f", "wav", "-y", wav]);
  return Number(probe(wav, ["-show_entries", "format=duration"]));
};

/** 12 s of video whose audio drops for one second every four seconds (gaps at 3-4 s and 7-8 s; audio ends at 11 s), like issue #34. */
function recordingWithAudioGaps(dir: string) {
  const file = path.join(dir, "gaps.ts");
  execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc=duration=12:size=160x120:rate=25", "-f", "lavfi", "-i", "sine=frequency=440:duration=12",
    "-filter_complex", "[1:a]aselect='not(between(mod(t,4),3,4))',asetpts=PTS[a]", "-map", "0:v", "-map", "[a]", "-c:v", "mpeg4", "-c:a", "aac", "-f", "mpegts", "-y", file]);
  return file;
}

async function record(sample: string) {
  const root = temp("easyx-live-sync"); const mediaDir = path.join(root, "media"); const pluginDir = path.join(root, "plugins");
  fs.mkdirSync(path.join(pluginDir, "test"), { recursive: true });
  const copy = `require('node:fs').copyFileSync(${JSON.stringify(sample)}, process.argv[1])`;
  fs.writeFileSync(path.join(pluginDir, "test", "index.mjs"), `export default {
    manifest: { id: "test.sync", name: "Sync", version: "1", description: "Test", author: "Test", capabilities: ["media-listing", "download-resolver"], sourceUrlPatterns: ["https://live.test/*"] },
    listMedia: async () => [],
    resolveDownload: async () => ({ kind: "command", command: process.execPath, args: ["-e", ${JSON.stringify(copy)}, "{output}"], filename: "recording.ts" })
  };`);
  const db = new Database(path.join(root, "data")); const plugins = new PluginManager(db, [pluginDir]); await plugins.load(); plugins.install("test.sync");
  const performer = db.createPerformer({ name: "Alice" });
  const added = db.addSource(performer.id, "test.sync", { externalId: "https://live.test/alice", label: "live.test", profileUrl: "https://live.test/alice", domain: "live.test" });
  const source = db.updateSource(added.id, { autoDownload: true })!;
  db.ingestItems(source, [{ externalId: "live:alice#1", title: "Alice live", pageUrl: "https://live.test/alice", mediaType: "video", filename: "alice.ts", metadata: { live: true } }]);
  const logs: Array<{ message: string; details?: unknown }> = [];
  const queue = new DownloadQueue(db, plugins, mediaDir, (_level, _area, message, details) => { logs.push({ message, details }); return undefined as never; });
  queue.start();
  try {
    await waitFor(() => ["completed", "failed"].includes(db.listItems()[0]?.status ?? ""));
    const item = db.listItems()[0];
    return { item, file: item.storagePath ? path.join(mediaDir, item.storagePath) : "", logs, root };
  } finally { queue.stop(); db.close(); }
}

describe("audio/video sync of live recordings (issue #34)", () => {
  it("fills audio gaps so players no longer drift out of sync", async () => {
    const dir = temp("easyx-gap-sample"); const sample = recordingWithAudioGaps(dir);
    // The captured file: a player hears ~9 s of audio for 11 s of audio timeline, so it drifts 2 s.
    expect(playedAudioSeconds(sample, dir)).toBeLessThan(9.5);
    const { item, file, logs } = await record(sample);
    expect(item.status).toBe("completed");
    expect(Number(probe(file, ["-show_entries", "format=duration"]))).toBeGreaterThan(11.5);
    expect(playedAudioSeconds(file, dir)).toBeGreaterThan(10.8); // gaps filled with silence: audio runs to 11 s in sync
    expect(probe(file, ["-select_streams", "v:0", "-show_entries", "stream=codec_name"])).toBe("mpeg4"); // video copied, not re-encoded
    expect(logs.find((entry) => entry.message.startsWith("Repairing audio/video sync"))?.details).toMatchObject({ audioGaps: 2 });
  }, 60_000);

  it("leaves a healthy recording exactly as captured", async () => {
    const dir = temp("easyx-healthy-sample"); const sample = path.join(dir, "healthy.ts");
    execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc=duration=4:size=160x120:rate=25", "-f", "lavfi", "-i", "sine=duration=4",
      "-c:v", "mpeg4", "-c:a", "mp2", "-f", "mpegts", "-y", sample]);
    const { item, file, logs } = await record(sample);
    expect(item.status).toBe("completed");
    expect(fs.readFileSync(file).equals(fs.readFileSync(sample))).toBe(true);
    expect(logs.some((entry) => entry.message.startsWith("Repairing audio/video sync"))).toBe(false);
  }, 60_000);

  it("counts gaps from packet timestamps", () => {
    expect(countAudioGaps("0.000,0.021\n0.021,0.021\n0.042,0.021\n")).toEqual({ count: 0, seconds: 0 });
    const gaps = countAudioGaps("0.000,0.021\n0.021,0.021\n1.042,0.021\n1.063,0.021\n3.000,0.021\n");
    expect(gaps.count).toBe(2);
    expect(gaps.seconds).toBeCloseTo(1 + 1.916, 2);
    expect(countAudioGaps("")).toEqual({ count: 0, seconds: 0 });
  });

  it("can be switched off and is applied when a preset re-encodes", () => {
    expect(liveAudioSyncEnabled(undefined)).toBe(true);
    expect(liveAudioSyncEnabled("false")).toBe(false);
    expect(liveAudioSyncEnabled("0")).toBe(false);
    expect(recordingSyncArgs("in.ts", "out.mp4")).toEqual(expect.arrayContaining(["-c:v", "copy", "-af", LIVE_AUDIO_SYNC_FILTER]));
    expect(recordingEncodingArgs("h264-small", "in.ts", "out.mp4")).toEqual(expect.arrayContaining(["-af", LIVE_AUDIO_SYNC_FILTER]));
  });
});
