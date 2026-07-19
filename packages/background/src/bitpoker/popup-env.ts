import { Env, FnRequestInteraction } from "@keplr-wallet/router";
import { openPopupWindow } from "@keplr-wallet/popup";

// The poker page (poker.html) runs no UI router and no root store, so the
// stock internal-message interaction path — which navigates the *sender's*
// popup/side-panel router via ReplacePageMsg — has nowhere to land: the
// approval would hang invisibly. This wrapper keeps env.isInternalMsg (so
// InteractionService.wait still takes its internal branch and calls OUR
// requestInteraction with the interaction uri) but surfaces the approval by
// opening a real popup window at that route.
//
// No targeted message delivery is needed: the freshly-opened UI's
// InteractionStore pulls all pending interaction data on load (refreshData in
// stores-core), so the approval page finds the waiting intent by type.
export function withApprovalPopup(env: Env): Env {
  const requestInteraction: FnRequestInteraction = async (
    url,
    _msg,
    options
  ) => {
    if (url.startsWith("/")) {
      url = url.slice(1);
    }
    let popupUrl = browser.runtime.getURL("/popup.html#/" + url);
    // interactionInternal=false makes the approval page close its window on
    // resolve instead of navigate(-1) — this popup exists only for the
    // approval.
    popupUrl +=
      (popupUrl.includes("?") ? "&" : "?") +
      "interaction=true&interactionInternal=false";

    const windowId = await openPopupWindow(popupUrl);

    // Closing the approval window without deciding must reject the wait —
    // otherwise the poker page hangs on a promise nobody can resolve.
    if (options?.unstableOnClose) {
      const onClose = options.unstableOnClose;
      const listener = (removedWindowId: number) => {
        if (removedWindowId === windowId) {
          onClose();
          browser.windows.onRemoved.removeListener(listener);
        }
      };
      browser.windows.onRemoved.addListener(listener);
    }

    // The return value of requestInteraction is unused by
    // InteractionService.wait; resolution flows through approve/reject
    // messages handled by the interaction service itself.
    return undefined as never;
  };

  return {
    ...env,
    requestInteraction,
  };
}
