import {
  forgetTranscript,
  pruneTranscripts,
  rememberTranscript,
  transcriptForSession,
} from "./transcript-vault";

const ME = "xpoker1me";
const TRANSCRIPT = {
  sessionId: "40",
  submitter: ME,
  payloadHex: "deadbeef",
  evidenceHash: "abc123",
  signature: "sig",
  reason: "settled-result-defence",
};

const STORAGE_KEY = "bitpoker.session-transcript.v1";

// Enough of the Storage surface for the vault, matching session-vault.spec.ts:
// these run in node, and the extension typechecks the vendored copy where only
// the jest globals exist.
class MemoryStorage {
  items = new Map<string, string>();
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

describe("transcript vault", () => {
  beforeEach(() => {
    store = new MemoryStorage();
    (globalThis as any).localStorage = store;
  });

  it("hands back the transcript a later tab needs to defend a result", () => {
    expect(rememberTranscript(TRANSCRIPT)).toBe(true);
    expect(transcriptForSession("40")).toMatchObject(TRANSCRIPT);
    expect(transcriptForSession("41")).toBeUndefined();
  });

  it("will not offer one seat's proof under another seat's address", () => {
    // A shared browser. The chain would refuse the submission anyway (only a
    // session player may file, and only for itself), so offering the button is
    // just a fee waiting to be burned.
    rememberTranscript(TRANSCRIPT);
    expect(transcriptForSession("40", ME)).toBeDefined();
    expect(transcriptForSession("40", "xpoker1someone-else")).toBeUndefined();
  });

  it("forgets a transcript once its session is finished", () => {
    rememberTranscript(TRANSCRIPT);
    forgetTranscript("40");
    expect(transcriptForSession("40")).toBeUndefined();
  });

  it("refuses a payload too large to store beside the wallet's own state", () => {
    // localStorage is a few megabytes for the whole origin. A pathological hand
    // must not be able to evict everything else in it.
    expect(
      rememberTranscript({ ...TRANSCRIPT, payloadHex: "a".repeat(1_000_001) })
    ).toBe(false);
    expect(transcriptForSession("40")).toBeUndefined();
  });

  it("caps how many it keeps, and never evicts the one just written", () => {
    // Four in the same millisecond: savedAt ties, so the cap has to break the
    // tie toward the write in progress. The session still in play is the one
    // whose transcript is worth anything.
    for (const sessionId of ["1", "2", "3", "4"]) {
      expect(rememberTranscript({ ...TRANSCRIPT, sessionId })).toBe(true);
      expect(transcriptForSession(sessionId)).toBeDefined();
    }
    const held = ["1", "2", "3", "4"].filter((id) => transcriptForSession(id));
    expect(held.length).toBe(3);
    expect(held).toContain("4");
  });

  it("drops transcripts older than a week", () => {
    const eightDaysAgo = Date.now() - 8 * 24 * 60 * 60 * 1000;
    store.setItem(
      STORAGE_KEY,
      JSON.stringify({ "40": { ...TRANSCRIPT, savedAt: eightDaysAgo } })
    );
    pruneTranscripts();
    expect(transcriptForSession("40")).toBeUndefined();
  });

  it("survives storage that is missing or broken", () => {
    // Private mode with a full quota, storage disabled, a worker with none:
    // the player loses the ability to defend this result later, not the
    // ability to finish the hand.
    delete (globalThis as any).localStorage;
    expect(() => rememberTranscript(TRANSCRIPT)).not.toThrow();
    expect(transcriptForSession("40")).toBeUndefined();
    expect(() => forgetTranscript("40")).not.toThrow();
    expect(() => pruneTranscripts()).not.toThrow();
  });
});
