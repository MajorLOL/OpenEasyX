import { afterEach, describe, expect, it, vi } from "vitest";
import { createPlayerAudioBoost, loadPlayerAudioBoost, savePlayerAudioBoost } from "./player-audio-boost";

afterEach(() => vi.unstubAllGlobals());

function mockAudioContext(state: AudioContextState = "running") {
  const source = { connect: vi.fn(), disconnect: vi.fn() };
  const gain = { gain: { value: 1, setTargetAtTime: vi.fn() }, connect: vi.fn(), disconnect: vi.fn() };
  const limiter = { threshold: { value: 0 }, knee: { value: 0 }, ratio: { value: 0 }, attack: { value: 0 }, release: { value: 0 }, connect: vi.fn(), disconnect: vi.fn() };
  const context = {
    state, currentTime: 0, destination: {},
    createMediaElementSource: vi.fn(() => source), createGain: vi.fn(() => gain), createDynamicsCompressor: vi.fn(() => limiter),
    resume: vi.fn(async () => { context.state = "running"; }), close: vi.fn(async () => {}),
  };
  const constructor = vi.fn(function () { return context; });
  vi.stubGlobal("AudioContext", constructor);
  return { context, constructor, source, gain, limiter };
}

describe("video audio boost", () => {
  it("restores boost independently from the shared live/video volume", () => {
    const values = new Map<string, string>();
    const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
    savePlayerAudioBoost(3, storage);
    expect(loadPlayerAudioBoost(storage)).toBe(3);
    expect(values.get("open-easyx.player-audio")).toBeUndefined();
  });

  it("handles invalid preferences and unavailable storage", () => {
    for (const stored of [null, "garbage", "Infinity", "", "-2", "0"]) {
      expect(loadPlayerAudioBoost({ getItem: () => stored })).toBe(1);
    }
    expect(loadPlayerAudioBoost({ getItem: () => "99" })).toBe(3);
    expect(loadPlayerAudioBoost({ getItem: () => "2.3" })).toBe(2);
    vi.stubGlobal("localStorage", undefined);
    expect(loadPlayerAudioBoost()).toBe(1);
    expect(() => savePlayerAudioBoost(2)).not.toThrow();
    expect(() => savePlayerAudioBoost(2, { setItem: () => { throw new Error("Blocked"); } })).not.toThrow();
  });

  it("leaves standard playback on the native audio path", async () => {
    const { constructor } = mockAudioContext();
    const output = createPlayerAudioBoost({} as HTMLMediaElement);
    expect(await output.setBoost(1)).toBe(true);
    expect(constructor).not.toHaveBeenCalled();
    output.dispose(); await Promise.resolve();
  });

  it("amplifies quiet audio and limits peaks without changing mute or native volume", async () => {
    const { context, gain, limiter } = mockAudioContext();
    const element = { volume: 0.7, muted: true } as HTMLMediaElement;
    const output = createPlayerAudioBoost(element);
    expect(await output.setBoost(3)).toBe(true);
    expect(gain.gain.value).toBe(3);
    expect(gain.connect).toHaveBeenCalledWith(limiter);
    expect(limiter.threshold.value).toBe(-1);
    expect(limiter.connect).toHaveBeenCalledWith(context.destination);
    expect(element.volume).toBe(0.7); expect(element.muted).toBe(true);
    output.dispose(); await Promise.resolve();
  });

  it("reuses the source across boost changes and bypasses the limiter when boost is off", async () => {
    const { context, gain } = mockAudioContext();
    const output = createPlayerAudioBoost({} as HTMLMediaElement);
    await output.setBoost(3); await output.setBoost(2); await output.setBoost(1);
    expect(context.createMediaElementSource).toHaveBeenCalledTimes(1);
    expect(gain.gain.setTargetAtTime).toHaveBeenLastCalledWith(1, 0, 0.01);
    expect(gain.connect).toHaveBeenLastCalledWith(context.destination);
    output.dispose(); await Promise.resolve();
  });

  it("waits for permission to run Web Audio before rerouting native audio", async () => {
    const { context } = mockAudioContext("suspended");
    let resume!: () => void;
    context.resume.mockImplementation(() => new Promise<void>((resolve) => { resume = () => { context.state = "running"; resolve(); }; }));
    const output = createPlayerAudioBoost({} as HTMLMediaElement);
    const pending = output.setBoost(3);
    expect(context.createMediaElementSource).not.toHaveBeenCalled();
    resume(); expect(await pending).toBe(true);
    expect(context.createMediaElementSource).toHaveBeenCalledTimes(1);
    output.dispose(); await Promise.resolve();
  });

  it("keeps native audio when the browser lacks or rejects Web Audio", async () => {
    vi.stubGlobal("AudioContext", undefined); vi.stubGlobal("webkitAudioContext", undefined);
    const output = createPlayerAudioBoost({} as HTMLMediaElement);
    expect(await output.setBoost(3)).toBe(false);
    const { context } = mockAudioContext("suspended");
    context.resume.mockRejectedValue(new Error("Not allowed"));
    expect(await output.setBoost(3)).toBe(false);
    expect(context.createMediaElementSource).not.toHaveBeenCalled();
    output.dispose(); await Promise.resolve();
  });

  it("survives StrictMode reattachment and releases audio resources on unmount", async () => {
    const { context, source } = mockAudioContext();
    const element = {} as HTMLMediaElement;
    const output = createPlayerAudioBoost(element);
    await output.setBoost(2); output.dispose();
    const reattached = createPlayerAudioBoost(element);
    await reattached.setBoost(3);
    expect(context.close).not.toHaveBeenCalled();
    expect(context.createMediaElementSource).toHaveBeenCalledTimes(1);
    reattached.dispose(); await Promise.resolve();
    expect(source.disconnect).toHaveBeenCalled(); expect(context.close).toHaveBeenCalledTimes(1);
  });

  it("does not attach an audio source after the player has unmounted", async () => {
    const { context } = mockAudioContext("suspended");
    const output = createPlayerAudioBoost({} as HTMLMediaElement);
    const pending = output.setBoost(3); output.dispose();
    expect(await pending).toBe(false);
    await Promise.resolve();
    expect(context.createMediaElementSource).not.toHaveBeenCalled();
    expect(context.close).toHaveBeenCalledTimes(1);
  });
});
