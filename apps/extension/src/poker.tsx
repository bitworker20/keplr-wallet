// BitPoker game page (chrome-extension://<id>/poker.html).
//
// Plays heads-up Texas Hold'em OR ZhaJinHua (three-card brag) against a peer
// over a BitPoker relay. Both run the same flow: announcement matchmaking,
// mental-poker shuffle, betting driven by the action bar, showdown, the
// signed settlement handshake, multi-hand continuation, and (on-chain)
// escrowed settlement / dispute submission. The gamecore wasm runs in a Web
// Worker (hand crypto blocks for seconds); this page renders tableState()
// snapshots and forwards button presses. Wire- and chain-compatible with a
// native GameSession peer (the bitpoker/test/interop e2es prove both games,
// both peer orders, cooperative + dispute paths).
//
// Structure: this file is the orchestrator (forms + controller wiring); the
// presentational pieces live in ./poker/ui/. Chain play starts from the
// lobby (join a listed intent) or the create-game form; the legacy
// single-stake quick panel stays at the bottom for the e2e driver.
import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { InExtensionMessageRequester } from "@keplr-wallet/router-extension";
import { BACKGROUND_PORT } from "@keplr-wallet/router";
import { BitpokerGetKeyMsg } from "@keplr-wallet/background";
import {
  GameSnapshot,
  PokerGameController,
  JoinOptions,
  PokerGame,
} from "./poker/controller";
import {
  ChainGameIntent,
  fetchUchipBalance,
  localGameName,
} from "./poker/lobby";
import { formatChip } from "./poker/chip";
import { styles } from "./poker/ui/styles";
import { ThTable } from "./poker/ui/th-table";
import { ZjhTable } from "./poker/ui/zjh-table";
import { Diagnostics } from "./poker/ui/diagnostics";
import { Lobby } from "./poker/ui/lobby";
import { CreateGameForm, CreateGameSubmit } from "./poker/ui/create-game-form";

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

  // Wallet identity + spendable balance for the lobby/create flow. Loaded
  // lazily: the wallet may be locked when the page opens.
  const [account, setAccount] = useState<{
    address: string;
    error?: string;
  }>({ address: "" });
  const [balanceUchip, setBalanceUchip] = useState("");

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const key = await new InExtensionMessageRequester().sendMessage(
          BACKGROUND_PORT,
          new BitpokerGetKeyMsg(POKER_CHAIN_ID)
        );
        if (alive) {
          setAccount({ address: key.bech32Address });
        }
      } catch (e: any) {
        if (alive) {
          setAccount({ address: "", error: e?.message ?? String(e) });
        }
      }
    };
    void load();
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    if (!account.address) {
      return;
    }
    let alive = true;
    const load = async () => {
      try {
        const balance = await fetchUchipBalance(form.lcdUrl, account.address);
        if (alive) {
          setBalanceUchip(balance);
        }
      } catch {
        if (alive) {
          setBalanceUchip("");
        }
      }
    };
    void load();
    const timer = setInterval(() => void load(), 5000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [account.address, form.lcdUrl]);

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

  const joinIntent = (intent: ChainGameIntent) => {
    void controller.joinChain({
      lcdUrl: form.lcdUrl,
      chainId: POKER_CHAIN_ID,
      playerName: form.playerName,
      game: localGameName(intent.game_type),
      minStakeUchip: intent.min_stake,
      maxStakeUchip: intent.max_stake,
      // Aiming the mirrored intent at the creator makes the chain pair the
      // two — there is no separate join tx.
      opponent: intent.creator,
    });
  };

  const createGame = (submit: CreateGameSubmit) => {
    void controller.joinChain({
      lcdUrl: form.lcdUrl,
      chainId: POKER_CHAIN_ID,
      playerName: form.playerName,
      game: submit.game,
      minStakeUchip: submit.minStakeUchip,
      maxStakeUchip: submit.maxStakeUchip,
      opponent: submit.opponent,
    });
  };

  const act = (kind: number, amount?: number) => {
    void controller.act(kind, amount ?? 0);
  };

  const t = snapshot.table;
  const isZjh = t?.game === "ZJH";
  const me = t?.localSeat ?? 0;
  const peer = 1 - me;
  const myTurn = snapshot.wait === 0 && snapshot.stage === "playing";

  const tableProps = {
    me,
    peer,
    myTurn,
    snapshot,
    continueWish: snapshot.continueWish ?? true,
    act,
    setContinueWish: (w: boolean) => void controller.setContinueWish(w),
    // Chain sessions play in uchip; render as CHIP. Dev relay-direct chips
    // are arbitrary units — leave them as plain numbers.
    fmt: snapshot.chain
      ? (amount: number) => formatChip(amount)
      : (amount: number) => String(amount),
  };

  return (
    <div style={styles.page}>
      <h1>BitPoker</h1>

      <div style={styles.block}>
        <b>Play on-chain (pokerchain)</b>
        {field("lcdUrl", "lcd url", "22rem")}
        <div>
          <span style={styles.label}>account</span>
          {account.address ? (
            <span>{account.address}</span>
          ) : (
            <span style={styles.err}>
              {account.error ?? "loading…"} (unlock the wallet, then reload)
            </span>
          )}
        </div>
        <div style={{ margin: "0.5rem 0" }}>
          <b>Open games</b>
          <Lobby
            lcdUrl={form.lcdUrl}
            myAddress={account.address}
            enabled={!formLocked && !!account.address}
            onJoin={joinIntent}
          />
        </div>
        <div style={{ margin: "0.5rem 0" }}>
          <b>Create a game</b>
          <CreateGameForm
            enabled={!formLocked && !!account.address}
            balanceUchip={balanceUchip}
            onSubmit={createGame}
          />
        </div>
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

      {/* Dev flows: relay-direct play (unsigned-dev auth, hand-shared session
          id) and the legacy single-stake chain quick start the e2e driver
          uses. Kept visible — puppeteer cannot click inside a collapsed
          <details>. */}
      <div style={styles.block}>
        <b>Join a table (dev relay-direct)</b>
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
        {field("relayUrl", "relay url", "22rem")}
        {field("relayId", "relay id")}
        {field("sessionId", "session id")}
        {field("playerName", "name")}
        {field("minBet", "min bet")}
        {field("maxBet", "max bet")}
        <button onClick={join} disabled={formLocked}>
          Join
        </button>
      </div>

      <div style={styles.block}>
        <b>Play on-chain (legacy quick start)</b>
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
      </div>

      <Diagnostics controller={controller} chainId={POKER_CHAIN_ID} />

      {/* The card faces are third-party artwork under LGPL-3.0; the licence
          requires the attribution to be visible in the shipped app. */}
      <div style={{ marginTop: "1rem", fontSize: "0.7rem", opacity: 0.55 }}>
        Card faces: Vector Playing Cards 3.2 by Chris Aguilar, licensed under
        LGPL-3.0.
      </div>
    </div>
  );
};

const container = document.getElementById("app");
if (container) {
  createRoot(container).render(<PokerPage />);
}
