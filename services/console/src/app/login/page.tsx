"use client";
import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { LoginForm } from "@/components/login-form";
import { useSession } from "@/lib/auth/context";

export default function LoginPage() {
  const router = useRouter();
  const { state } = useSession();
  useEffect(() => {
    if (state.status === "authenticated") router.replace("/");
  }, [state.status, router]);
  return (
    <main className="mx-auto flex min-h-dvh max-w-sm flex-col justify-center px-4">
      <h1 className="mb-1 text-2xl font-semibold">Sign in to Relay</h1>
      <p className="mb-6 text-sm text-muted-foreground">Webhook delivery console</p>
      <LoginForm onSuccess={() => router.replace("/")} />
    </main>
  );
}
