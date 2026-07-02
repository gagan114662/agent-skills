import { describe, expect, it, vi } from "vitest";
import {
  createPinnedPublicWebLookup,
  fetchPinnedPublicWebUrl,
  isBlockedPublicIpv6,
  readPublicWebResponseText,
  validatePublicWebUrl,
  type PublicWebFetch,
} from "../../src/security/public-web-url.js";

describe("public web URL guard", () => {
  it("extracts and blocks private IPv4 addresses embedded in NAT64 well-known IPv6 addresses", () => {
    expect(isBlockedPublicIpv6("64:ff9b::10.0.0.1")).toBe(true);
    expect(isBlockedPublicIpv6("64:ff9b::0a00:0001")).toBe(true);
    expect(isBlockedPublicIpv6("64:ff9b::5db8:d822")).toBe(false);
  });

  it("returns the exact public IP address validated for the target URL", async () => {
    const target = await validatePublicWebUrl("https://example.com/path", async () => [
      { address: "93.184.216.34", family: 4 },
    ]);

    expect(target).toMatchObject({
      address: "93.184.216.34",
      family: 4,
      hostname: "example.com",
    });
    expect(target?.url.href).toBe("https://example.com/path");
  });

  it("pins fetch DNS lookup to the validated hostname and address", async () => {
    const target = await validatePublicWebUrl("https://example.com/", async () => [
      { address: "93.184.216.34", family: 4 },
    ]);
    expect(target).not.toBeNull();

    const lookup = createPinnedPublicWebLookup(target!);
    await expect(
      new Promise<{ address: string; family?: number }>((resolve, reject) => {
        lookup("example.com", {}, (err, address, family) => {
          if (err) reject(err);
          else resolve({ address: String(address), family });
        });
      }),
    ).resolves.toEqual({ address: "93.184.216.34", family: 4 });

    await expect(
      new Promise((resolve, reject) => {
        lookup("attacker.example", {}, (err) => {
          if (err) reject(err);
          else resolve(undefined);
        });
      }),
    ).rejects.toMatchObject({ code: "ENOTFOUND" });

    const fetchImpl = vi.fn<PublicWebFetch>(async () => new Response("<title>ok</title>"));
    const fetched = await fetchPinnedPublicWebUrl(
      target!,
      { method: "GET", redirect: "manual" },
      fetchImpl,
    );
    await fetched.close();
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://example.com/",
      expect.objectContaining({ dispatcher: expect.any(Object), redirect: "manual" }),
    );
  });

  it("returns Node lookup array results when options.all is requested", async () => {
    const target = await validatePublicWebUrl("https://example.com/", async () => [
      { address: "93.184.216.34", family: 4 },
    ]);
    expect(target).not.toBeNull();

    const lookup = createPinnedPublicWebLookup(target!);
    await expect(
      new Promise<Array<{ address: string; family: number }>>((resolve, reject) => {
        lookup("example.com", { all: true }, (err, addresses) => {
          if (err) reject(err);
          else resolve(addresses as Array<{ address: string; family: number }>);
        });
      }),
    ).resolves.toEqual([{ address: "93.184.216.34", family: 4 }]);

    await expect(
      new Promise((resolve, reject) => {
        lookup("attacker.example", { all: true }, (err, addresses) => {
          if (err) reject({ code: err.code, addresses });
          else resolve(addresses);
        });
      }),
    ).rejects.toEqual({ code: "ENOTFOUND", addresses: [] });
  });

  it("rejects oversized responses by content-length before buffering", async () => {
    const res = new Response("tiny", { headers: { "content-length": "9" } });
    await expect(readPublicWebResponseText(res, 8)).resolves.toBeNull();
  });

  it("cancels streaming reads that exceed the byte cap", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([65, 66, 67, 68]));
        controller.enqueue(new Uint8Array([69]));
      },
    });

    await expect(readPublicWebResponseText(new Response(stream), 4)).resolves.toBeNull();
  });
});
