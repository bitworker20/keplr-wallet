import React from "react";

// Shared inline styles for the poker page. Deliberately NOT the Keplr design
// system: poker.html is its own bundle outside the popup UI; keeping the
// styling self-contained avoids dragging the DS (and its providers) into the
// page. WP4 restyles on top of these tokens.
export const styles = {
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
