// BitPoker gamecore Web Worker: hosts the emscripten wasm module off the main
// thread (hand crypto blocks for seconds) and exposes it over a tiny id-based
// RPC. This file must stay dependency-free — it is bundled as a single
// self-contained classic worker script (see webpack servicePackages) and loads
// the vendored gamecore.js via importScripts from the extension build root.

declare function importScripts(...urls: string[]): void;

interface RpcRequest {
  id: number;
  cmd: string;
  // Loosely typed on purpose: the page-side PokerWorkerClient owns the typed
  // surface, and TS's index-signature access rule would reject dot access on
  // a Record here.
  args: any;
}

let modulePromise: Promise<any> | undefined;
let hand: any;

function ensureModule(): Promise<any> {
  if (!modulePromise) {
    importScripts("gamecore.js");
    modulePromise = (self as any).createGamecore() as Promise<any>;
  }
  return modulePromise as Promise<any>;
}

async function handle(cmd: string, args: any): Promise<any> {
  const m = await ensureModule();
  if (cmd === "selfTest") {
    return m.selfTest();
  }
  if (cmd === "newHand") {
    if (hand) {
      hand.delete();
    }
    hand =
      args.game === "ZJH"
        ? new m.ZhaJinHuaHand(
            args.firstChips | 0,
            args.secondChips | 0,
            args.localSeat | 0
          )
        : new m.TexasHoldemHand(
            args.firstChips | 0,
            args.secondChips | 0,
            args.localSeat | 0,
            args.button | 0
          );
    return true;
  }
  if (!hand) {
    throw new Error("no hand session; call newHand first");
  }
  switch (cmd) {
    case "localPubkey":
      return hand.localPubkey();
    case "buildAnnouncement":
      return hand.buildAnnouncement(
        args.name,
        args.game,
        args.chip,
        args.opponent,
        args.minBet | 0,
        args.maxBet | 0,
        args.p2pAddr || ""
      );
    case "setChainSeats":
      return hand.setChainSeats(args.playerA, args.playerB);
    case "setContinueWish":
      return hand.setContinueWish(!!args.wish);
    case "buildSessionResult":
      return hand.buildSessionResult(
        args.chainSessionId,
        args.playerA,
        args.playerB,
        args.finalStake,
        args.relayFee,
        args.localAddress
      );
    case "onPeerAnnouncement":
      return hand.onPeerAnnouncement(args.frame);
    case "setSessionSeed":
      return hand.setSessionSeed(args.seed);
    case "start":
      return hand.start();
    case "onPeerFrame":
      return hand.onPeerFrame(args.frame);
    case "onLocalAction":
      return hand.onLocalAction(args.kind | 0, args.amount | 0);
    case "makeResyncFrame":
      return hand.makeResyncFrame();
    case "tableState":
      return hand.tableState();
    case "status":
      return hand.status();
    case "exportSessionSecret":
      return hand.exportSessionSecret();
    case "buildDisputeEvidence":
      return hand.buildDisputeEvidence(
        args.chainSessionId,
        args.submitter,
        args.reasonCode | 0,
        args.reasonLabel,
        args.reasonDescription
      );
    default:
      throw new Error(`unknown poker worker command: ${cmd}`);
  }
}

self.onmessage = (ev: MessageEvent) => {
  const { id, cmd, args } = ev.data as RpcRequest;
  handle(cmd, args || {})
    .then((result) => (self as any).postMessage({ id, ok: true, result }))
    .catch((e) =>
      (self as any).postMessage({
        id,
        ok: false,
        error: e?.message ?? String(e),
      })
    );
};
