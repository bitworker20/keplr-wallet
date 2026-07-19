import React, { useEffect, useState } from "react";
import { GameSnapshot } from "../controller";
import { TableState } from "../types";

// Shared table chrome: the felt surface, seat plates, the auto-hiding hand
// result banner and the persistent session-over strip. Kept style-only — all
// game data flows in via props.

export const felt: React.CSSProperties = {
  background: "#1d4a3a",
  border: "2px solid #2c6b54",
  borderRadius: "0.9rem",
  padding: "0.9rem 1.1rem",
  margin: "1rem 0",
  color: "#f2f0e8",
  overflowWrap: "anywhere",
};

export const seatPlate: React.CSSProperties = {
  background: "rgba(0, 0, 0, 0.28)",
  borderRadius: "0.5rem",
  padding: "0.4rem 0.7rem",
  margin: "0.35rem 0",
};

export const feltMuted: React.CSSProperties = { color: "#b9cdc2" };
export const turnMark: React.CSSProperties = {
  color: "#7ee2a8",
  fontWeight: 700,
};

// Non-modal hand-result banner: shows for a few seconds whenever a new hand
// settles (keyed on handsPlayed), then fades. The controller holds the settle
// frame ~2.6s before moving on, so the banner and pacing agree.
export const ResultBanner: React.FC<{
  t: TableState;
  text: string;
}> = ({ t, text }) => {
  const [visibleFor, setVisibleFor] = useState<number | undefined>(undefined);
  const settledKey = t.settled ? t.handsPlayed ?? 0 : undefined;

  useEffect(() => {
    if (settledKey === undefined) {
      return;
    }
    setVisibleFor(settledKey);
    const timer = setTimeout(() => {
      setVisibleFor((cur) => (cur === settledKey ? undefined : cur));
    }, 2600);
    return () => clearTimeout(timer);
  }, [settledKey]);

  if (visibleFor === undefined) {
    return null;
  }
  return (
    // NOT data-testid="result": that id is the PERSISTENT settled line the
    // e2e driver asserts after the session; this banner auto-hides.
    <div
      data-testid="hand-banner"
      style={{
        background: "rgba(0, 0, 0, 0.6)",
        borderRadius: "0.5rem",
        padding: "0.45rem 0.8rem",
        margin: "0.5rem 0",
        color: "#ffe9a8",
        fontWeight: 700,
      }}
    >
      {text}
    </div>
  );
};

// Persistent strip once the session is over (done / error / disputed): the
// reason plus the cumulative session standings.
export const SessionStrip: React.FC<{
  snapshot: GameSnapshot;
  standings?: string;
}> = ({ snapshot, standings }) => {
  const { stage, message } = snapshot;
  if (stage !== "done" && stage !== "error" && stage !== "disputed") {
    return null;
  }
  const color =
    stage === "error"
      ? "#ffb4a8"
      : stage === "disputed"
      ? "#ffd28a"
      : "#a8e2b8";
  return (
    <div
      data-testid="session-strip"
      style={{
        background: "rgba(0, 0, 0, 0.45)",
        borderRadius: "0.5rem",
        padding: "0.45rem 0.8rem",
        margin: "0.5rem 0",
        color,
      }}
    >
      {stage === "done"
        ? "Session over"
        : stage === "disputed"
        ? "Session disputed"
        : "Session error"}
      {" — "}
      {message}
      {standings ? ` · ${standings}` : ""}
    </div>
  );
};
