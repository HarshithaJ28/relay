import type { Metadata } from "next";
import { EndpointHealthPage } from "@/components/health/endpoint-health";

export const metadata: Metadata = { title: "Endpoint health" };

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <EndpointHealthPage id={id} />;
}
