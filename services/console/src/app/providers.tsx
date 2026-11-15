"use client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ThemeProvider } from "next-themes";
import { type ReactNode, useState } from "react";
import { Toaster } from "sonner";
import { AuthProvider } from "@/lib/auth/context";
import { LiveProvider } from "@/lib/live/context";

export function Providers({ children }: { children: ReactNode }) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          // network errors and 5xx are retried twice; 4xx answers are shown, not retried
          queries: {
            staleTime: 15_000,
            retry: (count, error) => {
              const status = (error as { problem?: { status?: number } }).problem?.status ?? 0;
              return count < 2 && (status === 0 || status >= 500);
            },
          },
        },
      }),
  );
  return (
    <ThemeProvider attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange>
      <QueryClientProvider client={queryClient}>
        <AuthProvider>
          <LiveProvider>{children}</LiveProvider>
        </AuthProvider>
      </QueryClientProvider>
      <Toaster richColors closeButton />
    </ThemeProvider>
  );
}
