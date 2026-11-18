"use client";
import { useQueryClient } from "@tanstack/react-query";
import { type ColumnDef, flexRender, getCoreRowModel, useReactTable } from "@tanstack/react-table";
import { Plus } from "lucide-react";
import Link from "next/link";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { ProblemMessage } from "@/components/problem-message";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  type Endpoint,
  endpointKeys,
  useCreateEndpoint,
  useDeleteEndpoint,
  useEndpoints,
  useRotateSecret,
  useSendTestEvent,
  useUpdateEndpoint,
} from "@/lib/api/endpoints";
import { type Problem, toProblem } from "@/lib/api/problem";
import { RequireRole } from "@/lib/auth/require-role";
import { formatDate, formatRelative } from "@/lib/format";
import { useLiveEvents } from "@/lib/live/context";
import { EndpointForm } from "./endpoint-form";
import { SecretOnce } from "./secret-once";

type Open =
  | { kind: "none" }
  | { kind: "create" }
  | { kind: "edit"; endpoint: Endpoint }
  | { kind: "rotate"; endpoint: Endpoint }
  | { kind: "delete"; endpoint: Endpoint }
  | { kind: "secret"; secret: string; title: string };

export function StatusBadge({ endpoint }: { endpoint: Endpoint }) {
  if (endpoint.status === "enabled") return <Badge tone="success">Enabled</Badge>;
  if (endpoint.status === "disabled") return <Badge>Disabled</Badge>;
  return (
    <Badge tone="danger">
      Breaker open{endpoint.breaker_until ? ` · retry ${formatRelative(endpoint.breaker_until)}` : ""}
    </Badge>
  );
}

export function EndpointsPage() {
  const list = useEndpoints();
  const qc = useQueryClient();
  // An endpoint's breaker opened: refresh the list so its badge changes.
  useLiveEvents((e) => {
    if (e.type === "breaker") void qc.invalidateQueries({ queryKey: endpointKeys.all });
  });
  const [open, setOpen] = useState<Open>({ kind: "none" });
  const close = () => setOpen({ kind: "none" });

  const columns = useMemo<ColumnDef<Endpoint>[]>(
    () => [
      {
        header: "URL",
        accessorKey: "url",
        cell: (c) => (
          <Link href={`/endpoints/${c.row.original.id}`} className="break-all hover:underline">
            {c.row.original.url}
          </Link>
        ),
      },
      { header: "Status", id: "status", cell: (c) => <StatusBadge endpoint={c.row.original} /> },
      { header: "Concurrency", accessorKey: "concurrency_limit" },
      { header: "Created", id: "created", cell: (c) => formatDate(c.row.original.created_at) },
      {
        header: () => <span className="sr-only">Actions</span>,
        id: "actions",
        cell: (c) => (
          <RequireRole action="endpoints:write">
            <RowActions endpoint={c.row.original} onOpen={setOpen} />
          </RequireRole>
        ),
      },
    ],
    [],
  );
  const table = useReactTable({ data: list.data ?? [], columns, getCoreRowModel: getCoreRowModel() });

  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-xl font-semibold">Endpoints</h1>
        <RequireRole action="endpoints:write">
          <Button onClick={() => setOpen({ kind: "create" })}>
            <Plus className="size-4" /> Add endpoint
          </Button>
        </RequireRole>
      </div>

      {list.error ? <ProblemMessage problem={toProblem(list.error)} /> : null}
      {list.isPending ? <p className="text-sm text-muted-foreground">Loading endpoints…</p> : null}
      {list.data?.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No endpoints yet. Add the URL that should receive your webhooks.
        </p>
      ) : null}
      {list.data?.length ? (
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full text-left text-sm">
            <thead className="bg-muted text-muted-foreground">
              {table.getHeaderGroups().map((g) => (
                <tr key={g.id}>
                  {g.headers.map((h) => (
                    <th key={h.id} scope="col" className="px-3 py-2 font-medium">
                      {flexRender(h.column.columnDef.header, h.getContext())}
                    </th>
                  ))}
                </tr>
              ))}
            </thead>
            <tbody>
              {table.getRowModel().rows.map((row) => (
                <tr key={row.id} className="border-t border-border align-top">
                  {row.getVisibleCells().map((cell) => (
                    <td key={cell.id} className="px-3 py-2">
                      {flexRender(cell.column.columnDef.cell, cell.getContext())}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      <Dialog open={open.kind !== "none"} onOpenChange={(o) => !o && close()}>
        {open.kind === "create" ? (
          <CreateDialog onSecret={(secret) => setOpen({ kind: "secret", secret, title: "Endpoint added" })} />
        ) : null}
        {open.kind === "edit" ? <EditDialog endpoint={open.endpoint} onDone={close} /> : null}
        {open.kind === "rotate" ? (
          <RotateDialog
            endpoint={open.endpoint}
            onSecret={(secret) => setOpen({ kind: "secret", secret, title: "New signing secret" })}
          />
        ) : null}
        {open.kind === "delete" ? <DeleteDialog endpoint={open.endpoint} onDone={close} /> : null}
        {open.kind === "secret" ? (
          <DialogContent title={open.title} onInteractOutside={(e) => e.preventDefault()}>
            <SecretOnce secret={open.secret} onDone={close} />
          </DialogContent>
        ) : null}
      </Dialog>
    </section>
  );
}

function RowActions({ endpoint, onOpen }: { endpoint: Endpoint; onOpen: (o: Open) => void }) {
  const update = useUpdateEndpoint(endpoint.id);
  const test = useSendTestEvent();
  const report = (p: Problem) => toast.error(p.title, { description: p.detail });
  return (
    <div className="flex flex-wrap justify-end gap-1">
      <Button variant="ghost" size="sm" onClick={() => onOpen({ kind: "edit", endpoint })}>
        Edit
      </Button>
      <Button
        variant="ghost"
        size="sm"
        disabled={update.isPending}
        onClick={() =>
          update
            .mutateAsync({ status: endpoint.status === "disabled" ? "enabled" : "disabled" })
            .catch((e) => report(toProblem(e)))
        }
      >
        {endpoint.status === "disabled" ? "Enable" : "Disable"}
      </Button>
      <Button
        variant="ghost"
        size="sm"
        disabled={test.isPending}
        onClick={() =>
          test
            .mutateAsync(endpoint.id)
            .then(() => toast.success("Test event sent", { description: "It appears in Deliveries." }))
            .catch((e) => report(toProblem(e)))
        }
      >
        Send test
      </Button>
      <Button variant="ghost" size="sm" onClick={() => onOpen({ kind: "rotate", endpoint })}>
        Rotate secret
      </Button>
      <Button
        variant="ghost"
        size="sm"
        className="text-destructive"
        onClick={() => onOpen({ kind: "delete", endpoint })}
      >
        Delete
      </Button>
    </div>
  );
}

function CreateDialog({ onSecret }: { onSecret: (secret: string) => void }) {
  const create = useCreateEndpoint();
  return (
    <DialogContent title="Add endpoint" description="Relay signs every request it sends here.">
      <EndpointForm
        submitLabel="Add endpoint"
        onSubmit={async (values) => {
          const { secret } = await create.mutateAsync(values);
          onSecret(secret);
        }}
      />
    </DialogContent>
  );
}

function EditDialog({ endpoint, onDone }: { endpoint: Endpoint; onDone: () => void }) {
  const update = useUpdateEndpoint(endpoint.id);
  return (
    <DialogContent title="Edit endpoint">
      <EndpointForm
        submitLabel="Save"
        initial={{ url: endpoint.url, concurrency_limit: endpoint.concurrency_limit }}
        onSubmit={async (values) => {
          await update.mutateAsync(values);
          toast.success("Endpoint saved");
          onDone();
        }}
      />
    </DialogContent>
  );
}

function RotateDialog({ endpoint, onSecret }: { endpoint: Endpoint; onSecret: (secret: string) => void }) {
  const rotate = useRotateSecret(endpoint.id);
  const [hours, setHours] = useState(24);
  const [problem, setProblem] = useState<Problem | null>(null);
  return (
    <DialogContent
      title="Rotate signing secret"
      description="Relay creates a new secret and keeps the current one valid for an overlap. During the overlap every request carries a signature from both, so your receiver can switch without dropping webhooks."
    >
      <div className="space-y-4">
        {problem ? <ProblemMessage problem={problem} /> : null}
        <div className="space-y-1.5">
          <Label htmlFor="overlap">Keep the current secret valid for (hours)</Label>
          <Input
            id="overlap"
            type="number"
            min={0}
            max={168}
            value={hours}
            onChange={(e) => setHours(Number(e.target.value))}
          />
        </div>
        <div className="flex justify-end">
          <Button
            disabled={rotate.isPending || !Number.isInteger(hours) || hours < 0 || hours > 168}
            onClick={async () => {
              setProblem(null);
              try {
                const { secret } = await rotate.mutateAsync(hours);
                onSecret(secret);
              } catch (e) {
                setProblem(toProblem(e));
              }
            }}
          >
            Rotate
          </Button>
        </div>
      </div>
    </DialogContent>
  );
}

function DeleteDialog({ endpoint, onDone }: { endpoint: Endpoint; onDone: () => void }) {
  const remove = useDeleteEndpoint();
  const [problem, setProblem] = useState<Problem | null>(null);
  return (
    <DialogContent
      title="Delete endpoint"
      description="The endpoint is disabled and unsubscribed. Its delivery history is kept."
    >
      <div className="space-y-4">
        <p className="text-sm break-all">{endpoint.url}</p>
        {problem ? <ProblemMessage problem={problem} /> : null}
        <div className="flex justify-end">
          <Button
            variant="destructive"
            disabled={remove.isPending}
            onClick={async () => {
              try {
                await remove.mutateAsync(endpoint.id);
                toast.success("Endpoint deleted");
                onDone();
              } catch (e) {
                setProblem(toProblem(e));
              }
            }}
          >
            Delete
          </Button>
        </div>
      </div>
    </DialogContent>
  );
}
