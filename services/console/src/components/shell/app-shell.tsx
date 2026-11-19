"use client";
import { LogOut, Moon, Sun } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useTheme } from "next-themes";
import { type ReactNode, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { useSession } from "@/lib/auth/context";
import { can } from "@/lib/auth/roles";
import { useLive } from "@/lib/live/context";
import { cn } from "@/lib/utils";
import { NAV } from "./nav";

const LIVE_LABEL = {
  off: "Live off",
  connecting: "Connecting",
  open: "Live",
  waiting: "Reconnecting",
} as const;

export function AppShell({ children }: { children: ReactNode }) {
  const { session, state } = useSession();
  const { status } = useLive();
  const { resolvedTheme, setTheme } = useTheme();
  const pathname = usePathname();
  const router = useRouter();

  useEffect(() => {
    if (state.status === "anonymous") router.replace("/login");
  }, [state.status, router]);

  if (state.status !== "authenticated") {
    return (
      <p role="status" className="p-8 text-sm text-muted-foreground">
        Loading…
      </p>
    );
  }
  const { user } = state;
  return (
    <div className="flex min-h-dvh flex-col md:flex-row">
      <nav aria-label="Main" className="border-b border-border md:w-56 md:border-r md:border-b-0">
        <div className="px-4 py-4 text-lg font-semibold">Relay</div>
        <ul className="flex gap-1 overflow-x-auto px-2 pb-2 md:flex-col md:pb-0">
          {NAV.filter((item) => !item.action || can(user.role, item.action)).map((item) => {
            const active = item.href === "/" ? pathname === "/" : pathname.startsWith(item.href);
            return (
              <li key={item.href}>
                <Link
                  href={item.href}
                  aria-current={active ? "page" : undefined}
                  className={cn(
                    "block whitespace-nowrap rounded-md px-3 py-2 text-sm hover:bg-muted",
                    active && "bg-muted font-medium",
                  )}
                >
                  {item.label}
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center justify-end gap-2 border-b border-border px-4 py-2">
          <span className="mr-auto flex items-center gap-2 text-xs text-muted-foreground" role="status">
            <span
              aria-hidden
              className={cn("size-2 rounded-full", status === "open" ? "bg-success" : "bg-warning")}
            />
            {LIVE_LABEL[status]}
          </span>
          <span className="hidden text-sm text-muted-foreground sm:inline">
            {user.email} · {user.role}
          </span>
          <Button
            variant="ghost"
            size="icon"
            aria-label="Toggle dark mode"
            onClick={() => setTheme(resolvedTheme === "dark" ? "light" : "dark")}
          >
            {resolvedTheme === "dark" ? <Sun className="size-4" /> : <Moon className="size-4" />}
          </Button>
          <Button
            variant="ghost"
            size="icon"
            aria-label="Sign out"
            onClick={async () => {
              await session.logout().catch(() => {});
              router.replace("/login");
            }}
          >
            <LogOut className="size-4" />
          </Button>
        </header>
        <main className="flex-1 p-4 md:p-6">{children}</main>
      </div>
    </div>
  );
}
