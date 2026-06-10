import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import { api } from "./api/client.js";
import { createRealtime } from "./api/realtime.js";
import { createStore } from "./store/store.js";
import { StoreProvider } from "./store/StoreContext.js";
import { applyBrand } from "./brand.js";
import "./styles.css";

// Stamp brand-driven document title + accent before first paint (env-resolved at build time).
applyBrand();

const root = document.getElementById("root");
if (!root) throw new Error("#root not found");

// Compose the production store: real REST client + a live WebSocket to the /ws gateway.
const store = createStore({ api, realtime: createRealtime() });

createRoot(root).render(
  <StrictMode>
    <StoreProvider store={store}>
      <App />
    </StoreProvider>
  </StrictMode>,
);
