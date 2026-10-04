import { afterEach, describe, expect, it, vi } from "vitest";

import { clearLastUsedWorkspaceId, getLastUsedWorkspaceId, setLastUsedWorkspaceId } from "./lastUsedWorkspace.ts";

describe("lastUsedWorkspace (#343)", () => {
  afterEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it("round-trips a stored workspace id for a given subject", () => {
    setLastUsedWorkspaceId("user-1", "ws-1");
    expect(getLastUsedWorkspaceId("user-1")).toBe("ws-1");
  });

  it("is undefined for a subject with nothing stored yet", () => {
    expect(getLastUsedWorkspaceId("nobody")).toBeNull();
  });

  it("scopes storage per subject — a different subject's own key is unaffected", () => {
    setLastUsedWorkspaceId("user-1", "ws-1");
    expect(getLastUsedWorkspaceId("user-2")).toBeNull();
  });

  it("clears a stored value", () => {
    setLastUsedWorkspaceId("user-1", "ws-1");
    clearLastUsedWorkspaceId("user-1");
    expect(getLastUsedWorkspaceId("user-1")).toBeNull();
  });

  it("never throws when localStorage.getItem throws", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("storage disabled");
    });
    expect(getLastUsedWorkspaceId("user-1")).toBeNull();
  });

  it("never throws when localStorage.setItem throws", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("quota exceeded");
    });
    expect(() => setLastUsedWorkspaceId("user-1", "ws-1")).not.toThrow();
  });

  it("never throws when localStorage.removeItem throws", () => {
    vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => {
      throw new Error("storage disabled");
    });
    expect(() => clearLastUsedWorkspaceId("user-1")).not.toThrow();
  });
});
