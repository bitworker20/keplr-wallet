import React from "react";
import { TableCard } from "../types";
import { styles } from "./styles";

export const CardView: React.FC<{ card: TableCard }> = ({ card }) => {
  const red = card.name.endsWith("D") || card.name.endsWith("H");
  return (
    <span style={{ ...styles.card, color: red ? "#c22" : "inherit" }}>
      {card.name}
    </span>
  );
};

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
