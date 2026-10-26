const AUDIO_BOOST_KEY = "open-easyx.player-audio-boost";
export const MAX_AUDIO_BOOST = 3;

function clampBoost(value: number) {
  return Number.isFinite(value) ? Math.max(1, Math.min(MAX_AUDIO_BOOST, Math.round(value))) : 1;
}

export function loadPlayerAudioBoost(storage?: Pick<Storage, "getItem">): number {
  try {
    const availableStorage = storage ?? (typeof localStorage === "undefined" ? undefined : localStorage);
    return clampBoost(Number(availableStorage?.getItem(AUDIO_BOOST_KEY) ?? 1));
  } catch { return 1; }
}

export function savePlayerAudioBoost(value: number, storage?: Pick<Storage, "setItem">): void {
  try {
    const availableStorage = storage ?? (typeof localStorage === "undefined" ? undefined : localStorage);
    availableStorage?.setItem(AUDIO_BOOST_KEY, String(clampBoost(value)));
  } catch { /* Audio controls remain usable without browser storage. */ }
}

export type PlayerAudioBoost = { setBoost: (value: number) => Promise<boolean>; dispose: () => void };
type BoostOutput = PlayerAudioBoost & { retain: () => void };
const outputs = new WeakMap<HTMLMediaElement, BoostOutput>();

export function createPlayerAudioBoost(element: HTMLMediaElement): PlayerAudioBoost {
  const existing = outputs.get(element);
  if (existing) { existing.retain(); return existing; }

  let retained = true; let closed = false; let boost = 1;
  let context: AudioContext | undefined;
  let graph: { source: MediaElementAudioSourceNode; gain: GainNode; limiter: DynamicsCompressorNode; limited: boolean } | undefined;

  const updateGraph = () => {
    if (!context || !graph) return;
    graph.gain.gain.setTargetAtTime(boost, context.currentTime, 0.01);
    const limited = boost > 1;
    if (graph.limited !== limited) {
      graph.gain.disconnect();
      graph.gain.connect(limited ? graph.limiter : context.destination);
      graph.limited = limited;
    }
  };
  const output: BoostOutput = {
    retain: () => { retained = true; },
    async setBoost(value) {
      if (!retained || closed) return false;
      boost = clampBoost(value);
      if (!context && boost === 1) return true;
      try {
        const AudioContextClass = globalThis.AudioContext ?? (globalThis as typeof globalThis & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
        if (!AudioContextClass) return false;
        context ??= new AudioContextClass();
        // Keep native audio playing until the browser permits Web Audio.
        // Play/volume gestures call this again to unlock a suspended context.
        if (context.state !== "running") await context.resume();
        if (!retained || closed || context.state !== "running") return false;
        if (!graph && boost > 1) {
          const gain = context.createGain(); const limiter = context.createDynamicsCompressor();
          gain.gain.value = boost;
          limiter.threshold.value = -1; limiter.knee.value = 0; limiter.ratio.value = 20;
          limiter.attack.value = 0.003; limiter.release.value = 0.1;
          gain.connect(limiter); limiter.connect(context.destination);
          const source = context.createMediaElementSource(element);
          source.connect(gain);
          graph = { source, gain, limiter, limited: true };
        }
        updateGraph();
        return true;
      } catch { return false; }
    },
    dispose() {
      retained = false;
      // React StrictMode immediately attaches the same element again. Reuse its
      // source: a media element can only be attached to one Web Audio source.
      queueMicrotask(() => {
        if (retained || closed) return;
        closed = true; outputs.delete(element);
        graph?.source.disconnect(); graph?.gain.disconnect(); graph?.limiter.disconnect();
        if (context) void context.close().catch(() => {});
      });
    },
  };
  outputs.set(element, output);
  return output;
}
