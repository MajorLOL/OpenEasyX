import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { Database } from "./database.js";
import { PluginManager } from "./plugin-manager.js";
import { DownloadQueue } from "./downloader.js";
import { countAudioGaps, liveAudioSyncEnabled } from "./live-audio-sync.js";
import { LIVE_AUDIO_SYNC_FILTER, recordingEncodingArgs, recordingSyncArgs } from "./output-settings.js";
import type { RecordingPreset } from "../packages/output-settings.js";

const dirs: string[] = [];
afterEach(() => { vi.unstubAllEnvs(); for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
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
  const part = path.join(dir, "burst.ts");
  // Three 4-second video stretches, each with only 3 seconds of audio.
  // Joining with stream copy creates real packet gaps on FFmpeg 5 and 8.
  execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc2=duration=4:size=160x120:rate=25", "-f", "lavfi", "-i", "sine=frequency=440:duration=3",
    "-c:v", "mpeg4", "-c:a", "aac", "-f", "mpegts", "-y", part]);
  const list = path.join(dir, "bursts.txt");
  fs.writeFileSync(list, "file 'burst.ts'\nduration 4\n".repeat(3));
  execFileSync("ffmpeg", ["-v", "error", "-f", "concat", "-safe", "0", "-i", list, "-c", "copy", "-y", file]);
  return file;
}

async function record(sample: string, preset: RecordingPreset = "source", recover = false, action?: "cancel" | "delete") {
  const root = temp("easyx-live-sync"); const mediaDir = path.join(root, "media"); const pluginDir = path.join(root, "plugins");
  fs.mkdirSync(path.join(pluginDir, "test"), { recursive: true });
  const copy = `require('node:fs').copyFileSync(${JSON.stringify(sample)}, process.argv[1])`;
  fs.writeFileSync(path.join(pluginDir, "test", "index.mjs"), `export default {
    manifest: { id: "test.sync", name: "Sync", version: "1", description: "Test", author: "Test", capabilities: ["media-listing", "download-resolver"], sourceUrlPatterns: ["https://live.test/*"] },
    listMedia: async () => [],
    resolveDownload: async () => ({ kind: "command", command: process.execPath, args: ["-e", ${JSON.stringify(copy)}, "{output}"], filename: ${JSON.stringify("recording" + path.extname(sample))} })
  };`);
  const db = new Database(path.join(root, "data")); const plugins = new PluginManager(db, [pluginDir]); await plugins.load(); plugins.install("test.sync");
  const performer = db.createPerformer({ name: "Alice" });
  const added = db.addSource(performer.id, "test.sync", { externalId: "https://live.test/alice", label: "live.test", profileUrl: "https://live.test/alice", domain: "live.test" });
  const source = db.updateSource(added.id, { autoDownload: true })!;
  db.updateSettings({ recordingPreset: preset });
  db.ingestItems(source, [{ externalId: "live:alice#1", title: "Alice live", pageUrl: "https://live.test/alice", mediaType: "video", filename: "alice" + path.extname(sample), metadata: { live: true } }]);
  const logs: Array<{ message: string; details?: unknown }> = [];
  const queue = new DownloadQueue(db, plugins, mediaDir, (_level, _area, message, details) => {
    logs.push({ message, details });
    if (action && message.startsWith("Repairing audio/video sync")) queue[action](db.listItems()[0].id);
    return undefined as never;
  });
  if (recover) {
    const item = db.listItems()[0];
    db.setItemStatus(item.id, "downloading");
    const parts = path.join(mediaDir, ".downloads", item.id, "live-parts");
    fs.mkdirSync(parts, { recursive: true });
    fs.copyFileSync(sample, path.join(parts, "part-001.ts"));
  }
  await queue.start();
  try {
    await waitFor(() => ["completed", "failed", "cancelled"].includes(db.listItems()[0]?.status ?? "") || !db.listItems().length);
    const item = db.listItems()[0];
    return { item, file: item.storagePath ? path.join(mediaDir, item.storagePath) : "", logs, root };
  } finally { queue.stop(); db.close(); }
}

describe("audio/video sync of live recordings (issue #34)", () => {
  it("detects audio gaps after the live recorder has already remuxed them into MP4", async () => {
    const dir = temp("easyx-gap-mp4"); const sample = recordingWithAudioGaps(dir);
    const mp4 = path.join(dir, "gaps.mp4");
    execFileSync("ffmpeg", ["-v", "error", "-i", sample, "-c", "copy", "-y", mp4]);
    const result = await record(mp4);
    expect(result.item.status).toBe("completed");
    expect(playedAudioSeconds(result.file, dir)).toBeGreaterThan(10.8);
    expect(result.logs.some((entry) => entry.message.startsWith("Repairing audio/video sync"))).toBe(true);
  }, 30_000);

  it.each(["h264-high", "h264-small", "h265"] as const)("keeps audio synchronized with the %s preset", async (preset) => {
    const dir = temp("easyx-gap-preset"); const sample = recordingWithAudioGaps(dir);
    const result = await record(sample, preset);
    expect(result.item.status, result.item.error).toBe("completed");
    expect(playedAudioSeconds(result.file, dir)).toBeGreaterThan(10.8);
    expect(result.item.storagePath).toMatch(/\.mp4$/);
  }, 30_000);

  it("repairs audio gaps when recovering a recording after an interrupted shutdown", async () => {
    const dir = temp("easyx-gap-recovery"); const sample = recordingWithAudioGaps(dir);
    const result = await record(sample, "source", true);
    expect(result.item.status, result.item.error).toBe("completed");
    expect(playedAudioSeconds(result.file, dir)).toBeGreaterThan(10.8);
    expect(result.logs.some((entry) => entry.message.includes("interrupted by a restart was saved"))).toBe(true);
  }, 30_000);

  it("keeps the captured bytes when automatic sync is disabled", async () => {
    const dir = temp("easyx-gap-disabled"); const sample = recordingWithAudioGaps(dir);
    vi.stubEnv("EASYX_LIVE_AUDIO_SYNC", "false");
    const result = await record(sample);
    expect(result.item.status).toBe("completed");
    expect(fs.readFileSync(result.file)).toEqual(fs.readFileSync(sample));
    expect(recordingEncodingArgs("h264-high", "in.ts", "out.mp4")).not.toContain("-af");
  }, 30_000);

  it("keeps a video-only recording without inventing an audio track", async () => {
    const dir = temp("easyx-no-audio"); const sample = path.join(dir, "silent.ts");
    execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "testsrc2=duration=1:size=64x64:rate=10", "-c:v", "libx264", "-y", sample]);
    const result = await record(sample);
    expect(result.item.status).toBe("completed");
    expect(fs.readFileSync(result.file)).toEqual(fs.readFileSync(sample));
    expect(result.logs.some((entry) => entry.message.includes("sync repair skipped"))).toBe(false);
  }, 30_000);

  it("keeps the captured file and logs the reason if audio analysis fails", async () => {
    const dir = temp("easyx-invalid-probe"); const sample = path.join(dir, "captured.ts");
    fs.writeFileSync(sample, "captured bytes");
    const result = await record(sample);
    expect(result.item.status).toBe("completed");
    expect(fs.readFileSync(result.file)).toEqual(fs.readFileSync(sample));
    expect(result.logs.some((entry) => entry.message.includes("sync repair skipped"))).toBe(true);
  }, 30_000);

  it("does not publish a recording cancelled just before audio repair starts", async () => {
    const dir = temp("easyx-gap-cancelled"); const sample = recordingWithAudioGaps(dir);
    const result = await record(sample, "source", false, "cancel");
    expect(result.item.status).toBe("cancelled");
    expect(result.item.storagePath).toBeUndefined();
  }, 30_000);

  it("fills audio gaps so players no longer drift out of sync", async () => {
    const dir = temp("easyx-gap-sample"); const sample = recordingWithAudioGaps(dir);
    // The captured file: a player hears ~9 s of audio for 11 s of audio timeline, so it drifts 2 s.
    expect(playedAudioSeconds(sample, dir)).toBeLessThan(9.5);
    const { item, file, logs } = await record(sample);
    expect(item.status).toBe("completed");
    expect(Number(probe(file, ["-show_entries", "format=duration"]))).toBeGreaterThan(11.5);
    expect(playedAudioSeconds(file, dir)).toBeGreaterThan(10.8); // gaps filled with silence: audio runs to 11 s in sync
    expect(new Set(probe(file, ["-select_streams", "v:0", "-show_entries", "stream=codec_name"]).split(/\s+/))).toEqual(new Set(["mpeg4"]));
    const videoHash = (input: string) => execFileSync("ffmpeg", ["-v", "error", "-i", input, "-map", "0:v:0", "-c", "copy", "-f", "hash", "-hash", "sha256", "-"], { encoding: "utf8" }).trim();
    expect(videoHash(file)).toBe(videoHash(sample));
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
    expect(countAudioGaps("\nN/A,N/A\n0.000,0.021\n\n0.021,0.021\n")).toEqual({ count: 0, seconds: 0 });
    expect(countAudioGaps("-0.021,0.021\n0.000,0.021\n0.021,0.021\n")).toEqual({ count: 0, seconds: 0 });
  });

  it("can be switched off and is applied when a preset re-encodes", () => {
    expect(liveAudioSyncEnabled(undefined)).toBe(true);
    expect(liveAudioSyncEnabled("false")).toBe(false);
    expect(liveAudioSyncEnabled("0")).toBe(false);
    expect(recordingSyncArgs("in.ts", "out.mp4")).toEqual(expect.arrayContaining(["-c:v", "copy", "-af", LIVE_AUDIO_SYNC_FILTER]));
    expect(recordingEncodingArgs("h264-small", "in.ts", "out.mp4")).toEqual(expect.arrayContaining(["-af", LIVE_AUDIO_SYNC_FILTER]));
  });
});
