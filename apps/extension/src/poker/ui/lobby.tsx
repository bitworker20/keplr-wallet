import React, { useCallback, useEffect, useState } from "react";
import {
  ChainGameIntent,
  fetchOpenIntents,
  joinableIntents,
  localGameName,
} from "../lobby";
import { formatChip, shortAddress } from "../chip";
import { styles } from "./styles";

// On-chain lobby: the open intents another player can join with one click.
// Polls the LCD while enabled; join = open a mirrored intent aimed at the
// creator (the chain pairs the two — there is no separate join tx).
export const Lobby: React.FC<{
  lcdUrl: string;
  myAddress: string;
  enabled: boolean;
  onJoin: (intent: ChainGameIntent) => void;
}> = ({ lcdUrl, myAddress, enabled, onJoin }) => {
  const [intents, setIntents] = useState<ChainGameIntent[]>([]);
  const [error, setError] = useState("");

  const refresh = useCallback(async () => {
    try {
      setIntents(joinableIntents(await fetchOpenIntents(lcdUrl), myAddress));
      setError("");
    } catch (e: any) {
      setError(e?.message ?? String(e));
    }
  }, [lcdUrl, myAddress]);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), 3000);
    return () => clearInterval(timer);
  }, [refresh]);

  return (
    <div data-testid="lobby">
      {error ? <div style={styles.err}>lobby: {error}</div> : null}
      {intents.length === 0 && !error ? (
        <div style={{ opacity: 0.6 }}>
          No open games right now — create one below and wait.
        </div>
      ) : null}
      {intents.map((intent) => (
        <div
          key={intent.intent_id}
          style={{ ...styles.row, margin: "0.3rem 0" }}
        >
          <span style={{ fontWeight: 700, minWidth: "3rem" }}>
            {localGameName(intent.game_type)}
          </span>
          <span>
            {formatChip(intent.min_stake)} – {formatChip(intent.max_stake)}
          </span>
          <span style={{ opacity: 0.7 }}>
            by {shortAddress(intent.creator)}
          </span>
          {intent.opponent === myAddress ? (
            <span style={styles.ok}>(challenges you)</span>
          ) : null}
          <button disabled={!enabled} onClick={() => onJoin(intent)}>
            Join
          </button>
        </div>
      ))}
    </div>
  );
};
