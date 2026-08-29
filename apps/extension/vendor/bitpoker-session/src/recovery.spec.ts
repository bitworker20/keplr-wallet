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
    expect(sessionRecovery(s, 1000, ME).kind).toBe("ready");
    expect(sessionRecovery(s, 1000, ME).action).toBe("refund");
  });

  // ADR-010. Every deadline in this branch pays the buy-ins back, which is the
  // wrong answer once hands have actually been settled: sessions 45 and 46 on
  // the private testnet erased two hands of double-signed results that way, and
  // the seat that stayed lost 3.7 CHIP it had won.
  it("files a settled hand instead of waiting out an abandoned session", () => {
    const s = session({});
    expect(sessionRecovery(s, 999, ME, { keptCheckpoint: true })).toMatchObject(
      {
        kind: "ready",
        action: "checkpoint",
      }
    );
    // Without one there is nothing better than the timeout.
    expect(sessionRecovery(s, 999, ME).action).toBe("refund");
  });

  it("prefers the checkpoint over the short relay-answer refund too", () => {
    const s = session({
      relay_answer_deadline_height: "200",
      active_deadline_height: "10000",
    });
    expect(sessionRecovery(s, 500, ME, { keptCheckpoint: true }).action).toBe(
      "checkpoint"
    );
  });

  it("answers an opponent's result with the checkpoint rather than nothing", () => {
    const s = session({
      status: "GAME_SESSION_STATUS_RESULT_PENDING",
      result_deadline_height: "500",
      player_b_result: {},
    });
    // With no result of our own the chain will not let us claim, and the old
    // answer was to say so and stop. An identical filing settles cooperatively;
    // a contradicting one goes to an engine that reads the same checkpoint.
    expect(sessionRecovery(s, 100, ME).kind).toBe("none");
    expect(sessionRecovery(s, 100, ME, { keptCheckpoint: true })).toMatchObject(
      { kind: "ready", action: "checkpoint" }
    );
  });

  it("does not let a checkpoint pre-empt a live dispute", () => {
    // Once the session is DISPUTED the money is decided by the engine, and the
    // response window is the only thing that matters. Offering "file a result"
    // there would send a message the chain refuses in that state.
    const s = session({
      status: "GAME_SESSION_STATUS_DISPUTED",
      dispute_response_height: "900",
      dispute_refund_height: "5000",
    });
    expect(
      sessionRecovery(s, 100, ME, { keptCheckpoint: true }).action
    ).not.toBe("checkpoint");
  });

  it("uses the much shorter relay-answer deadline when no relay answered", () => {
    // ADR-007: neither player could have played, so they do not wait out the
    // full abandoned-session window.
    const s = session({
      relay_answer_deadline_height: "200",
      active_deadline_height: "10000",
    });
    expect(sessionRecovery(s, 199, ME).atHeight).toBe(200);
    expect(sessionRecovery(s, 200, ME).kind).toBe("ready");
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

  it("says what a countdown will do, not just that it is waiting", () => {
    // A RESULT_PENDING session heads for adjudication, so a button labelled
    // "refund" while it counts down would be a promise the chain will not
    // keep.
    const s = session({
      status: "GAME_SESSION_STATUS_RESULT_PENDING",
      result_deadline_height: "300",
      player_a_result: { winner: ME },
    });
    expect(sessionRecovery(s, 1, ME).kind).toBe("wait");
    expect(sessionRecovery(s, 1, ME).action).toBe("escalate");
  });

  it("escalates a result the opponent never confirmed", () => {
    const s = session({
      status: "GAME_SESSION_STATUS_RESULT_PENDING",
      result_deadline_height: "300",
      player_a_result: { winner: ME },
    });
    expect(sessionRecovery(s, 299, ME).kind).toBe("wait");
    expect(sessionRecovery(s, 300, ME).kind).toBe("ready");
    expect(sessionRecovery(s, 300, ME).action).toBe("escalate");
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

  it("files the kept transcript before anything else in a dispute", () => {
    // Session 40 from the winning seat: the loser forced the dispute, nothing
    // is on chain, and the engine decides an empty dispute by refunding. The
    // transcript this browser kept is the whole of the defence, so it goes
    // first — ahead of the reveal, ahead of the verdict.
    const s = session({
      status: "GAME_SESSION_STATUS_DISPUTED",
      dispute_response_height: "400",
    });
    const holding = sessionRecovery(s, 399, ME, {
      keptTranscript: true,
      heldSecret: true,
    });
    expect(holding.kind).toBe("ready");
    expect(holding.action).toBe("prove");

    // Once ours is on chain the order resumes: reveal, then verdict.
    const filed = sessionRecovery(s, 399, ME, {
      keptTranscript: true,
      myEvidenceOnChain: true,
      evidenceOnChain: true,
      heldSecret: true,
    });
    expect(filed.action).toBe("reveal");
  });

  it("does not offer to prove a hand this browser cannot prove", () => {
    // No transcript kept (a different device, cleared storage): the seat still
    // reveals and asks for a verdict. It may lose that verdict, but nothing is
    // gained by stalling.
    const s = session({ status: "GAME_SESSION_STATUS_DISPUTED" });
    const recovery = sessionRecovery(s, 5, ME, { evidenceOnChain: true });
    expect(recovery.action).toBe("adjudicate");
  });

  it("makes a disputed seat reveal its cards before asking for a verdict", () => {
    // Adjudication scores an undisclosed secret as a forfeit, so a client that
    // offered the verdict first would throw away a hand its player had won.
    const s = session({
      status: "GAME_SESSION_STATUS_DISPUTED",
      dispute_response_height: "400",
    });
    const held = sessionRecovery(s, 399, ME, {
      heldSecret: true,
      evidenceOnChain: true,
    });
    expect(held.kind).toBe("ready");
    expect(held.action).toBe("reveal");

    const revealed = sessionRecovery(s, 399, ME, { evidenceOnChain: true });
    expect(revealed.action).toBe("adjudicate");
    expect(revealed.kind).toBe("wait");
    expect(revealed.atHeight).toBe(400);
  });

  it("adjudicates exactly at the response boundary", () => {
    const s = session({
      status: "GAME_SESSION_STATUS_DISPUTED",
      dispute_response_height: "400",
    });
    expect(sessionRecovery(s, 399, ME).kind).toBe("wait");
    expect(sessionRecovery(s, 399, ME).action).toBe("adjudicate");
    expect(sessionRecovery(s, 400, ME).kind).toBe("ready");
    expect(sessionRecovery(s, 400, ME).action).toBe("adjudicate");
  });

  it("does not submit late evidence or secrets after responses freeze", () => {
    const s = session({
      status: "GAME_SESSION_STATUS_DISPUTED",
      dispute_response_height: "400",
    });
    const frozen = sessionRecovery(s, 400, ME, {
      keptTranscript: true,
      heldSecret: true,
    });
    expect(frozen.kind).toBe("ready");
    expect(frozen.action).toBe("adjudicate");
  });

  it("keeps asking for a verdict even after the refund hatch opens", () => {
    // Session 101 shape: evidence on chain, still DISPUTED long after the
    // dispute deadline. The hatch is a liveness backstop, not an alternative
    // outcome — offering it while a verdict is still obtainable makes "whose
    // client polls first" the settlement rule, and lets the seat that is about
    // to lose the verdict refund its stake back out of it (ADR-008 §2.5).
    const s = session({
      status: "GAME_SESSION_STATUS_DISPUTED",
      dispute_response_height: "400",
      dispute_refund_height: "900",
    });

    const beforeHatch = sessionRecovery(s, 899, ME, { evidenceOnChain: true });
    expect(beforeHatch.action).toBe("adjudicate");
    expect(beforeHatch.kind).toBe("ready");

    const atHatch = sessionRecovery(s, 900, ME, { evidenceOnChain: true });
    expect(atHatch.kind).toBe("ready");
    expect(atHatch.action).toBe("adjudicate");
    // ...but say the backstop is there, so a player whose verdict keeps being
    // refused knows the escrow is not stuck.
    expect(atHatch.reason).toMatch(/no-engine refund/);
  });

  it("offers the no-engine refund only once the chain refused a verdict", () => {
    const s = session({
      status: "GAME_SESSION_STATUS_DISPUTED",
      dispute_response_height: "400",
      dispute_refund_height: "900",
    });

    // Refused, but the window has not elapsed: keep trying for the verdict.
    const early = sessionRecovery(s, 899, ME, {
      evidenceOnChain: true,
      adjudicationRefused: true,
    });
    expect(early.action).toBe("adjudicate");

    const refused = sessionRecovery(s, 900, ME, {
      evidenceOnChain: true,
      adjudicationRefused: true,
    });
    expect(refused.kind).toBe("ready");
    expect(refused.action).toBe("refund");
    expect(refused.reason).toMatch(/without the engine/);
  });

  it("reveals a held secret while the response window is open", () => {
    // Revealing is never worse for this seat: an UNDISCLOSED secret is scored
    // as a forfeit, and the key is per-hand and already spent. The old rule
    // skipped the reveal to "avoid needless disclosure" and paid for it with
    // the outcome.
    const s = session({
      status: "GAME_SESSION_STATUS_DISPUTED",
      dispute_response_height: "400",
      dispute_refund_height: "900",
    });
    const held = sessionRecovery(s, 399, ME, {
      heldSecret: true,
      evidenceOnChain: true,
    });
    expect(held.action).toBe("reveal");
  });

  it("does not guess a refund height for unmigrated legacy state", () => {
    const s = session({
      status: "GAME_SESSION_STATUS_DISPUTED",
      dispute_response_height: "400",
    });
    const recovery = sessionRecovery(s, 99999, ME, {
      evidenceOnChain: true,
    });
    expect(recovery.action).toBe("adjudicate");
  });

  it("offers nothing on a dispute with no evidence and no deadline", () => {
    expect(
      sessionRecovery(
        session({ status: "GAME_SESSION_STATUS_DISPUTED" }),
        9,
        ME
      ).kind
    ).toBe("none");
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
