import type { Metadata } from "next";
import { SubscriptionsPage } from "@/components/catalog/subscriptions-page";

export const metadata: Metadata = { title: "Subscriptions" };

export default function Page() {
  return <SubscriptionsPage />;
}
