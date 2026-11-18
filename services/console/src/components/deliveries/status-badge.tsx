import { Badge } from "@/components/ui/badge";
import type { DeliveryStatus } from "@/lib/api/deliveries";

const LABEL: Record<DeliveryStatus, string> = {
  scheduled: "Scheduled",
  queued: "Queued",
  in_flight: "Sending",
  succeeded: "Succeeded",
  dead: "Failed",
  cancelled: "Cancelled",
};
const TONE = {
  scheduled: "neutral",
  queued: "neutral",
  in_flight: "warning",
  succeeded: "success",
  dead: "danger",
  cancelled: "neutral",
} as const;

export function DeliveryStatusBadge({ status }: { status: DeliveryStatus }) {
  return <Badge tone={TONE[status]}>{LABEL[status]}</Badge>;
}
