// BitPoker game page (chrome-extension://<id>/poker.html).
//
// Plays heads-up Texas Hold'em OR ZhaJinHua (three-card brag) against a peer
// over a BitPoker relay — pick the game in the join form. Both run the same
// flow: announcement matchmaking, mental-poker shuffle, betting driven by the
// action bar, showdown, the signed settlement handshake, multi-hand
// continuation, and (on-chain) escrowed settlement / dispute submission. The
// gamecore wasm runs in a Web Worker (hand crypto blocks for seconds); this
// page renders tableState() snapshots and forwards button presses. Wire- and
// chain-compatible with a native GameSession peer (the bitpoker/test/interop
// e2es prove both games, both peer orders, cooperative + dispute paths).
//
// Structure: this file is the orchestrator (forms + controller wiring); the
// presentational pieces live in ./poker/ui/.
import React, { useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  GameSnapshot,
  PokerGameController,
  JoinOptions,
  PokerGame,
} from "./poker/controller";
import { styles } from "./poker/ui/styles";
import { ThTable } from "./poker/ui/th-table";
import { ZjhTable } from "./poker/ui/zjh-table";
import { Diagnostics } from "./poker/ui/diagnostics";

const POKER_CHAIN_ID = "pokerchain-testnet-1";

const PokerPage: React.FC = () => {
  const [snapshot, setSnapshot] = useState<GameSnapshot>({
    stage: "idle",
    message: "",
    wait: 1,
  });
  const controllerRef = useRef<PokerGameController>();
  const controller = useMemo(() => {
    const c = new PokerGameController(setSnapshot);
    controllerRef.current = c;
    return c;
  }, []);

  const [form, setForm] = useState({
    relayUrl: "ws://127.0.0.1:19910/relay",
    relayId: "relay-local",
    sessionId: "7777",
    playerName: "KeplrPlayer",
    minBet: "100",
    maxBet: "1000",
    lcdUrl: "http://127.0.0.1:1317",
    stake: "100",
  });
  const [game, setGame] = useState<PokerGame>("TH");
  const [betAmount, setBetAmount] = useState("0");

  const formLocked = !["idle", "error", "done", "disputed"].includes(
    snapshot.stage
  );
  const field = (key: keyof typeof form, label: string, width = "12rem") => (
    <div>
      <span style={styles.label}>{label}</span>
      <input
        style={{ ...styles.input, width }}
        value={form[key]}
        onChange={(e) => setForm({ ...form, [key]: e.target.value })}
        disabled={formLocked}
      />
    </div>
  );

  const join = () => {
    const opts: JoinOptions = {
      relayUrl: form.relayUrl,
      relayId: form.relayId,
      sessionId: form.sessionId,
      playerName: form.playerName,
      accountAddress: `keplr-${form.playerName}`,
      chainId: POKER_CHAIN_ID,
      chip: "CHIP",
      minBet: parseInt(form.minBet, 10) || 100,
      maxBet: parseInt(form.maxBet, 10) || 1000,
      game,
    };
    void controller.join(opts);
  };

  const act = (kind: number) => {
    void controller.act(kind, parseInt(betAmount, 10) || 0);
  };

  const gameSelector = (
    <div>
      <span style={styles.label}>game</span>
      <select
        value={game}
        onChange={(e) => setGame(e.target.value as PokerGame)}
        disabled={formLocked}
      >
        <option value="TH">Texas Hold&apos;em</option>
        <option value="ZJH">ZhaJinHua (三张)</option>
      </select>
    </div>
  );

  const t = snapshot.table;
  const isZjh = t?.game === "ZJH";
  const me = t?.localSeat ?? 0;
  const peer = 1 - me;
  const myTurn = snapshot.wait === 0 && snapshot.stage === "playing";

  const tableProps = {
    me,
    peer,
    myTurn,
    matched: snapshot.matched,
    stage: snapshot.stage,
    continueWish: snapshot.continueWish ?? true,
    betAmount,
    setBetAmount,
    act,
    setContinueWish: (w: boolean) => void controller.setContinueWish(w),
  };

  return (
    <div style={styles.page}>
      <h1>BitPoker</h1>

      <div style={styles.block}>
        <b>Join a table</b>
        {gameSelector}
        {field("relayUrl", "relay url", "22rem")}
        {field("relayId", "relay id")}
        {field("sessionId", "session id")}
        {field("playerName", "name")}
        {field("minBet", "min bet")}
        {field("maxBet", "max bet")}
        <button onClick={join} disabled={formLocked}>
          Join
        </button>{" "}
        <span
          style={
            snapshot.stage === "error"
              ? styles.err
              : snapshot.stage === "done" || snapshot.stage === "disputed"
              ? styles.ok
              : {}
          }
          data-testid="status"
        >
          [{snapshot.stage}] {snapshot.message}
        </span>
      </div>

      <div style={styles.block}>
        <b>Play on-chain (pokerchain session)</b>
        {field("lcdUrl", "lcd url", "22rem")}
        {field("stake", "stake")}
        <button
          onClick={() =>
            void controller.joinChain({
              lcdUrl: form.lcdUrl,
              chainId: POKER_CHAIN_ID,
              playerName: form.playerName,
              stake: form.stake,
              game,
            })
          }
          disabled={formLocked}
        >
          Play on-chain ({game})
        </button>
        {snapshot.chain ? (
          <div data-testid="chain">
            {snapshot.chain.address ? `addr ${snapshot.chain.address} ` : ""}
            {snapshot.chain.intentId
              ? `intent ${snapshot.chain.intentId} `
              : ""}
            {snapshot.chain.sessionId
              ? `session ${snapshot.chain.sessionId} `
              : ""}
            {snapshot.chain.relayId ? `relay ${snapshot.chain.relayId} ` : ""}
            {snapshot.chain.resultTxHash
              ? `result tx ${snapshot.chain.resultTxHash.slice(0, 12)}… `
              : ""}
            {snapshot.chain.sessionStatus
              ? `status ${snapshot.chain.sessionStatus}`
              : ""}
          </div>
        ) : null}
      </div>

      {t?.ready && isZjh ? <ZjhTable t={t} {...tableProps} /> : null}
      {t?.ready && !isZjh ? <ThTable t={t} {...tableProps} /> : null}

      <Diagnostics controller={controller} chainId={POKER_CHAIN_ID} />
    </div>
  );
};

const container = document.getElementById("app");
if (container) {
  createRoot(container).render(<PokerPage />);
}
