// The BitPoker game page as this extension renders it
// (chrome-extension://<id>/poker.html). The only thing it needs from the
// extension is a PokerWalletBridge, which is where all key handling lives.
//
// This is the extension's own UI, and it is meant to stay plain: the wallet's
// job is custody, and a page that holds the key behind a router boundary is
// worth more here than one that looks impressive. The standalone web client
// (bitpoker monorepo, webapp/) renders the same game its own way. What the two
// share is @bitpoker/poker-session — relay transport, the gamecore worker and
// the hand state machine — vendored under apps/extension/vendor/, so the wire
// protocol cannot drift while the two UIs evolve apart.
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
// presentational pieces live in ./ui/. Chain play starts from the lobby (join
// a listed intent) or the create-game form; the legacy single-stake quick
// panel stays at the bottom for the e2e driver.
import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  GameSnapshot,
  PokerGameController,
  JoinOptions,
  PokerGame,
} from "@bitpoker/poker-session/controller";
import { PokerWalletBridge } from "@bitpoker/poker-session/wallet-bridge";
import {
  ChainGameIntent,
  fetchUchipBalance,
  localGameName,
} from "@bitpoker/poker-session/lobby";
import { formatChip } from "@bitpoker/poker-session/chip";
import { styles } from "./ui/styles";
import { ThTable } from "./ui/th-table";
import { ZjhTable } from "./ui/zjh-table";
import { Diagnostics } from "./ui/diagnostics";
import { Lobby } from "./ui/lobby";
import { Recovery } from "./ui/recovery";
import { CreateGameForm, CreateGameSubmit } from "./ui/create-game-form";

export interface PokerPageProps {
  // Where the account key lives: a bridge to the background service, so the
  // key stays in that realm. Nothing below this line ever sees it.
  wallet: PokerWalletBridge;
  chainId: string;
}

export const PokerPage: React.FC<PokerPageProps> = ({ wallet, chainId }) => {
  const [snapshot, setSnapshot] = useState<GameSnapshot>({
    stage: "idle",
    message: "",
    wait: 1,
  });
  const controllerRef = useRef<PokerGameController>();
  const controller = useMemo(() => {
    const c = new PokerGameController(setSnapshot, wallet);
    controllerRef.current = c;
    return c;
  }, [wallet]);

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
        const key = await wallet.getKey(chainId);
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
  }, [wallet, chainId]);

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
      chainId: chainId,
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
      chainId: chainId,
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
      chainId: chainId,
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
        {/* The display name at the table — a player setting, unlike the
            endpoints, so it lives here rather than in the dev block below
            that both on-chain paths used to borrow it from. */}
        {field("playerName", "name")}
        {/* Above the lobby on purpose: money already escrowed outranks a new
            game, and one of these steps is time-limited — a disputed session
            has to have its transcript filed before the dispute deadline or the
            chain refunds a hand this player may have won. */}
        <Recovery
          wallet={wallet}
          chainId={chainId}
          lcdUrl={form.lcdUrl}
          myAddress={account.address}
          enabled={!formLocked && !!account.address}
        />
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

      {/* Dev flows: relay-direct play (unsigned-dev auth, a session id the two
          players share by hand) and the legacy single-stake chain quick start
          the e2e driver uses. Neither is reachable by a player who just wants
          a game — the lobby and Create a game above are — and relay-direct in
          particular bypasses the ADR-007 answer that hands out the real relay
          address. Kept visible and expanded here rather than behind a
          <details>, because puppeteer cannot click inside a collapsed one. */}
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
              chainId: chainId,
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

      <Diagnostics controller={controller} wallet={wallet} chainId={chainId} />

      {/* The card faces are third-party artwork under LGPL-3.0; the licence
          requires the attribution to be visible in the shipped app. */}
      <div style={{ marginTop: "1rem", fontSize: "0.7rem", opacity: 0.55 }}>
        Card faces: Vector Playing Cards 3.2 by Chris Aguilar, licensed under
        LGPL-3.0.
      </div>
    </div>
  );
};
