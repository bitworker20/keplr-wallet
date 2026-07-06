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
import React, { useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { InExtensionMessageRequester } from "@keplr-wallet/router-extension";
import { BACKGROUND_PORT } from "@keplr-wallet/router";
import { BitpokerSignPayloadMsg } from "@keplr-wallet/background";
import {
  GameSnapshot,
  PokerGameController,
  JoinOptions,
  PokerGame,
} from "./poker/controller";
import {
  PokerActionKind,
  ZjhActionKind,
  TableCard,
  TablePlayer,
  ZjhPlayer,
  TableState,
  PHASE_NAMES,
} from "./poker/types";

const POKER_CHAIN_ID = "pokerchain-testnet-1";

const styles = {
  page: {
    fontFamily: "monospace",
    maxWidth: "56rem",
    margin: "2rem auto",
    padding: "0 1rem",
    lineHeight: 1.6,
  },
  block: {
    border: "1px solid #888",
    borderRadius: "0.5rem",
    padding: "0.75rem 1rem",
    margin: "1rem 0",
    overflowWrap: "anywhere",
  },
  row: {
    display: "flex",
    gap: "0.5rem",
    flexWrap: "wrap",
    alignItems: "center",
  },
  label: { minWidth: "7rem", display: "inline-block" },
  input: { fontFamily: "monospace", padding: "0.15rem 0.3rem" },
  card: {
    display: "inline-block",
    border: "1px solid #666",
    borderRadius: "0.3rem",
    padding: "0.2rem 0.45rem",
    marginRight: "0.3rem",
    fontSize: "1.15rem",
    fontWeight: 700,
  },
  ok: { color: "#0a0" },
  err: { color: "#c00" },
  turn: { color: "#0a0", fontWeight: 700 },
} satisfies Record<string, React.CSSProperties>;

const CardView: React.FC<{ card: TableCard }> = ({ card }) => {
  const red = card.name.endsWith("D") || card.name.endsWith("H");
  return (
    <span style={{ ...styles.card, color: red ? "#c22" : "inherit" }}>
      {card.name}
    </span>
  );
};

const Cards: React.FC<{ cards?: TableCard[]; empty: string }> = ({
  cards,
  empty,
}) => {
  if (!cards || cards.length === 0) {
    return <span style={{ opacity: 0.6 }}>{empty}</span>;
  }
  return (
    <React.Fragment>
      {cards.map((c) => (
        <CardView key={c.index} card={c} />
      ))}
    </React.Fragment>
  );
};

const zjhStyles = {
  block: {
    border: "1px solid #888",
    borderRadius: "0.5rem",
    padding: "0.75rem 1rem",
    margin: "1rem 0",
    overflowWrap: "anywhere" as const,
  },
  row: {
    display: "flex",
    gap: "0.5rem",
    flexWrap: "wrap" as const,
    alignItems: "center" as const,
    marginTop: "0.5rem",
  },
  turn: { color: "#0a0", fontWeight: 700 },
  ok: { color: "#0a0" },
};

// ZhaJinHua (three-card brag) table: 3 private cards, ante/pot/dark-bet, and
// the look/bet/call/raise/compare/fold action bar.
const ZjhTable: React.FC<{
  t: TableState;
  me: number;
  peer: number;
  myTurn: boolean;
  matched?: GameSnapshot["matched"];
  stage: GameSnapshot["stage"];
  continueWish: boolean;
  betAmount: string;
  setBetAmount: (v: string) => void;
  act: (kind: number) => void;
  setContinueWish: (wish: boolean) => void;
}> = ({
  t,
  me,
  peer,
  myTurn,
  matched,
  stage,
  continueWish,
  betAmount,
  setBetAmount,
  act,
  setContinueWish,
}) => {
  const players = (t.players as ZjhPlayer[] | undefined) ?? [];
  const looked = players[me]?.looked ?? false;
  const darkBet = t.currentDarkBet ?? 0;
  const myBetCost = darkBet * (looked ? 2 : 1);
  return (
    <div style={zjhStyles.block}>
      <b>
        ZhaJinHua · Hand {t.handNumber ?? 1} · ante {t.ante} · pot {t.pot}
        {t.dealing ? " · dealing…" : ` · dark bet ${darkBet}`}
        {t.button === me ? " · you deal" : ""}
      </b>
      <div>
        me ({matched?.meFirst ? "first" : "second"}
        {looked ? ", looked" : ", blind"}
        {players[me]?.folded ? ", folded" : ""}, in pot {players[me]?.committed}
        ):{" "}
        <Cards
          cards={t.myCards}
          empty={looked ? "(revealing…)" : "🂠 🂠 🂠 (blind)"}
        />
        {myTurn ? <span style={zjhStyles.turn}> ← your turn</span> : null}
      </div>
      <div>
        opponent ({players[peer]?.looked ? "looked" : "blind"}
        {players[peer]?.folded ? ", folded" : ""}, in pot{" "}
        {players[peer]?.committed}): <Cards cards={t.peerCards} empty="🂠 🂠 🂠" />
      </div>

      {stage === "playing" ? (
        <React.Fragment>
          <div style={zjhStyles.row}>
            <button disabled={!myTurn} onClick={() => act(ZjhActionKind.Fold)}>
              Fold
            </button>
            <button
              disabled={!myTurn || looked}
              onClick={() => act(ZjhActionKind.Look)}
            >
              Look
            </button>
            <button disabled={!myTurn} onClick={() => act(ZjhActionKind.Call)}>
              Call {myBetCost > 0 ? myBetCost : ""}
            </button>
            <input
              style={{ fontFamily: "monospace", width: "5rem" }}
              value={betAmount}
              onChange={(e) => setBetAmount(e.target.value)}
              disabled={!myTurn}
            />
            <button disabled={!myTurn} onClick={() => act(ZjhActionKind.Raise)}>
              Raise
            </button>
            <button
              disabled={!myTurn}
              onClick={() => act(ZjhActionKind.Compare)}
            >
              Compare (showdown)
            </button>
          </div>
          <div style={{ marginTop: "0.4rem" }}>
            <label>
              <input
                type="checkbox"
                checked={continueWish}
                onChange={(e) => setContinueWish(e.target.checked)}
              />{" "}
              Play another hand after this one
            </label>
          </div>
        </React.Fragment>
      ) : null}

      {(stage === "done" || stage === "disputed") && t.showdownComplete ? (
        <div
          style={{ ...zjhStyles.ok, marginTop: "0.5rem" }}
          data-testid="result"
        >
          showdown complete — {matched?.meFirst ? "first" : "second"} seat
        </div>
      ) : null}
    </div>
  );
};

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
  const [diag, setDiag] = useState<{ selfTest?: string; sign?: string }>({});

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
  const toCall = t?.toCall ?? 0;
  const thPlayers = t?.players as TablePlayer[] | undefined;
  const settle = t?.settlement;
  const mySettle = settle
    ? me === 0
      ? settle.firstAmount
      : settle.secondAmount
    : undefined;
  const totalSettle = settle ? settle.firstAmount + settle.secondAmount : 0;

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

      {t?.ready && isZjh ? (
        <ZjhTable
          t={t}
          me={me}
          peer={peer}
          myTurn={myTurn}
          matched={snapshot.matched}
          stage={snapshot.stage}
          continueWish={snapshot.continueWish ?? true}
          betAmount={betAmount}
          setBetAmount={setBetAmount}
          act={act}
          setContinueWish={(w) => void controller.setContinueWish(w)}
        />
      ) : null}

      {t?.ready && !isZjh ? (
        <div style={styles.block}>
          <b>
            Hand {t.handNumber ?? 1} — {PHASE_NAMES[t.phase ?? 0]} · pot {t.pot}
            {t.currentBet ? ` · bet ${t.currentBet}` : ""}
            {t.dealing ? " · dealing…" : ""}
            {t.button === me ? " · you have the button" : ""}
          </b>
          <div>
            board: <Cards cards={t.communityCards} empty="(no cards yet)" />
          </div>
          <div>
            me ({snapshot.matched?.meFirst ? "first" : "second"}, stack{" "}
            {thPlayers?.[me]?.stack}
            {thPlayers?.[me]?.folded ? ", folded" : ""}):{" "}
            <Cards cards={t.myHoleCards} empty="(dealing…)" />
            {myTurn ? <span style={styles.turn}> ← your turn</span> : null}
          </div>
          <div>
            opponent (stack {thPlayers?.[peer]?.stack}
            {thPlayers?.[peer]?.folded ? ", folded" : ""}):{" "}
            <Cards cards={t.peerHoleCards} empty="🂠 🂠" />
          </div>

          {snapshot.stage === "playing" ? (
            <div style={{ marginTop: "0.4rem" }}>
              <label>
                <input
                  type="checkbox"
                  checked={snapshot.continueWish ?? true}
                  onChange={(e) =>
                    void controller.setContinueWish(e.target.checked)
                  }
                />{" "}
                Play another hand after this one
                {snapshot.continueWish === false
                  ? " (leaving after this hand)"
                  : ""}
              </label>
            </div>
          ) : null}

          {snapshot.stage === "playing" ? (
            <div style={{ ...styles.row, marginTop: "0.5rem" }}>
              <button
                disabled={!myTurn}
                onClick={() => act(PokerActionKind.Fold)}
              >
                Fold
              </button>
              <button
                disabled={!myTurn || toCall > 0}
                onClick={() => act(PokerActionKind.Check)}
              >
                Check
              </button>
              <button
                disabled={!myTurn || toCall === 0}
                onClick={() => act(PokerActionKind.Call)}
              >
                Call {toCall > 0 ? toCall : ""}
              </button>
              <input
                style={{ ...styles.input, width: "5rem" }}
                value={betAmount}
                onChange={(e) => setBetAmount(e.target.value)}
                disabled={!myTurn}
              />
              <button
                disabled={!myTurn || toCall > 0}
                onClick={() => act(PokerActionKind.Bet)}
              >
                Bet
              </button>
              <button
                disabled={!myTurn || toCall === 0}
                onClick={() => act(PokerActionKind.Raise)}
              >
                Raise to
              </button>
              <button
                disabled={!myTurn}
                onClick={() => act(PokerActionKind.AllIn)}
              >
                All-in
              </button>
            </div>
          ) : null}

          {snapshot.stage === "done" && settle ? (
            <div
              style={{ ...styles.ok, marginTop: "0.5rem" }}
              data-testid="result"
            >
              settled: you {mySettle} / opponent {totalSettle - (mySettle ?? 0)}{" "}
              —{" "}
              {(mySettle ?? 0) === totalSettle
                ? "you win"
                : (mySettle ?? 0) === 0
                ? "opponent wins"
                : "split pot"}
            </div>
          ) : null}
        </div>
      ) : null}

      <details style={styles.block}>
        <summary>Diagnostics</summary>
        <div>
          <button
            onClick={() => {
              setDiag((d) => ({ ...d, selfTest: "running…" }));
              controller
                .getWorker()
                .selfTest()
                .then((r) => setDiag((d) => ({ ...d, selfTest: r })))
                .catch((e) =>
                  setDiag((d) => ({ ...d, selfTest: `ERROR: ${e.message}` }))
                );
            }}
          >
            Run gamecore selfTest (in worker)
          </button>
          <div
            style={diag.selfTest?.startsWith("OK") ? styles.ok : styles.err}
            data-testid="selftest"
          >
            {diag.selfTest}
          </div>
        </div>
        <div>
          <button
            onClick={() => {
              setDiag((d) => ({ ...d, sign: "signing…" }));
              new InExtensionMessageRequester()
                .sendMessage(
                  BACKGROUND_PORT,
                  new BitpokerSignPayloadMsg(
                    POKER_CHAIN_ID,
                    "bitpoker-relay-client-hello-v1\npoker-page-test"
                  )
                )
                .then((res) =>
                  setDiag((d) => ({
                    ...d,
                    sign: `OK ${res.signature.length / 2} bytes: ${
                      res.signature
                    }`,
                  }))
                )
                .catch((e) =>
                  setDiag((d) => ({ ...d, sign: `ERROR: ${e.message ?? e}` }))
                );
            }}
          >
            Test background raw sign
          </button>
          <div style={diag.sign?.startsWith("OK") ? styles.ok : styles.err}>
            {diag.sign}
          </div>
        </div>
      </details>
    </div>
  );
};

const container = document.getElementById("app");
if (container) {
  createRoot(container).render(<PokerPage />);
}
