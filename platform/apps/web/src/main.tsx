import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import { api } from "./api/client.js";
import { createRealtime } from "./api/realtime.js";
import { createStore } from "./store/store.js";
import { StoreProvider } from "./store/StoreContext.js";
import { applyBrand } from "./brand.js";
import { applyReloadTheme } from "./theme.js";
import { applyStoredThemeMode } from "./theme-toggle.js";
import "./styles.css";

// Stamp brand-driven document title + accent before first paint (env-resolved at build time).
applyBrand();
// #378: flip the whole app (login + landing + console) to the reload.chat dark palette when the
// coordination flag is on for this deployment. Default-OFF: prod sets no env → no attribute → light app.
applyReloadTheme();
// #729: restore the user's explicit light/dark choice (from the command dock) over the gate default, before
// first paint so a reload never flashes the wrong palette. No-op until the user has toggled at least once.
applyStoredThemeMode();

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
