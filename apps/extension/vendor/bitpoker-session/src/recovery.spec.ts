import { ChainGameSession, sessionRecovery } from "./recovery";

const ME = "xpoker1me";
const THEM = "xpoker1them";

const session = (over: Partial<ChainGameSession>): ChainGameSession => ({
  session_id: "1",
  player_a: ME,
  player_b: THEM,
  status: "GAME_SESSION_STATUS_ACTIVE",
  stake: "1000000",
  active_deadline_height: "1000",
  result_deadline_height: "0",
  relay_answer_deadline_height: "0",
  ...over,
});

describe("sessionRecovery", () => {
  it("offers a refund once an abandoned session passes its deadline", () => {
    const s = session({});
    expect(sessionRecovery(s, 999, ME).kind).toBe("wait");
    expect(sessionRecovery(s, 999, ME).atHeight).toBe(1000);
    expect(sessionRecovery(s, 1000, ME).kind).toBe("refund");
  });

  it("uses the much shorter relay-answer deadline when no relay answered", () => {
    // ADR-007: neither player could have played, so they do not wait out the
    // full abandoned-session window.
    const s = session({
      relay_answer_deadline_height: "200",
      active_deadline_height: "10000",
    });
    expect(sessionRecovery(s, 199, ME).atHeight).toBe(200);
    expect(sessionRecovery(s, 200, ME).kind).toBe("refund");
  });

  it("leaves an answered session on the abandoned-session deadline", () => {
    const s = session({
      relay_answer_deadline_height: "200",
      relay_endpoint_answer: { relay_id: "relay-a" },
      active_deadline_height: "10000",
    });
    expect(sessionRecovery(s, 500, ME).kind).toBe("wait");
    expect(sessionRecovery(s, 500, ME).atHeight).toBe(10000);
  });

  it("refuses to void a session that already carries a result", () => {
    // Refunding it would destroy a real claim on the pot; the chain refuses
    // too, and a button that always fails is worse than no button.
    const s = session({ player_b_result: { winner: THEM } });
    expect(sessionRecovery(s, 99999, ME).kind).toBe("none");
  });

  it("escalates a result the opponent never confirmed", () => {
    const s = session({
      status: "GAME_SESSION_STATUS_RESULT_PENDING",
      result_deadline_height: "300",
      player_a_result: { winner: ME },
    });
    expect(sessionRecovery(s, 299, ME).kind).toBe("wait");
    expect(sessionRecovery(s, 300, ME).kind).toBe("escalate");
  });

  it("tells the player to submit their own result first", () => {
    // Only the seat that submitted may claim, and submitting is the better
    // move anyway: two matching results settle cooperatively.
    const s = session({
      status: "GAME_SESSION_STATUS_RESULT_PENDING",
      result_deadline_height: "300",
      player_b_result: { winner: THEM },
    });
    expect(sessionRecovery(s, 99999, ME).kind).toBe("none");
    expect(sessionRecovery(s, 99999, ME).reason).toMatch(/submit your result/);
  });

  it("ignores sessions this account is not seated in", () => {
    const s = session({ player_a: "xpoker1other", player_b: THEM });
    expect(sessionRecovery(s, 99999, ME).kind).toBe("none");
  });

  it("says nothing is recoverable when the chain disables the timeout", () => {
    expect(
      sessionRecovery(session({ active_deadline_height: "0" }), 5, ME).kind
    ).toBe("none");
  });
});
