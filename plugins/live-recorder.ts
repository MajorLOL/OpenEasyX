// Shared segmented live recorder. The queue signals its entire process group on POSIX.
export const LIVE_RECORDER_SCRIPT = String.raw`
const { spawn, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const [mediaUrl, masterUrl, headersJson, output, gapArg, pollArg, userAgent, refreshUrl, refreshField] = process.argv.slice(1);
const headers = JSON.parse(headersJson);
let currentMasterUrl = masterUrl;
const gapMs = Number(gapArg) || 0;
const pollMs = Number(pollArg) || 20000;
const partsDir = path.join(path.dirname(output), "live-parts");
fs.rmSync(partsDir, { recursive: true, force: true });
fs.mkdirSync(partsDir, { recursive: true });
const controller = new AbortController();
let stopping = false, cancelled = false, child, wake = () => {};
const say = (text) => process.stderr.write("[live-recorder] " + text + "\n");
process.on("SIGINT", () => { stopping = true; if (process.platform === "win32") child?.kill("SIGINT"); controller.abort(); wake(); });
process.on("SIGTERM", () => { stopping = true; cancelled = true; child?.kill("SIGKILL"); controller.abort(); wake(); });
const sleep = (ms) => new Promise((resolve) => { const timer = setTimeout(resolve, ms); wake = () => { clearTimeout(timer); resolve(); }; });
// Retry a segment or playlist that fails once instead of skipping it (FFmpeg 6+ only;
// Debian bookworm ships 5.1, so the option is used only when this FFmpeg knows it).
const hlsHelp = (() => { try { return String(spawnSync("ffmpeg", ["-hide_banner", "-h", "demuxer=hls"], { encoding: "utf8", timeout: 10000 }).stdout || ""); } catch { return ""; } })();
const retryArgs = [...(hlsHelp.includes("seg_max_retry") ? ["-seg_max_retry", "3"] : []), ...(hlsHelp.includes("max_reload") ? ["-max_reload", "10"] : []), ...(hlsHelp.includes("m3u8_hold_counters") ? ["-m3u8_hold_counters", "10"] : [])];
const stallSeconds = Number(process.env.EASYX_LIVE_STALL_SECONDS || 60);
const stallMs = Number.isFinite(stallSeconds) && stallSeconds > 0 ? Math.max(1, stallSeconds) * 1000 : 60000;
// Segments the HLS demuxer had to give up on leave a short freeze and an audio gap.
let lostSegments = 0, failedRequests = 0, stalledCaptures = 0;
const run = (args, recordingPart) => new Promise((resolve) => {
  const encoder = child = spawn("ffmpeg", args, { stdio: ["ignore", "pipe", "pipe"] });
  let lastGrowth = Date.now(), lastTick = lastGrowth, lastSize = 0, watchdog, killTimer, errors = "";
  // A playlist can return HTTP 200 forever without publishing another segment.
  // Bound that wait and reconnect while preserving the part already captured.
  if (recordingPart) watchdog = setInterval(() => {
    const now = Date.now();
    // SIGSTOP pauses the whole group; a user pause must not count as a stall.
    if (now - lastTick > 3000) lastGrowth += now - lastTick - 1000;
    lastTick = now;
    const bytes = size(recordingPart);
    if (bytes > lastSize) { lastSize = bytes; lastGrowth = now; }
    if (stopping || killTimer || now - lastGrowth < stallMs) return;
    stalledCaptures += 1;
    say("capture stalled without new video; reconnecting and keeping the recorded part");
    encoder.kill("SIGINT");
    killTimer = setTimeout(() => encoder.kill("SIGKILL"), 10000);
  }, 1000);
  // Drain progress output even when the enclosing queue does not consume it.
  encoder.stdout.resume();
  const countErrors = (line) => {
    for (const match of line.matchAll(/skipping (\d+) segments? ahead/gi)) lostSegments += Number(match[1]) || 1;
    failedRequests += (line.match(/Failed to open segment|Failed to reload playlist|HTTP error 5\d\d|Connection timed out/gi) || []).length;
  };
  child.stderr.on("data", (chunk) => {
    const text = String(chunk); process.stderr.write(text);
    errors += text;
    const lines = errors.split(/\r?\n/); errors = lines.pop().slice(-8000);
    for (const line of lines) countErrors(line);
  });
  const finish = (code) => { clearInterval(watchdog); clearTimeout(killTimer); countErrors(errors); errors = ""; if (child === encoder) child = undefined; resolve(code); };
  encoder.once("error", () => finish(-1));
  encoder.once("close", (code) => finish(code));
});
const size = (file) => { try { return fs.statSync(file).size; } catch { return 0; } };
const isLive = (text) => text.trimStart().startsWith("#EXTM3U") && !text.includes("#EXT-X-MOUFLON-ADVERT")
  && !text.includes("#EXT-X-ENDLIST") && (text.includes("#EXTINF:") || text.includes("#EXT-X-PART:"));
async function get(url) {
  const response = await fetch(url, { headers: { ...headers, "user-agent": userAgent }, signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]) });
  return response.ok ? response.text() : undefined;
}
async function variants(refresh = false) {
  if (refresh && refreshUrl && refreshField) {
    const body = await get(refreshUrl);
    if (!body) return [];
    const data = JSON.parse(body);
    const next = data && data[refreshField];
    if (typeof next !== "string" || !/^https?:\/\//i.test(next)) return [];
    currentMasterUrl = next;
  }
  const text = await get(currentMasterUrl);
  if (!text || !text.trimStart().startsWith("#EXTM3U") || text.includes("#EXT-X-MOUFLON-ADVERT")) return [];
  if (isLive(text)) return [{ url: currentMasterUrl, resolution: "", bandwidth: 0 }];
  const pkey = new URL(currentMasterUrl).searchParams.get("pkey");
  const list = []; let info = "";
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith("#EXT-X-STREAM-INF")) { info = line; continue; }
    if (!line || line.startsWith("#") || !/\.m3u8(?:$|\?)/i.test(line)) continue;
    const url = new URL(line, currentMasterUrl);
    if (pkey && !url.searchParams.has("pkey")) url.searchParams.set("pkey", pkey);
    list.push({ url: url.toString(), bandwidth: Number((info.match(/(?:^|[:,])BANDWIDTH=(\d+)/i) || [])[1] || 0), resolution: (info.match(/RESOLUTION=(\d+x\d+)/i) || [])[1] || "" });
    info = "";
  }
  return list.sort((a, b) => b.bandwidth - a.bandwidth);
}
async function liveVariant(resolution) {
  const list = await variants(true);
  const ordered = resolution ? list.filter((item) => item.resolution === resolution) : list;
  for (const item of ordered) {
    try { const text = await get(item.url); if (text && isLive(text)) return item; } catch {}
  }
  if (!resolution || ordered.length) return undefined;
  for (const item of list) {
    try { const text = await get(item.url); if (text && isLive(text)) return { url: "", resolution: "changed" }; } catch {}
  }
  return undefined;
}
(async () => {
  const parts = [];
  let url = mediaUrl, resolution, lastRecording = Date.now();
  try { resolution = (await variants()).find((item) => item.url === mediaUrl)?.resolution; } catch {}
  while (!stopping) {
    const part = path.join(partsDir, "part-" + String(parts.length + 1).padStart(3, "0") + ".ts");
    const headerLines = Object.entries(headers).map(([name, value]) => name + ": " + value).join("\r\n") + "\r\n";
    const code = await run(["-hide_banner", "-loglevel", "warning", "-rw_timeout", "15000000", ...retryArgs, "-user_agent", userAgent, "-headers", headerLines, "-i", url,
      "-map", "0:v:0", "-map", "0:a:0?", "-c", "copy", "-flush_packets", "1", "-f", "mpegts", "-y", part], part);
    const recorded = size(part) > 0;
    if (recorded) { parts.push(part); lastRecording = Date.now(); } else fs.rmSync(part, { force: true });
    if (stopping || code === -1 || gapMs <= 0) break;
    if (resolution === undefined) {
      try {
        const first = new URL(mediaUrl).pathname;
        resolution = (await variants()).find((item) => new URL(item.url).pathname === first)?.resolution || "";
      } catch { resolution = ""; }
    }
    say("stream stopped (ffmpeg exit " + code + "); waiting up to " + (gapMs >= 60000 ? Math.round(gapMs / 60000) + " min" : Math.round(gapMs / 1000) + " s") + " for the room to return");
    // Empty reconnect attempts share one deadline, so a permanently broken
    // public URL cannot occupy a download slot indefinitely.
    const deadline = lastRecording + gapMs;
    url = "";
    while (!stopping && Date.now() < deadline) {
      await sleep(Math.min(pollMs, Math.max(0, deadline - Date.now())));
      if (stopping) break;
      let found;
      try { found = await liveVariant(resolution); } catch {}
      if (found && found.resolution === "changed") { say("room is back in a different quality; finishing this video"); break; }
      if (found) { url = found.url; say("room is public again; continuing the recording"); break; }
    }
    if (!url) break;
  }
  if (cancelled) { fs.rmSync(partsDir, { recursive: true, force: true }); process.exit(143); }
  if (!parts.length) { fs.rmSync(partsDir, { recursive: true, force: true }); say("no video was recorded"); process.exit(1); }
  const list = path.join(partsDir, "parts.txt");
  fs.writeFileSync(list, parts.map((part) => "file '" + path.basename(part) + "'").join("\n") + "\n");
  stopping = false;
  const joined = await run(["-hide_banner", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", list,
    "-map", "0:v:0", "-map", "0:a:0?", "-c", "copy", "-movflags", "+faststart", "-y", output]);
  if (joined !== 0 || size(output) === 0) { say("joining " + parts.length + " part(s) failed"); process.exit(1); }
  fs.rmSync(partsDir, { recursive: true, force: true });
  if (parts.length > 1) say("joined " + parts.length + " parts into one video");
  if (lostSegments || failedRequests || stalledCaptures) say("stream problems: " + lostSegments + " segment(s) skipped, " + failedRequests + " failed request(s), " + stalledCaptures + " stalled capture(s)");
  process.exit(0);
})().catch((error) => { say(String((error && error.stack) || error)); process.exit(1); });
`;


export async function retryDelay(ms: number, signal?: AbortSignal) {
  signal?.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const finish = () => { signal?.removeEventListener("abort", abort); resolve(); };
    const timer = setTimeout(finish, ms);
    const abort = () => { clearTimeout(timer); reject(signal?.reason); };
    signal?.addEventListener("abort", abort, { once: true });
  });
}
