// The transcript of a hand this seat already filed a result for.
//
// Filing a result does not end a session: until the chain says SETTLED, the
// opponent can file a contradicting one, and the chain then decides the hand
// from whichever transcript reaches it (ADR-003). Nothing else counts — not the
// signed result already on chain, not who filed first.
//
// The burden therefore falls on the seat least likely to still be there.
// Session 40 on the private testnet is the shape: player B won the hand, filed
// a signed result, and left; twenty-five blocks later player A filed a
// split-pot abort over it and turned an empty dispute into a full refund of a
// hand it had lost. B's transcript would have settled it — and in a browser
// that transcript lives in the gamecore worker's heap, which dies with the tab.
//
// So it is written down before the result is filed, signed while the wallet is
// still there to sign it, and kept until the session is terminal. This is the
// browser's half of client/transcript_vault.hpp; the drawer beside
// session-vault.ts, holding proof rather than a key.
//
// **IndexedDB, not localStorage.** The chain accepts an evidence payload up to
// 1 MiB, and real hands have come close: session 101's transcript was ~515 KB,
// which is over a million characters once hex-encoded and more than two
// megabytes once localStorage stores it as UTF-16. A localStorage vault has to
// cap itself well under what the chain accepts, and that cap is not a
// theoretical edge — it is a long hand, which is also exactly the hand an
// opponent can engineer before disputing it. IndexedDB stores the bytes as
// bytes, under a quota measured against free disk rather than a few megabytes
// per origin, so the vault can cover the chain's real limit.
//
// What is stored is not secret. It is the same bytes this client would have
// published on chain during a mid-hand dispute, and every message inside is
// already signed by whoever sent it.

const DB_NAME = "bitpoker.transcripts";
const DB_VERSION = 1;
const STORE = "transcripts";

// Records outlive their session by a wide margin — a dispute window is hours —
// but must not accumulate forever on a shared browser.
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

// The chain's own ceiling (MaxEvidencePayloadBytes). A payload the chain would
// refuse is not worth keeping, and anything at or under it must be keepable —
// that is the whole point of not using localStorage.
export const MAX_PAYLOAD_BYTES = 1024 * 1024;

// How many sessions' transcripts to keep. Small because a session that has not
// settled within a week is past every deadline the chain has.
const MAX_RECORDS = 8;

// One completed hand's double-signed settle: the ADR-010 checkpoint.
//
// `settleHex` is the packed settle BODY (PackSettleMsg), which both seats hold
// byte-identically — that is what makes two independent retreats file the same
// result and settle cooperatively instead of colliding into a dispute.
export interface KeptCheckpoint {
  handId: number;
  settleHex: string;
}

export interface KeptTranscript {
  sessionId: string;
  // The account that filed the result this transcript proves. Stored so a
  // browser shared by two accounts never offers one seat's proof to the other.
  submitter: string;
  payloadHex: string;
  evidenceHash: string;
  // The application-level attestation MsgSubmitSessionEvidence carries. Signed
  // when the transcript is stored, because that is when the wallet is
  // unquestionably available; a recovery card days later may be able to send
  // transactions without being able to produce this signature again.
  signature: string;
  reason: string;
  savedAt: number;
  // The latest checkpoint, and the one before it. Two are kept because schema-2
  // evidence has to be able to prove the rollback target when the two seats
  // reveal conflicting settles at the same hand (ADR-010 §2.1).
  checkpoint?: KeptCheckpoint;
  previousCheckpoint?: KeptCheckpoint;
}

// The stored shape: the payload as bytes rather than hex, which is half the
// size and what IndexedDB is good at. Hex is the interchange format at the
// edges (the chain message wants it), not the storage format.
// A record may hold a checkpoint with no transcript: the checkpoint is written
// at the end of every hand, while the transcript is written once, when a result
// is filed. An interrupted session never reaches the second.
interface StoredTranscript extends Omit<KeptTranscript, "payloadHex"> {
  payload?: Uint8Array;
}

function hexToBytes(hex: string): Uint8Array | undefined {
  if (hex.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(hex)) {
    return undefined;
  }
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.substr(i * 2, 2), 16);
  }
  return out;
}

function bytesToHex(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes) {
    out += byte.toString(16).padStart(2, "0");
  }
  return out;
}

// IndexedDB may be absent (SSR, some workers) or refuse to open (private mode,
// storage disabled, a browser that blocks it for this origin). None of that is
// worth an exception in the middle of settling a hand: the player loses the
// ability to defend this result later, not the ability to finish playing. Every
// entry point below resolves rather than rejects.
// Opened per operation rather than cached. A cached handle is the faster
// shape and the wrong one here: it goes stale when another tab triggers a
// version change or the browser closes the connection, and every later write
// then fails silently for the life of the page — on the one path whose entire
// job is to still work later. The vault is touched a handful of times per hand
// and once per recovery poll, so an open is not a cost worth that.
function openDb(): Promise<IDBDatabase | undefined> {
  return new Promise((resolve) => {
    let factory: IDBFactory | undefined;
    try {
      factory = typeof indexedDB === "undefined" ? undefined : indexedDB;
    } catch {
      factory = undefined;
    }
    if (!factory) {
      resolve(undefined);
      return;
    }
    let request: IDBOpenDBRequest;
    try {
      request = factory.open(DB_NAME, DB_VERSION);
    } catch {
      resolve(undefined);
      return;
    }
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: "sessionId" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => resolve(undefined);
    request.onblocked = () => resolve(undefined);
  });
}

function runTransaction<T>(
  mode: IDBTransactionMode,
  body: (store: IDBObjectStore) => IDBRequest<T> | undefined
): Promise<T | undefined> {
  return openDb().then(
    (db) =>
      new Promise<T | undefined>((resolve) => {
        if (!db) {
          resolve(undefined);
          return;
        }
        let request: IDBRequest<T> | undefined;
        try {
          const tx = db.transaction(STORE, mode);
          request = body(tx.objectStore(STORE));
          tx.onabort = () => resolve(undefined);
          tx.onerror = () => resolve(undefined);
        } catch {
          resolve(undefined);
          return;
        }
        if (!request) {
          resolve(undefined);
          return;
        }
        // Bound to a local: the closures below outlive the narrowing above.
        const pending = request;
        pending.onsuccess = () => resolve(pending.result);
        pending.onerror = () => resolve(undefined);
      })
  );
}

function isFresh(record: StoredTranscript): boolean {
  return record.savedAt >= Date.now() - MAX_AGE_MS;
}

// Store the transcript for a session. Returns false when it could not be kept —
// worth surfacing, because it is exactly the difference between defending a
// disputed result and watching it refunded.
export async function rememberTranscript(
  transcript: Omit<KeptTranscript, "savedAt">
): Promise<boolean> {
  if (
    !transcript.sessionId ||
    !transcript.payloadHex ||
    !transcript.evidenceHash
  ) {
    return false;
  }
  const payload = hexToBytes(transcript.payloadHex);
  if (!payload) {
    return false;
  }
  if (payload.byteLength > MAX_PAYLOAD_BYTES) {
    // The chain would refuse this payload too, so there is nothing to keep it
    // for. Reporting false lets the caller say so instead of implying cover.
    return false;
  }
  // Checkpoints are written per hand and the transcript once, at the end. They
  // share a record, so carry the existing ones forward rather than replacing
  // them with nothing.
  const existing = await runTransaction<StoredTranscript>("readonly", (store) =>
    store.get(transcript.sessionId)
  );
  const record: StoredTranscript = {
    sessionId: transcript.sessionId,
    submitter: transcript.submitter,
    payload,
    evidenceHash: transcript.evidenceHash,
    signature: transcript.signature,
    reason: transcript.reason,
    savedAt: Date.now(),
    checkpoint: existing?.checkpoint,
    previousCheckpoint: existing?.previousCheckpoint,
  };
  const stored = await runTransaction("readwrite", (store) =>
    store.put(record)
  );
  if (stored === undefined) {
    return false;
  }
  // Pruning is best-effort housekeeping and never decides the return value: a
  // transcript that was stored is stored whether or not the tidy-up worked.
  await pruneTranscripts(record.sessionId);
  return true;
}

// The transcript this account can use to defend a session, if there is one. The
// submitter check is what keeps a shared browser from offering one seat's proof
// under the other seat's address, which the chain would refuse anyway.
export async function transcriptForSession(
  sessionId: string,
  submitter?: string
): Promise<KeptTranscript | undefined> {
  const record = await runTransaction<StoredTranscript>("readonly", (store) =>
    store.get(sessionId)
  );
  if (!record || !record.payload || !isFresh(record)) {
    return undefined;
  }
  if (submitter && record.submitter && record.submitter !== submitter) {
    return undefined;
  }
  const { payload, ...rest } = record;
  return { ...rest, payloadHex: bytesToHex(payload) };
}

// Store the checkpoint for a session at the end of a hand. Returns false when
// it could not be kept, which is the difference between a retreat that settles
// at the real standings and one that can only split the buy-ins back.
//
// The rules mirror client/transcript_vault.cpp, and each exists for a reason:
//
//   - hand ids only move FORWARD. A late write from a stale worker must not
//     walk the checkpoint backwards and hand the opponent back a hand they
//     already lost.
//   - a DIFFERENT settle for a hand id already held is refused outright. Two
//     double-signed settles for one hand is equivocation, and this seat is not
//     the place to pick between them — the engine is.
//   - advancing keeps the one it replaces, because schema-2 evidence needs the
//     previous checkpoint as the rollback target.
export async function rememberCheckpoint(
  sessionId: string,
  submitter: string,
  checkpoint: KeptCheckpoint
): Promise<boolean> {
  if (
    !sessionId ||
    !submitter ||
    !checkpoint.settleHex ||
    !Number.isInteger(checkpoint.handId) ||
    checkpoint.handId < 0 ||
    !hexToBytes(checkpoint.settleHex)
  ) {
    return false;
  }
  const existing = await runTransaction<StoredTranscript>("readonly", (store) =>
    store.get(sessionId)
  );
  if (existing && existing.submitter && existing.submitter !== submitter) {
    // A browser shared by both seats: never overwrite one seat's proof with the
    // other's. The chain would refuse a result filed under the wrong address.
    return false;
  }
  let previousCheckpoint = existing?.previousCheckpoint;
  const held = existing?.checkpoint;
  if (held) {
    if (checkpoint.handId < held.handId) {
      return true; // stale write; what is stored is already better
    }
    if (checkpoint.handId === held.handId) {
      return held.settleHex === checkpoint.settleHex;
    }
    previousCheckpoint = held;
  }
  const record: StoredTranscript = {
    ...(existing ?? {
      sessionId,
      submitter,
      evidenceHash: "",
      signature: "",
      reason: "",
    }),
    sessionId,
    submitter,
    savedAt: Date.now(),
    checkpoint,
    previousCheckpoint,
  };
  const stored = await runTransaction("readwrite", (store) =>
    store.put(record)
  );
  if (stored === undefined) {
    return false;
  }
  await pruneTranscripts(sessionId);
  return true;
}

// The checkpoint this account can file a cooperative result from, if any.
// Deliberately does NOT require a stored transcript: a session interrupted
// mid-play has checkpoints and no transcript, and that is the case this whole
// path exists for.
export async function checkpointForSession(
  sessionId: string,
  submitter?: string
): Promise<KeptCheckpoint | undefined> {
  const record = await runTransaction<StoredTranscript>("readonly", (store) =>
    store.get(sessionId)
  );
  if (!record || !record.checkpoint || !isFresh(record)) {
    return undefined;
  }
  if (submitter && record.submitter && record.submitter !== submitter) {
    return undefined;
  }
  return record.checkpoint;
}

// Called once the session can no longer be disputed (SETTLED/CANCELLED), or
// once this transcript is on chain and does not need keeping twice.
export async function forgetTranscript(sessionId: string): Promise<void> {
  await runTransaction("readwrite", (store) => store.delete(sessionId));
}

// Drop stale records, and trim to the newest MAX_RECORDS. `protect` is never
// dropped: two transcripts written in the same millisecond tie on savedAt, and
// the one that must survive that tie is the one being written now — it belongs
// to the session that is still live, while the others have probably settled.
export async function pruneTranscripts(protect?: string): Promise<void> {
  const all = await runTransaction<StoredTranscript[]>("readonly", (store) =>
    store.getAll()
  );
  if (!all || all.length === 0) {
    return;
  }
  const doomed = new Set(
    all.filter((record) => !isFresh(record)).map((r) => r.sessionId)
  );
  const survivors = all
    .filter((record) => isFresh(record) && record.sessionId !== protect)
    .sort((a, b) => b.savedAt - a.savedAt);
  const room =
    protect && all.some((r) => r.sessionId === protect)
      ? MAX_RECORDS - 1
      : MAX_RECORDS;
  for (const record of survivors.slice(Math.max(room, 0))) {
    doomed.add(record.sessionId);
  }
  for (const sessionId of doomed) {
    await runTransaction("readwrite", (store) => store.delete(sessionId));
  }
}
