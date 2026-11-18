import type { Metadata } from "next";
import { EndpointsPage } from "@/components/endpoints/endpoints-page";

export const metadata: Metadata = { title: "Endpoints" };

export default function Page() {
  return <EndpointsPage />;
}
