import { useSyncExternalStore } from "react";
import type { ConversationCoordinator } from "./coordinator";

/** Re-renders the caller whenever the coordinator (or its store) changes. */
export function useCoordinator(coordinator: ConversationCoordinator): number {
  return useSyncExternalStore(
    (listener) => coordinator.subscribe(listener),
    () => coordinator.revision,
    () => coordinator.revision,
  );
}
