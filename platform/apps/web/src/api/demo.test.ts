import { describe, it, expect } from "vitest";
import {
  demoDeliverableUrl,
  fetchDemoDeliverable,
  DemoError,
  type DemoDeliverableDto,
  type FetchLike,
} from "./demo.js";

/**
 * Unit test for the #610 instant-demo single-shot client. The browser `fetch` is injected so the request
 * shape, the JSON unwrap, and the typed-error mapping (400 → bad input vs. anything else → fault) are all
 * provable under jsdom with no network.
 */

const plan: DemoDeliverableDto = {
  business: { url: "https://acme.com", host: "acme.com", name: "Acme" },
  title: "Acme's first-week growth teardown",
  subtitle: "A real deliverable for acme.com — built before you set anything up.",
  sections: [{ id: "snapshot", kind: "insight", heading: "How a visitor sees you", body: "…" }],
};

function fakeFetch(res: Partial<{ ok: boolean; status: number; body: unknown }>): {
  impl: FetchLike;
  calls: string[];
} {
  const calls: string[] = [];
  const impl: FetchLike = (input) => {
    calls.push(input);
    return Promise.resolve({
      ok: res.ok ?? true,
      status: res.status ?? 200,
      json: () => Promise.resolve(res.body ?? plan),
    });
  };
  return { impl, calls };
}

describe("demoDeliverableUrl", () => {
  it("targets the public single-shot endpoint and url-encodes the typed url", () => {
    expect(demoDeliverableUrl("acme.com")).toBe("/onboarding/deliverable?url=acme.com");
    expect(demoDeliverableUrl("https://a.com/x?y=1")).toBe(
      "/onboarding/deliverable?url=https%3A%2F%2Fa.com%2Fx%3Fy%3D1",
    );
  });
});

describe("fetchDemoDeliverable", () => {
  it("requests the encoded URL and returns the parsed deliverable", async () => {
    const { impl, calls } = fakeFetch({ ok: true, body: plan });
    const result = await fetchDemoDeliverable("acme.com", { fetchImpl: impl });
    expect(calls).toEqual(["/onboarding/deliverable?url=acme.com"]);
    expect(result).toEqual(plan);
  });

  it("maps a 400 to a DemoError flagged as bad input (the visitor should fix their URL)", async () => {
    const { impl } = fakeFetch({ ok: false, status: 400 });
    await expect(fetchDemoDeliverable("not a url", { fetchImpl: impl })).rejects.toMatchObject({
      name: "DemoError",
      badInput: true,
    });
  });

  it("maps any other non-OK status to a non-input DemoError", async () => {
    const { impl } = fakeFetch({ ok: false, status: 500 });
    const err = await fetchDemoDeliverable("acme.com", { fetchImpl: impl }).catch((e) => e);
    expect(err).toBeInstanceOf(DemoError);
    expect((err as DemoError).badInput).toBe(false);
  });

  it("maps a network throw to a non-input DemoError", async () => {
    const impl: FetchLike = () => Promise.reject(new Error("offline"));
    const err = await fetchDemoDeliverable("acme.com", { fetchImpl: impl }).catch((e) => e);
    expect(err).toBeInstanceOf(DemoError);
    expect((err as DemoError).badInput).toBe(false);
  });

  it("maps a 200 non-JSON response to a specific service-unavailable DemoError", async () => {
    const impl: FetchLike = () =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.reject(new SyntaxError("Unexpected token '<'")),
      });
    const err = await fetchDemoDeliverable("acme.com", { fetchImpl: impl }).catch((e) => e);
    expect(err).toBeInstanceOf(DemoError);
    expect((err as DemoError).badInput).toBe(false);
    expect((err as DemoError).message).toContain("non-JSON response");
  });

  it("passes the abort signal through to fetch", async () => {
    const seen: (AbortSignal | undefined)[] = [];
    const impl: FetchLike = (_input, init) => {
      seen.push(init?.signal);
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(plan) });
    };
    const controller = new AbortController();
    await fetchDemoDeliverable("acme.com", { fetchImpl: impl, signal: controller.signal });
    expect(seen[0]).toBe(controller.signal);
  });
});
