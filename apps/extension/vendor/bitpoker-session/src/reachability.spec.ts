import { probeNode, probeRelay } from "./reachability";

// A hand-rolled call recorder instead of vi.fn(): this file is also read by
// the Keplr extension's jest through the vendored copy, and importing from
// "vitest" made it the one spec that could not run there. Bare describe/it/
// expect work in both; vi.* does not.
// Calls are recorded as unknown[] rather than Parameters<T>: several stubs
// here declare no parameters (fetch passes them anyway), and a zero-length
// tuple makes calls[0][0] a type error even though the value is there.
function recorder<T extends (...args: any[]) => any>(impl: T) {
  const calls: unknown[][] = [];
  const fn = ((...args: unknown[]) => {
    calls.push(args);
    return (impl as (...a: unknown[]) => unknown)(...args);
  }) as unknown as T & { calls: unknown[][] };
  fn.calls = calls;
  return fn;
}

const LCD = "https://node1.bitpk.top/rest";
const CHAIN_ID = "poker-milestone2-test";
const ORIGIN = "https://app.bitpk.top";
const NODE_INFO_URL = `${LCD}/cosmos/base/tendermint/v1beta1/node_info`;

function nodeInfo(network: string) {
  return {
    ok: true,
    status: 200,
    json: async () => ({ default_node_info: { network } }),
  } as unknown as Response;
}

describe("probeNode", () => {
  it("reports the chain id the node actually serves", async () => {
    const fetchImpl = recorder(async () => nodeInfo(CHAIN_ID));
    const result = await probeNode({
      lcdUrl: LCD,
      expectedChainId: CHAIN_ID,
      origin: ORIGIN,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(result.status).toBe("ok");
    expect(result.detail).toContain(CHAIN_ID);
    expect(fetchImpl.calls[0]?.[0]).toBe(NODE_INFO_URL);
  });

  it("tolerates a trailing slash on the configured LCD url", async () => {
    const fetchImpl = recorder(async () => nodeInfo(CHAIN_ID));
    await probeNode({
      lcdUrl: `${LCD}/`,
      origin: ORIGIN,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(fetchImpl.calls[0]?.[0]).toBe(NODE_INFO_URL);
  });

  it("calls out a node serving a different chain rather than reporting success", async () => {
    const fetchImpl = recorder(async () => nodeInfo("some-other-chain"));
    const result = await probeNode({
      lcdUrl: LCD,
      expectedChainId: CHAIN_ID,
      origin: ORIGIN,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(result.status).toBe("mismatch");
    expect(result.detail).toContain("some-other-chain");
    expect(result.detail).toContain(CHAIN_ID);
  });

  // The case this whole module exists for: the node is up and answering, but
  // its nginx has no Access-Control-Allow-Origin for this page. A plain fetch
  // and an unreachable host are the same TypeError; only the opaque no-cors
  // probe separates them.
  it("names the origin to allowlist when CORS is what is blocking", async () => {
    const fetchImpl = recorder(async (_url: any, init?: any) => {
      if (init?.mode === "no-cors") {
        return { type: "opaque", ok: false, status: 0 } as unknown as Response;
      }
      throw new TypeError("Failed to fetch");
    });
    const result = await probeNode({
      lcdUrl: LCD,
      expectedChainId: CHAIN_ID,
      origin: ORIGIN,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(result.status).toBe("cors");
    expect(result.detail).toContain(ORIGIN);
    expect(result.detail).toContain("cors_origin");
  });

  it("reports an unreachable host when nothing answers at all", async () => {
    const fetchImpl = recorder(async () => {
      throw new TypeError("Failed to fetch");
    });
    const result = await probeNode({
      lcdUrl: LCD,
      expectedChainId: CHAIN_ID,
      origin: ORIGIN,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(result.status).toBe("unreachable");
    expect(result.detail).toContain(NODE_INFO_URL);
  });

  it("surfaces an HTTP error status instead of swallowing it", async () => {
    const fetchImpl = recorder(
      async () => ({ ok: false, status: 502 } as unknown as Response)
    );
    const result = await probeNode({
      lcdUrl: LCD,
      origin: ORIGIN,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(result.status).toBe("error");
    expect(result.detail).toContain("502");
  });
});

// Minimal WebSocket stand-in: the probe only ever needs open/error and close.
function fakeSocket(outcome: "open" | "error" | "silent") {
  return class {
    onopen: (() => void) | null = null;
    onerror: (() => void) | null = null;
    close() {}
    constructor(public url: string) {
      if (outcome === "silent") {
        return;
      }
      setTimeout(() => {
        if (outcome === "open") {
          this.onopen?.();
        } else {
          this.onerror?.();
        }
      }, 0);
    }
  } as unknown as typeof WebSocket;
}

describe("probeRelay", () => {
  it("reports reachable once the socket opens", async () => {
    const result = await probeRelay({
      relayUrl: "wss://node1.bitpk.top/relay/v1",
      socketImpl: fakeSocket("open"),
    });
    expect(result.status).toBe("ok");
  });

  it("reports unreachable when the socket errors", async () => {
    const result = await probeRelay({
      relayUrl: "wss://node1.bitpk.top/relay/v1",
      socketImpl: fakeSocket("error"),
    });
    expect(result.status).toBe("unreachable");
  });

  it("gives up rather than hanging when the relay never answers", async () => {
    const result = await probeRelay({
      relayUrl: "wss://node1.bitpk.top/relay/v1",
      socketImpl: fakeSocket("silent"),
      timeoutMs: 10,
    });
    expect(result.status).toBe("unreachable");
    expect(result.detail).toContain("10ms");
  });
});
