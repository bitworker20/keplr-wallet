import React from "react";
import { TableCard } from "../types";

// Card glyphs: "AS" -> A♠. Suits colored, ranks bold, white card face — reads
// like a card on the felt instead of a debug token.
const SUITS: Record<string, { glyph: string; color: string }> = {
  S: { glyph: "♠", color: "#26262b" },
  C: { glyph: "♣", color: "#26262b" },
  H: { glyph: "♥", color: "#c43b3b" },
  D: { glyph: "♦", color: "#c43b3b" },
};

const cardStyle: React.CSSProperties = {
  display: "inline-block",
  minWidth: "1.9rem",
  textAlign: "center",
  border: "1px solid #c8c2b0",
  borderRadius: "0.3rem",
  padding: "0.25rem 0.35rem",
  marginRight: "0.3rem",
  fontSize: "1.05rem",
  fontWeight: 700,
  background: "#f5f2e9",
  lineHeight: 1.15,
};

export const CardView: React.FC<{ card: TableCard }> = ({ card }) => {
  const suit = SUITS[card.name.slice(-1)] ?? { glyph: "?", color: "#26262b" };
  const rank = card.name.slice(0, -1).replace(/^T$/, "10");
  return (
    <span style={{ ...cardStyle, color: suit.color }}>
      {rank}
      {suit.glyph}
    </span>
  );
};

// A face-down card back.
export const CardBack: React.FC = () => (
  <span
    style={{
      ...cardStyle,
      background: "#22304a",
      border: "1px solid #3a517a",
      color: "#5b79a8",
    }}
  >
    ♠
  </span>
);

export const CardBacks: React.FC<{ count: number }> = ({ count }) => (
  <React.Fragment>
    {Array.from({ length: count }, (_, i) => (
      <CardBack key={i} />
    ))}
  </React.Fragment>
);

export const Cards: React.FC<{ cards?: TableCard[]; empty: string }> = ({
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
