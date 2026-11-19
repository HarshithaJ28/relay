import { afterEach, describe, expect, it, vi } from "vitest";
import { GET } from "@/app/telemetry.json/route";
import { scrubItem, stripQuery, telemetryConfig } from "@/lib/telemetry/config";
import { resetTelemetry, startTelemetry } from "@/lib/telemetry/telemetry";

afterEach(() => {
  resetTelemetry();
  vi.unstubAllEnvs();
});

describe("telemetry config", () => {
  it("is off unless a collector URL is set", () => {
    expect(telemetryConfig({})).toEqual({ faroUrl: null, version: "dev" });
    expect(telemetryConfig({ RELAY_FARO_URL: "  " }).faroUrl).toBeNull();
  });

  it("accepts HTTPS collectors, and HTTP only on this machine", () => {
    expect(telemetryConfig({ RELAY_FARO_URL: "https://faro.example.com/collect/abc" }).faroUrl).toBe(
      "https://faro.example.com/collect/abc",
    );
    expect(telemetryConfig({ RELAY_FARO_URL: "http://faro.example.com/collect" }).faroUrl).toBeNull();
    expect(telemetryConfig({ RELAY_FARO_URL: "http://localhost:12347/collect" }).faroUrl).toBe(
      "http://localhost:12347/collect",
    );
    expect(telemetryConfig({ RELAY_FARO_URL: "javascript:alert(1)" }).faroUrl).toBeNull();
    expect(telemetryConfig({ RELAY_FARO_URL: "not a url" }).faroUrl).toBeNull();
  });

  it("is read from the environment on each request", async () => {
    vi.stubEnv("RELAY_FARO_URL", "https://faro.example.com/collect");
    vi.stubEnv("RELAY_VERSION", "sha-abc");
    const first = GET();
    expect(await first.json()).toEqual({ faroUrl: "https://faro.example.com/collect", version: "sha-abc" });
    vi.stubEnv("RELAY_FARO_URL", "");
    expect((await GET().json()).faroUrl).toBeNull();
  });

  it("drops the query and fragment from stack-frame file names", () => {
    const item = {
      meta: {},
      payload: {
        value: "boom",
        stacktrace: {
          frames: [
            { filename: "https://relay.example.com/login?next=%2Fdeliveries#x", lineno: 1 },
            { filename: "https://relay.example.com/_next/static/chunks/a.js", lineno: 2 },
            { lineno: 3 },
          ],
        },
      },
    };
    expect(scrubItem(item).payload.stacktrace.frames).toEqual([
      { filename: "https://relay.example.com/login", lineno: 1 },
      { filename: "https://relay.example.com/_next/static/chunks/a.js", lineno: 2 },
      { lineno: 3 },
    ]);
  });

  it("drops the query and fragment from page URLs", () => {
    expect(stripQuery("https://relay.example.com/deliveries?endpoint=e1&status=dead#x")).toBe(
      "https://relay.example.com/deliveries",
    );
  });
});

describe("startTelemetry", () => {
  function fakeSdk() {
    const initializeFaro = vi.fn();
    const getWebInstrumentations = vi.fn((opts: unknown) => [opts]);
    const load = vi.fn(async () => ({ initializeFaro, getWebInstrumentations }));
    return { initializeFaro, getWebInstrumentations, load: load as never };
  }

  it("does not load the SDK when telemetry is off", async () => {
    const sdk = fakeSdk();
    expect(await startTelemetry(async () => ({ faroUrl: null, version: "dev" }), sdk.load)).toBe(false);
    expect(sdk.load).not.toHaveBeenCalled();
  });

  it("does not load the SDK when the config cannot be read", async () => {
    const sdk = fakeSdk();
    const failing = async () => {
      throw new Error("offline");
    };
    expect(await startTelemetry(failing, sdk.load)).toBe(false);
    expect(sdk.load).not.toHaveBeenCalled();
  });

  it("sends errors and web vitals only, without console, resource timings or query strings", async () => {
    const sdk = fakeSdk();
    const config = { faroUrl: "https://faro.example.com/collect", version: "sha-abc" };
    expect(await startTelemetry(async () => config, sdk.load)).toBe(true);
    expect(sdk.getWebInstrumentations).toHaveBeenCalledWith({
      captureConsole: false,
      enablePerformanceInstrumentation: false,
      enableContentSecurityPolicyInstrumentation: false,
    });
    const options = sdk.initializeFaro.mock.calls[0]?.[0];
    expect(options).toMatchObject({
      url: config.faroUrl,
      app: { name: "relay-console", version: "sha-abc" },
    });
    expect(options).not.toHaveProperty("user");
    const item = { meta: { page: { url: "https://relay.example.com/deliveries?status=dead" } } };
    expect(options.beforeSend(item).meta.page.url).toBe("https://relay.example.com/deliveries");
  });

  it("starts once per page", async () => {
    const sdk = fakeSdk();
    const config = async () => ({ faroUrl: "https://faro.example.com/collect", version: "dev" });
    await startTelemetry(config, sdk.load);
    expect(await startTelemetry(config, sdk.load)).toBe(false);
    expect(sdk.initializeFaro).toHaveBeenCalledTimes(1);
  });
});
