import fs from "node:fs";
import vm from "node:vm";
import { describe, expect, it, vi } from "vitest";

const source = fs.readFileSync(new URL("./easyx-browser-fetch.py", import.meta.url), "utf8");
const expression = source.match(/STRIPCHAT_FAVORITES_SCRIPT = r"""([\s\S]*?)"""/)![1];
function browser(state: unknown, user: unknown = { id: 77, username: "viewer" }, ids = [11, 12], models: unknown[] = [
  { id: 11, username: "Alice", status: "public" }, { id: 12, username: "Bob", status: "offline" },
]) {
  const fetch = vi.fn(async (url: string) => {
    if (url.includes("initial-dynamic")) return Response.json({ initialDynamic: { user } });
    if (url.includes("/favorites")) return Response.json({ modelIds: ids });
    return Response.json({ models });
  });
  return { fetch, read: () => vm.runInNewContext(expression, { window: { __PRELOADED_STATE__: state, location: { protocol: "https:" } }, document: { readyState: "complete" }, fetch, URLSearchParams }) as Promise<any> };
}
describe("Stripchat browser favorites", () => {
  it("imports favorites when the current page loads the account separately", async () => {
    const b = browser(undefined);
    expect(await b.read()).toMatchObject({ loggedIn: true, userId: 77, modelIds: [11, 12], models: [expect.objectContaining({ username: "Alice" }), expect.objectContaining({ username: "Bob" })] });
    expect(b.fetch.mock.calls[0][0]).toContain("initial-dynamic");
  });
  it("continues to support the previous signed-in page state", async () => {
    const b = browser({ userSession: { currentUser: { id: 77 } } });
    expect(await b.read()).toMatchObject({ loggedIn: true, userId: 77 });
  });
  it("does not mistake a model on a logged-out page for the signed-in account", async () => {
    const b = browser({ viewCam: { model: { id: 99, username: "Alice" } } }, null);
    expect(await b.read()).toMatchObject({ loggedIn: false });
    expect(b.fetch.mock.calls.every(([url]) => !url.includes("/users/99/"))).toBe(true);
  });
  it("rejects a successful HTTP response without the requested model details", async () => {
    const b = browser({ userSession: { currentUser: { id: 77 } } });
    b.fetch.mockImplementation(async (url) => url.includes("/favorites") ? Response.json({ modelIds: [11] }) : Response.json({ error: "blocked" }));
    await expect(b.read()).rejects.toThrow(/model/i);
  });
  it.each([[0], [11, 11], [-1], [1.2], [NaN]])("rejects invalid followed IDs %j", async (ids) => {
    const b = browser({ userSession: { currentUser: { id: 77 } } }, undefined, ids);
    await expect(b.read()).rejects.toThrow(/ID/i);
  });
  it("reports an authenticated empty followed list", async () => {
    const b = browser(undefined, { id: 77 }, [], []);
    expect(await b.read()).toMatchObject({ loggedIn: true, modelIds: [], models: [] });
  });
});
