import { txFailureClass } from "./tx-failure";

describe("txFailureClass", () => {
  it("says which refusals are worth repeating", () => {
    // Our own earlier tx has not landed, or the chain is busy.
    expect(txFailureClass(32, "sdk")).toBe("transient");
    expect(txFailureClass(19, "sdk")).toBe("transient");
    expect(txFailureClass(20, "sdk")).toBe("transient");
    expect(txFailureClass(13, "sdk")).toBe("transient");

    // Worth exactly one repriced retry.
    expect(txFailureClass(11, "sdk")).toBe("underfunded");
    expect(txFailureClass(11, undefined)).toBe("underfunded");

    // An empty account does not refill itself.
    expect(txFailureClass(5, "sdk")).toBe("terminal");
  });

  it("reads the codespace, because a module code 11 is not out of gas", () => {
    // Repricing this would be the session-101 loop with bigger numbers.
    expect(txFailureClass(11, "pokerchain")).toBe("terminal");
    expect(txFailureClass(1, "pokerchain")).toBe("terminal");
  });

  it("defers adjudication until the recorded response height", () => {
    expect(txFailureClass(1110, "pokerchain")).toBe("deferred");
    expect(txFailureClass(1111, "pokerchain")).toBe("terminal");
  });

  it("does not call success a failure", () => {
    expect(txFailureClass(0, "sdk")).toBe("transient");
  });
});
