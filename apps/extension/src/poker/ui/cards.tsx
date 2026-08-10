import React from "react";
import { TableCard } from "../types";

// Printed card artwork, vendored from the mylibs repo under
// vendor/bitpoker/cards/ (see the README there). A backend card name is the
// canonical "<rank><suit>" form — "AS", "TD", "QC" — and the artwork is named
// by spelled-out suit and numeric rank, so "QC" -> CLUB-12-QUEEN.svg.
const SUIT_NAMES: Record<string, string> = {
  S: "SPADE",
  H: "HEART",
  D: "DIAMOND",
  C: "CLUB",
};
const RANK_STEMS: Record<string, string> = {
  A: "1",
  T: "10",
  J: "11-JACK",
  Q: "12-QUEEN",
  K: "13-KING",
};

// A require with a template literal pulls the whole cards/ directory into the
// bundle as separate assets (webpack context module + the asset/resource rule),
// which is what we want: any of the 52 can turn up at runtime.
function faceUrl(name: string): string | undefined {
  const suit = SUIT_NAMES[name.slice(-1)];
  if (suit === undefined) {
    return undefined;
  }
  const rank = name.slice(0, -1);
  const stem = RANK_STEMS[rank] ?? rank;
  try {
    return require(`../../vendor/bitpoker/cards/${suit}-${stem}.svg`);
  } catch {
    return undefined;
  }
}

// Same expression-position require as faceUrl: a `const x = require(...)`
// trips @typescript-eslint/no-var-requires.
function backUrl(): string {
  return require("../../vendor/bitpoker/cards/card-back.png");
}

// Face and back share one geometry (rounded transparent corners are baked into
// the assets), so a single height drives everything and nothing needs masking.
const CARD_HEIGHT = "3.6rem";

const cardStyle: React.CSSProperties = {
  height: CARD_HEIGHT,
  width: "auto",
  marginRight: "0.3rem",
  verticalAlign: "middle",
  filter: "drop-shadow(0 1px 2px rgba(0,0,0,0.45))",
};

export const CardView: React.FC<{ card: TableCard }> = ({ card }) => {
  const src = faceUrl(card.name);
  if (src === undefined) {
    return null;
  }
  return <img src={src} alt={card.name} title={card.name} style={cardStyle} />;
};

// A face-down card back.
export const CardBack: React.FC = () => (
  <img src={backUrl()} alt="face-down card" style={cardStyle} />
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
