# App Extensions

This is the conflict-free registration shape for independent route/service modules. Keep additive wiring
here when a feature can register itself without shared `buildApp` state, then call
`registerAppExtensions(app, context, { directory })` from the owning test or feature registrar.

Each extension module exports an `AppExtension`:

```ts
export default {
  name: "customer-status",
  register(app) {
    app.get("/customer/status", async () => ({ ok: true }));
  },
};
```

The registry loads files in lexicographic order from a directory. Use this for additive, isolated routes
so parallel branches do not all edit one switchboard. If a feature needs one of the existing shared
services constructed in `buildApp`, keep wiring explicit until that dependency is promoted into the
extension context.
