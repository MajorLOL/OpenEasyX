import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Database } from "./database.js";
import { PluginManager } from "./plugin-manager.js";
import { DownloadQueue } from "./downloader.js";
import { LiveCamService } from "./live-cams.js";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
const temp = (name: string) => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), `${name}-`)); dirs.push(dir); return dir; };
async function waitFor(check: () => boolean, ms = 15_000) {
  const deadline = Date.now() + ms;
  while (!check()) { if (Date.now() > deadline) throw new Error("Timed out"); await new Promise((resolve) => setTimeout(resolve, 25)); }
}

async function setup() {
  const dataDir = temp("easyx-prio-data"); const mediaDir = temp("easyx-prio-media"); const pluginDir = temp("easyx-prio-plugins");
  const packageDir = path.join(pluginDir, "test"); fs.mkdirSync(packageDir);
  const recorder = "const fs=require('node:fs'),file=process.argv[1];fs.writeFileSync(file,'start');const timer=setInterval(()=>fs.appendFileSync(file,'x'),25);process.on('SIGINT',()=>{clearInterval(timer);process.exit(0)})";
  fs.writeFileSync(path.join(packageDir, "index.mjs"), `export default {
    manifest: { id: "test.prio", name: "Prio", version: "1", description: "Test", author: "Test", capabilities: ["live-cam", "download-resolver"], sourceUrlPatterns: ["https://live.test/*"] },
    listLiveCams: async () => ({ cams: [], total: 0, page: 1, pageSize: 24, pages: 1 }),
    resolveLiveStream: async () => ({ url: "https://cdn.test/live.m3u8" }),
    resolveDownload: async () => ({ kind: "command", command: process.execPath, args: ["-e", ${JSON.stringify(recorder)}, "{output}"], filename: "recording.mp4" })
  };`);
  const db = new Database(dataDir); const manager = new PluginManager(db, [pluginDir]); await manager.load(); manager.install("test.prio");
  db.updateSettings({ maxConcurrentDownloads: 1 });
  const logs: Array<{ message: string; details?: unknown }> = [];
  const queue = new DownloadQueue(db, manager, mediaDir, (_level, _scope, message, details) => { logs.push({ message, details }); });
  const service = new LiveCamService(db, manager);
  const record = (name: string, priority?: number) => {
    const { itemId } = service.record("test.prio", { id: name, username: name, pageUrl: `https://live.test/${name}` });
    if (priority !== undefined) db.setPerformerPriority(db.getItem(itemId)!.performerId, priority);
    return itemId;
  };
  const staged = (itemId: string) => path.join(mediaDir, ".downloads", itemId, "recording.mp4");
  const recording = (itemId: string) => fs.existsSync(staged(itemId)) && fs.statSync(staged(itemId)).size > 5;
  return { db, queue, record, logs, recording };
}

describe("performer recording priority", () => {
  it("stores a clamped priority on the performer", async () => {
    const { db, record } = await setup();
    try {
      const performerId = db.getItem(record("alice"))!.performerId;
      expect(db.getPerformer(performerId)?.priority).toBe(0);
      expect(db.setPerformerPriority(performerId, 5)?.priority).toBe(1);
      expect(db.setPerformerPriority(performerId, -9)?.priority).toBe(-1);
    } finally { db.close(); }
  });

  it("starts the highest priority first when several recordings are queued", async () => {
    const { db, record } = await setup();
    try {
      const low = record("low", -1); const normal = record("normal"); const high = record("high", 1);
      expect(db.nextQueued()?.id).toBe(high);
      db.setItemStatus(high, "downloading");
      expect(db.nextQueued()?.id).toBe(normal);
      db.setItemStatus(normal, "downloading");
      expect(db.nextQueued()?.id).toBe(low);
    } finally { db.close(); }
  });

  it("stops a lower-priority live recording when a high-priority one has to wait for a slot", { timeout: 60_000 }, async () => {
    const { db, queue, record, logs, recording } = await setup();
    queue.start();
    try {
      const bob = record("bob");
      await waitFor(() => recording(bob));
      const alice = record("alice", 1);
      await waitFor(() => db.getItem(alice)?.status === "downloading");
      await waitFor(() => db.getItem(bob)?.status === "completed");
      expect(db.getItem(bob)?.storagePath).toBeTruthy();
      expect(logs.some((log) => log.message === "Recording stopped for a higher-priority performer")).toBe(true);
      // The stopped room is not treated as stopped by the user: a new session is allowed.
      const bobItem = db.getItem(bob)!;
      const source = db.getSource(bobItem.sourceId)!;
      const next = db.liveScanCandidates(source, [{ externalId: "bob-live", pageUrl: "https://live.test/bob", mediaType: "video", metadata: { live: true } }], Date.now() + 20 * 60_000);
      expect(next).toHaveLength(1);
      await waitFor(() => recording(alice));
      queue.stopRecording(alice);
      await waitFor(() => !["downloading", "stopping"].includes(db.getItem(alice)?.status ?? ""));
      expect(db.getItem(alice)?.status, String(db.getItem(alice)?.error)).toBe("completed");
    } finally { queue.stop(); db.close(); }
  });

  it("does not stop a recording for an equal or lower priority", { timeout: 60_000 }, async () => {
    const { db, queue, record, recording } = await setup();
    queue.start();
    try {
      const bob = record("bob");
      await waitFor(() => recording(bob));
      const carol = record("carol");
      const dave = record("dave", -1);
      await new Promise((resolve) => setTimeout(resolve, 2500));
      expect(db.getItem(bob)?.status).toBe("downloading");
      expect(db.getItem(carol)?.status).toBe("queued");
      expect(db.getItem(dave)?.status).toBe("queued");
      db.setItemStatus(carol, "cancelled"); db.setItemStatus(dave, "cancelled");
      queue.stopRecording(bob);
      await waitFor(() => db.getItem(bob)?.status === "completed");
    } finally { queue.stop(); db.close(); }
  });
});
