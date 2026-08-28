import {
  MAX_PAYLOAD_BYTES,
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

// Enough of IndexedDB for the vault, in the same spirit as the MemoryStorage in
// session-vault.spec.ts: these tests run in node, and a real browser
// environment (or fake-indexeddb) would be a heavier dependency than the thing
// under test — and one the extension's vendored copy would have to carry too.
// Callbacks fire on a microtask because the vault assigns its handlers after
// the call, exactly as it does against the real API.
class FakeRequest<T> {
  onsuccess: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onupgradeneeded: (() => void) | null = null;
  onblocked: (() => void) | null = null;
  result!: T;
}

function settle<T>(request: FakeRequest<T>, result: T): FakeRequest<T> {
  queueMicrotask(() => {
    request.result = result;
    request.onsuccess?.();
  });
  return request;
}

class FakeObjectStore {
  constructor(private rows: Map<string, any>) {}
  put(record: any) {
    this.rows.set(record.sessionId, record);
    return settle(new FakeRequest<any>(), record.sessionId);
  }
  get(key: string) {
    return settle(new FakeRequest<any>(), this.rows.get(key));
  }
  delete(key: string) {
    this.rows.delete(key);
    return settle(new FakeRequest<any>(), undefined);
  }
  getAll() {
    return settle(new FakeRequest<any[]>(), [...this.rows.values()]);
  }
}

class FakeDb {
  rows = new Map<string, any>();
  objectStoreNames = { contains: () => true };
  createObjectStore() {
    return new FakeObjectStore(this.rows);
  }
  transaction() {
    const rows = this.rows;
    return {
      onabort: null,
      onerror: null,
      objectStore: () => new FakeObjectStore(rows),
    };
  }
}

let db: FakeDb;

function installIndexedDb(open: () => FakeRequest<FakeDb> | undefined): void {
  (globalThis as any).indexedDB = {
    open: () => {
      const request = open();
      if (!request) {
        throw new Error("indexedDB is unavailable");
      }
      return request;
    },
  };
}

describe("transcript vault", () => {
  beforeEach(() => {
    db = new FakeDb();
    installIndexedDb(() => settle(new FakeRequest<FakeDb>(), db));
  });

  it("hands back the transcript a later tab needs to defend a result", async () => {
    expect(await rememberTranscript(TRANSCRIPT)).toBe(true);
    expect(await transcriptForSession("40")).toMatchObject(TRANSCRIPT);
    expect(await transcriptForSession("41")).toBeUndefined();
  });

  it("stores the payload as bytes and hands it back as hex", async () => {
    await rememberTranscript(TRANSCRIPT);
    // Half the size of the hex on the way in; the chain message wants hex, so
    // that is what comes back out.
    expect(db.rows.get("40").payload.byteLength).toBe(4);
    expect((await transcriptForSession("40"))?.payloadHex).toBe("deadbeef");
  });

  it("keeps a transcript as large as the chain will accept", async () => {
    // The reason this is not localStorage. Session 101's real transcript was
    // ~515 KB, which is over a million characters of hex and more than two
    // megabytes once a browser stores it as UTF-16 — a long hand is exactly the
    // hand an opponent can engineer before disputing it.
    const big = "ab".repeat(MAX_PAYLOAD_BYTES);
    expect(await rememberTranscript({ ...TRANSCRIPT, payloadHex: big })).toBe(
      true
    );
    expect((await transcriptForSession("40"))?.payloadHex).toBe(big);
  });

  it("refuses a payload the chain itself would refuse", async () => {
    const tooBig = "ab".repeat(MAX_PAYLOAD_BYTES + 1);
    expect(
      await rememberTranscript({ ...TRANSCRIPT, payloadHex: tooBig })
    ).toBe(false);
    expect(await transcriptForSession("40")).toBeUndefined();
  });

  it("refuses a payload that is not hex rather than storing rubbish", async () => {
    expect(
      await rememberTranscript({ ...TRANSCRIPT, payloadHex: "not-hex" })
    ).toBe(false);
  });

  it("will not offer one seat's proof under another seat's address", async () => {
    // A shared browser. The chain would refuse the submission anyway (only a
    // session player may file, and only for itself), so offering the button is
    // just a fee waiting to be burned.
    await rememberTranscript(TRANSCRIPT);
    expect(await transcriptForSession("40", ME)).toBeDefined();
    expect(await transcriptForSession("40", "xpoker1else")).toBeUndefined();
  });

  it("forgets a transcript once its session is finished", async () => {
    await rememberTranscript(TRANSCRIPT);
    await forgetTranscript("40");
    expect(await transcriptForSession("40")).toBeUndefined();
  });

  it("caps how many it keeps, and never evicts the one just written", async () => {
    // Written in the same millisecond, so savedAt ties: the cap has to break
    // the tie toward the write in progress, because that is the session still
    // in play.
    const ids = Array.from({ length: 12 }, (_, i) => String(i + 1));
    for (const sessionId of ids) {
      expect(await rememberTranscript({ ...TRANSCRIPT, sessionId })).toBe(true);
      expect(await transcriptForSession(sessionId)).toBeDefined();
    }
    expect(db.rows.size).toBe(8);
    expect(await transcriptForSession("12")).toBeDefined();
  });

  it("drops transcripts older than a week", async () => {
    db.rows.set("40", {
      ...TRANSCRIPT,
      payload: new Uint8Array([1, 2]),
      savedAt: Date.now() - 8 * 24 * 60 * 60 * 1000,
    });
    // Stale on read, whether or not the prune has run yet.
    expect(await transcriptForSession("40")).toBeUndefined();
    await pruneTranscripts();
    expect(db.rows.has("40")).toBe(false);
  });

  it("survives storage that is missing or refuses to open", async () => {
    // Private mode, storage disabled, a worker with no IndexedDB: the player
    // loses the ability to defend this result later, not the ability to finish
    // the hand. Nothing here may throw.
    delete (globalThis as any).indexedDB;
    expect(await rememberTranscript(TRANSCRIPT)).toBe(false);
    expect(await transcriptForSession("40")).toBeUndefined();
    await expect(forgetTranscript("40")).resolves.toBeUndefined();
    await expect(pruneTranscripts()).resolves.toBeUndefined();

    installIndexedDb(() => undefined); // open() throws
    expect(await rememberTranscript(TRANSCRIPT)).toBe(false);

    installIndexedDb(() => {
      const request = new FakeRequest<FakeDb>();
      queueMicrotask(() => request.onerror?.());
      return request;
    });
    expect(await rememberTranscript(TRANSCRIPT)).toBe(false);

    // And it recovers the moment storage works again.
    installIndexedDb(() => settle(new FakeRequest<FakeDb>(), db));
    expect(await rememberTranscript(TRANSCRIPT)).toBe(true);
  });
});
