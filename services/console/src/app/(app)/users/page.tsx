import type { Metadata } from "next";
import { UsersPage } from "@/components/catalog/users-page";

export const metadata: Metadata = { title: "Users" };

export default function Page() {
  return <UsersPage />;
}
