"use client";
import * as D from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import type { ComponentProps, ReactNode } from "react";
import { cn } from "@/lib/utils";

export const Dialog = D.Root;
export const DialogTrigger = D.Trigger;
export const DialogClose = D.Close;

export function DialogContent({
  title,
  description,
  children,
  className,
  ...props
}: ComponentProps<typeof D.Content> & { title: string; description?: ReactNode }) {
  return (
    <D.Portal>
      <D.Overlay className="fixed inset-0 z-40 bg-black/50" />
      <D.Content
        className={cn(
          "fixed top-1/2 left-1/2 z-50 w-[calc(100vw-2rem)] max-w-lg -translate-x-1/2 -translate-y-1/2 rounded-lg border border-border bg-card p-5 shadow-lg",
          className,
        )}
        {...props}
      >
        <D.Title className="pr-8 text-lg font-semibold">{title}</D.Title>
        {description ? (
          <D.Description className="mt-1 text-sm text-muted-foreground">{description}</D.Description>
        ) : null}
        <div className="mt-4">{children}</div>
        <D.Close className="absolute top-4 right-4 rounded-md p-1 hover:bg-muted" aria-label="Close">
          <X className="size-4" />
        </D.Close>
      </D.Content>
    </D.Portal>
  );
}
