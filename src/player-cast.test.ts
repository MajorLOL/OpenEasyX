import { describe, expect, it } from "vitest";
import { chromecastSupported, receiverUrl, unreachableFromTv } from "./player-cast";

const chrome = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";
const safari = "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15";

describe("player casting", () => {
  it("offers Chromecast only in Chrome on a secure page", () => {
    expect(chromecastSupported({ isSecureContext: true } as never, chrome)).toBe(true);
    expect(chromecastSupported({ isSecureContext: false } as never, chrome)).toBe(false);
    expect(chromecastSupported({ isSecureContext: true } as never, safari)).toBe(false);
  });

  it("gives the TV an absolute address it can reach", () => {
    expect(receiverUrl("/api/media/abc/stream", "http://192.168.1.20:3210/watch/abc")).toBe("http://192.168.1.20:3210/api/media/abc/stream");
    expect(unreachableFromTv("http://192.168.1.20:3210/api/media/abc/stream")).toBe(false);
    expect(unreachableFromTv("http://localhost:3210/api/media/abc/stream")).toBe(true);
    expect(unreachableFromTv("http://127.0.0.1:3210/x")).toBe(true);
  });
});
