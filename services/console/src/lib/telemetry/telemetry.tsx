"use client";
import { useEffect } from "react";
import { scrubItem, type TelemetryConfig } from "./config";

let started = false;

/**
 * Starts Grafana Faro when the server names a collector: uncaught errors, unhandled rejections
 * and web vitals. No console capture, no resource timings, no request bodies and no user
 * identity; page URLs and stack-frame file names are sent without their query or fragment. The SDK is loaded only when it is on.
 */
export async function startTelemetry(
  load: () => Promise<TelemetryConfig> = async () => (await fetch("/telemetry.json")).json(),
  sdk: () => Promise<typeof import("@grafana/faro-web-sdk")> = () => import("@grafana/faro-web-sdk"),
): Promise<boolean> {
  if (started) return false;
  started = true;
  let config: TelemetryConfig;
  try {
    config = await load();
  } catch {
    return false;
  }
  if (!config.faroUrl) return false;
  const { initializeFaro, getWebInstrumentations } = await sdk();
  initializeFaro({
    url: config.faroUrl,
    app: { name: "relay-console", version: config.version },
    instrumentations: getWebInstrumentations({
      captureConsole: false,
      enablePerformanceInstrumentation: false,
      enableContentSecurityPolicyInstrumentation: false,
    }),
    beforeSend: (item) => scrubItem(item),
  });
  return true;
}

/** For tests: forget that telemetry was started. */
export function resetTelemetry() {
  started = false;
}

export function Telemetry() {
  useEffect(() => {
    void startTelemetry();
  }, []);
  return null;
}
