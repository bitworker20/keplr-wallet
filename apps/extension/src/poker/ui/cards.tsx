import React from "react";
import { TableCard } from "@bitpoker/poker-session/types";

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

// The artwork is served as plain static files from the build root rather than
// imported, because this file is bundled by two different bundlers: webpack for
// the extension and Vite/Rollup for the web client. A `require()` with a
// template literal is a webpack context module and Rollup cannot express it,
// while `import.meta.glob` is Vite-only — a plain URL is the one form both
// agree on. Each build is responsible for putting the 52 faces plus the back
// under <root>/cards/ (extension: CopyPlugin; web client: public/cards/).
const CARD_ASSET_BASE = "cards/";

function faceUrl(name: string): string | undefined {
  const suit = SUIT_NAMES[name.slice(-1)];
  if (suit === undefined) {
    return undefined;
  }
  const rank = name.slice(0, -1);
  const stem = RANK_STEMS[rank] ?? rank;
  return `${CARD_ASSET_BASE}${suit}-${stem}.svg`;
}

function backUrl(): string {
  return `${CARD_ASSET_BASE}card-back.png`;
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
