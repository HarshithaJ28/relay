import type { Metadata } from "next";
import { EventTypesPage } from "@/components/catalog/event-types-page";

export const metadata: Metadata = { title: "Event types" };

export default function Page() {
  return <EventTypesPage />;
}
