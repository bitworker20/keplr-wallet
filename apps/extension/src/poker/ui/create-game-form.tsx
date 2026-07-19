import React, { useMemo, useState } from "react";
import { PokerGame } from "../controller";
import { chipToUchip, formatChip, uchipLessThan } from "../chip";
import { styles } from "./styles";

export interface CreateGameSubmit {
  game: PokerGame;
  minStakeUchip: string;
  maxStakeUchip: string;
  opponent: string; // "ANY" or a bech32 address
}

// Create an on-chain game intent: Texas Hold'em by default, anyone-or-address
// opponent, CHIP-denominated stake range validated against the balance.
export const CreateGameForm: React.FC<{
  enabled: boolean;
  // Spendable uchip balance ("" = not loaded, skip the check).
  balanceUchip: string;
  onSubmit: (submit: CreateGameSubmit) => void;
}> = ({ enabled, balanceUchip, onSubmit }) => {
  const [game, setGame] = useState<PokerGame>("TH");
  const [anyOpponent, setAnyOpponent] = useState(true);
  const [opponent, setOpponent] = useState("");
  const [minChip, setMinChip] = useState("1");
  const [maxChip, setMaxChip] = useState("1");

  // Validation is derived, never stored: convert both stakes, then apply the
  // same rules as the chain (min > 0, min <= max) plus the balance guard.
  const check = useMemo((): { error?: string; min?: string; max?: string } => {
    let min: string;
    let max: string;
    try {
      min = chipToUchip(minChip);
      max = chipToUchip(maxChip);
    } catch (e: any) {
      return { error: e?.message ?? String(e) };
    }
    if (min === "0") {
      return { error: "the minimum stake must be greater than zero" };
    }
    if (uchipLessThan(max, min)) {
      return { error: "the minimum stake cannot exceed the maximum stake" };
    }
    if (
      balanceUchip &&
      /^[0-9]+$/.test(balanceUchip) &&
      uchipLessThan(balanceUchip, max)
    ) {
      return { error: "the maximum stake exceeds your balance" };
    }
    if (!anyOpponent && !opponent.trim().startsWith("xpoker1")) {
      return {
        error: "enter the opponent's xpoker1… address, or allow anyone",
      };
    }
    return { min, max };
  }, [minChip, maxChip, balanceUchip, anyOpponent, opponent]);

  // Raising min above max drags max along (blur, so typing "10" through "1"
  // doesn't fight the user).
  const coerceMax = () => {
    try {
      if (uchipLessThan(chipToUchip(maxChip), chipToUchip(minChip))) {
        setMaxChip(minChip);
      }
    } catch {
      // leave malformed input for the validator to report
    }
  };

  return (
    <div>
      <div style={styles.row}>
        <span style={styles.label}>game</span>
        <select
          value={game}
          onChange={(e) => setGame(e.target.value as PokerGame)}
          disabled={!enabled}
        >
          <option value="TH">Texas Hold&apos;em</option>
          <option value="ZJH">ZhaJinHua (三张)</option>
        </select>
      </div>
      <div style={styles.row}>
        <span style={styles.label}>opponent</span>
        <label>
          <input
            type="checkbox"
            checked={anyOpponent}
            onChange={(e) => setAnyOpponent(e.target.checked)}
            disabled={!enabled}
          />{" "}
          Anyone (open matchmaking)
        </label>
        <input
          style={{ ...styles.input, width: "22rem" }}
          value={opponent}
          onChange={(e) => setOpponent(e.target.value)}
          placeholder="opponent address, e.g. xpoker1…"
          disabled={!enabled || anyOpponent}
        />
      </div>
      <div style={styles.row}>
        <span style={styles.label}>stake (CHIP)</span>
        <input
          style={{ ...styles.input, width: "6rem" }}
          value={minChip}
          onChange={(e) => setMinChip(e.target.value)}
          onBlur={coerceMax}
          disabled={!enabled}
        />
        <span>–</span>
        <input
          style={{ ...styles.input, width: "6rem" }}
          value={maxChip}
          onChange={(e) => setMaxChip(e.target.value)}
          disabled={!enabled}
        />
        <span style={{ opacity: 0.7 }}>
          balance {balanceUchip ? formatChip(balanceUchip) : "…"}
        </span>
      </div>
      <div style={styles.row}>
        <button
          disabled={!enabled || !!check.error}
          data-testid="create-game"
          onClick={() => {
            if (check.min && check.max) {
              onSubmit({
                game,
                minStakeUchip: check.min,
                maxStakeUchip: check.max,
                opponent: anyOpponent ? "ANY" : opponent.trim(),
              });
            }
          }}
        >
          Create &amp; wait
        </button>
        {check.error ? <span style={styles.err}>{check.error}</span> : null}
      </div>
    </div>
  );
};
