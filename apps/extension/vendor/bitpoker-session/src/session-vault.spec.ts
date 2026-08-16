import {
  forgetSessionIdentity,
  pruneSessionIdentities,
  rememberSessionIdentity,
  sessionIdentityForIntent,
} from "./session-vault";

const IDENTITY = {
  intentId: "7",
  secretKeyHex: "aa".repeat(32),
  pubkeyHex: "bb".repeat(96),
};

const STORAGE_KEY = "bitpoker.session-identity.v1";

// Enough of the Storage surface for the vault. These tests run in node, and a
// browser environment would be a heavier dependency than the thing under test.
// (No vitest-only helpers here either: the extension typechecks this file from
// its vendored copy, where only the jest globals exist.)
class MemoryStorage {
  private items = new Map<string, string>();
  getItem(key: string): string | null {
    return this.items.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.items.set(key, value);
  }
  removeItem(key: string): void {
    this.items.delete(key);
  }
  clear(): void {
    this.items.clear();
  }
}

let store: MemoryStorage;

describe("session vault", () => {
  beforeEach(() => {
    store = new MemoryStorage();
    (globalThis as any).localStorage = store;
  });

  it("hands back the identity a later tab needs to reveal", () => {
    rememberSessionIdentity(IDENTITY);
    expect(sessionIdentityForIntent("7")).toMatchObject(IDENTITY);
    expect(sessionIdentityForIntent("8")).toBeUndefined();
  });

  it("forgets an identity once it is spent", () => {
    rememberSessionIdentity(IDENTITY);
    forgetSessionIdentity("7");
    expect(sessionIdentityForIntent("7")).toBeUndefined();
  });

  it("drops identities older than a week", () => {
    // A dispute deadline is hours; anything this old belongs to a session that
    // ended long ago, and secrets should not pile up in a shared browser.
    const eightDaysAgo = Date.now() - 8 * 24 * 60 * 60 * 1000;
    store.setItem(
      STORAGE_KEY,
      JSON.stringify({ "7": { ...IDENTITY, savedAt: eightDaysAgo } })
    );
    pruneSessionIdentities();
    expect(sessionIdentityForIntent("7")).toBeUndefined();
  });

  it("survives storage that is missing or broken", () => {
    // Private mode with a full quota, a page with storage disabled, or a
    // worker with none at all: the player loses the ability to reveal later,
    // not the ability to play now.
    store.setItem = () => {
      throw new Error("quota exceeded");
    };
    expect(() => rememberSessionIdentity(IDENTITY)).not.toThrow();

    store = new MemoryStorage();
    (globalThis as any).localStorage = store;
    store.setItem(STORAGE_KEY, "not json");
    expect(sessionIdentityForIntent("7")).toBeUndefined();

    delete (globalThis as any).localStorage;
    expect(() => rememberSessionIdentity(IDENTITY)).not.toThrow();
    expect(sessionIdentityForIntent("7")).toBeUndefined();
  });
});
