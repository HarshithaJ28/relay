import type { Metadata } from "next";
import { ApiKeysPage } from "@/components/catalog/api-keys-page";

export const metadata: Metadata = { title: "API keys" };

export default function Page() {
  return <ApiKeysPage />;
}
