import { telemetryConfig } from "@/lib/telemetry/config";

// Read the environment on every request, not once at build time.
export const dynamic = "force-dynamic";

export function GET() {
  return Response.json(telemetryConfig(process.env), {
    headers: { "Cache-Control": "public, max-age=300" },
  });
}
