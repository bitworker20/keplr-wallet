// Endpoint reachability probe for the browser clients — the counterpart of the
// native client's "Test connection" (app/mobile SettingsPage → testConnection),
// but it has to answer a question the native clients never face.
//
// A native client that cannot reach a node gets a real error: DNS, connection
// refused, TLS. A browser gets `TypeError: Failed to fetch` for ALL of them —
// and, identically, for a node that is up, healthy and answering, but whose
// nginx does not return Access-Control-Allow-Origin for this page's origin. The
// two have completely different fixes (one is the node being down, the other is
// one line in the operator's `$cors_origin` map) and the browser refuses to tell
// them apart, because distinguishing them is exactly what the same-origin policy
// forbids a page from learning.
//
// The one bit that does leak: a `no-cors` request is dispatched and resolves
// opaquely whenever the server answered at all, and rejects when nothing did.
// So "the CORS-mode fetch failed but the no-cors fetch succeeded" isolates a
// CORS misconfiguration from an unreachable host, which turns an unactionable
// "offline" dot into a message naming the origin the operator has to allowlist.

export type ProbeStatus = "ok" | "cors" | "unreachable" | "mismatch" | "error";

export interface ProbeResult {
  status: ProbeStatus;
  // One line, ready to render. Says what to do when there is something to do.
  detail: string;
}

export interface NodeProbeOptions {
  lcdUrl: string;
  expectedChainId?: string;
  // The page origin the node has to allowlist. Defaults to the live origin;
  // injectable so the probe is testable outside a browser.
  origin?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

const DEFAULT_TIMEOUT_MS = 8000;

function trimSlashes(url: string): string {
  return url.replace(/\/+$/, "");
}

async function withTimeout<T>(
  run: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await run(controller.signal);
  } finally {
    clearTimeout(timer);
  }
}

// Probes the node's LCD: reachable, CORS-allowed, and serving the chain this
// build expects. A wrong chain id is reported as loudly as a failure — pointing
// at the wrong network looks like everything working right up until a
// transaction is rejected.
export async function probeNode(opts: NodeProbeOptions): Promise<ProbeResult> {
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const origin =
    opts.origin ??
    (typeof globalThis.location !== "undefined"
      ? globalThis.location.origin
      : "this page's origin");
  const url = `${trimSlashes(
    opts.lcdUrl
  )}/cosmos/base/tendermint/v1beta1/node_info`;

  try {
    const res = await withTimeout(
      (signal) => fetchImpl(url, { signal }),
      timeoutMs
    );
    if (!res.ok) {
      return {
        status: "error",
        detail: `✗ node answered HTTP ${res.status} for ${url}`,
      };
    }
    const body: any = await res.json();
    const chainId: string | undefined =
      body?.default_node_info?.network ?? body?.node_info?.network;
    if (!chainId) {
      return {
        status: "error",
        detail: "✗ node answered but the reply carried no chain id",
      };
    }
    if (opts.expectedChainId && chainId !== opts.expectedChainId) {
      return {
        status: "mismatch",
        detail: `✗ connected, but the node serves ${chainId} — this client is built for ${opts.expectedChainId}`,
      };
    }
    return { status: "ok", detail: `✓ node reachable; chain id ${chainId}` };
  } catch (e: any) {
    if (await serverAnswersOpaquely(fetchImpl, url, timeoutMs)) {
      return {
        status: "cors",
        detail:
          `✗ the node is up but blocks this page: no Access-Control-Allow-Origin for ${origin}. ` +
          `Add ${origin} to the node nginx's $cors_origin allowlist (the preflight must be answered ` +
          `by nginx — grpc-gateway replies 501 to OPTIONS).`,
      };
    }
    return {
      status: "unreachable",
      detail: `✗ cannot reach ${url}${
        e?.name === "AbortError" ? " (timed out)" : ""
      }`,
    };
  }
}

// True when the host answered something — the response is opaque, so this says
// nothing about WHAT it answered, only that a CORS-mode failure was the browser
// discarding a real reply rather than no reply existing.
async function serverAnswersOpaquely(
  fetchImpl: typeof fetch,
  url: string,
  timeoutMs: number
): Promise<boolean> {
  try {
    await withTimeout(
      (signal) => fetchImpl(url, { mode: "no-cors", signal }),
      timeoutMs
    );
    return true;
  } catch {
    return false;
  }
}

export interface RelayProbeOptions {
  relayUrl: string;
  timeoutMs?: number;
  // Injectable for tests; defaults to the platform WebSocket.
  socketImpl?: typeof WebSocket;
}

// Probes the relay by opening a WebSocket and closing it again. WebSockets are
// not subject to CORS, so unlike the node probe a failure here really is the
// relay being unreachable (or a proxy in front of it refusing the upgrade) —
// worth stating, because "the node is fine but the relay is not" is otherwise
// indistinguishable from a healthy client that simply never finds a game.
export function probeRelay(opts: RelayProbeOptions): Promise<ProbeResult> {
  const Socket = opts.socketImpl ?? globalThis.WebSocket;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Socket) {
    return Promise.resolve({
      status: "error",
      detail: "✗ this browser has no WebSocket support",
    });
  }
  return new Promise<ProbeResult>((resolve) => {
    let settled = false;
    const finish = (result: ProbeResult) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      try {
        ws.close();
      } catch {
        // Closing a socket that never opened is not an error worth reporting.
      }
      resolve(result);
    };
    const timer = setTimeout(
      () =>
        finish({
          status: "unreachable",
          detail: `✗ relay did not accept a connection within ${timeoutMs}ms: ${opts.relayUrl}`,
        }),
      timeoutMs
    );

    let ws: WebSocket;
    try {
      ws = new Socket(opts.relayUrl);
    } catch (e: any) {
      clearTimeout(timer);
      resolve({
        status: "error",
        detail: `✗ relay URL rejected by the browser: ${e?.message ?? e}`,
      });
      return;
    }
    // The relay closes an unauthenticated socket on its own; reaching "open" is
    // all this probe claims, and all it needs to separate a transport problem
    // from a protocol one.
    ws.onopen = () =>
      finish({ status: "ok", detail: `✓ relay reachable: ${opts.relayUrl}` });
    ws.onerror = () =>
      finish({
        status: "unreachable",
        detail: `✗ cannot reach the relay: ${opts.relayUrl}`,
      });
  });
}
