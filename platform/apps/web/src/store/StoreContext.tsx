/** React glue for the app store: a context provider plus hooks to read state and call actions. */
import { createContext, useContext, useSyncExternalStore, type ReactNode } from "react";
import type { AppState, Store } from "./store.js";

const StoreContext = createContext<Store | null>(null);

export function StoreProvider({ store, children }: { store: Store; children: ReactNode }): React.JSX.Element {
  return <StoreContext.Provider value={store}>{children}</StoreContext.Provider>;
}

/** The store instance (actions live here). */
export function useStore(): Store {
  const store = useContext(StoreContext);
  if (!store) throw new Error("useStore must be used within a StoreProvider");
  return store;
}

/** A live snapshot of app state; re-renders the component whenever the store changes. */
export function useAppState(): AppState {
  const store = useStore();
  return useSyncExternalStore(store.subscribe, store.getState, store.getState);
}
