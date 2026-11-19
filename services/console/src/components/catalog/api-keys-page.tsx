"use client";
import { Plus } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { SecretOnce } from "@/components/endpoints/secret-once";
import { ProblemMessage } from "@/components/problem-message";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmButton } from "@/components/ui/confirm";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SCOPES, useApiKeys, useCreateApiKey, useRevokeApiKey } from "@/lib/api/catalog";
import { type Problem, toProblem } from "@/lib/api/problem";
import { RoleGate } from "@/lib/auth/role-gate";
import { formatDate, formatRelative } from "@/lib/format";
import { DataTable } from "./table";

export function ApiKeysPage() {
  return (
    <RoleGate action="api-keys:manage">
      <ApiKeys />
    </RoleGate>
  );
}

function ApiKeys() {
  const keys = useApiKeys(true);
  const revoke = useRevokeApiKey();
  const [dialog, setDialog] = useState<{ kind: "none" } | { kind: "create" } | { kind: "key"; key: string }>({
    kind: "none",
  });
  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="text-xl font-semibold">API keys</h1>
          <p className="text-sm text-muted-foreground">Keys your backend uses to send events to Relay.</p>
        </div>
        <Button onClick={() => setDialog({ kind: "create" })}>
          <Plus className="size-4" /> Create key
        </Button>
      </div>
      {keys.error ? <ProblemMessage problem={toProblem(keys.error)} /> : null}
      {keys.data?.length === 0 ? <p className="text-sm text-muted-foreground">No API keys yet.</p> : null}
      {keys.data?.length ? (
        <DataTable
          label="API keys"
          headers={["Key", "Name", "Scopes", "Created", "Last used", ""]}
          rows={keys.data.map((k) => [
            <code key="p" className="text-xs">
              rly_{k.prefix}_…
            </code>,
            k.name || "—",
            k.scopes.join(", "),
            formatDate(k.createdAt),
            k.lastUsedAt ? formatRelative(k.lastUsedAt) : "Never",
            k.revokedAt ? (
              <Badge key="r">Revoked {formatDate(k.revokedAt)}</Badge>
            ) : (
              <ConfirmButton
                key="r"
                label="Revoke"
                title="Revoke API key"
                description={`Requests using rly_${k.prefix}_… are refused from now on (within 30 seconds, while servers' caches expire). This cannot be undone.`}
                onConfirm={async () => {
                  await revoke.mutateAsync(k.id);
                  toast.success("Key revoked");
                }}
              />
            ),
          ])}
        />
      ) : null}
      <Dialog open={dialog.kind !== "none"} onOpenChange={(o) => !o && setDialog({ kind: "none" })}>
        {dialog.kind === "create" ? <CreateKey onKey={(key) => setDialog({ kind: "key", key })} /> : null}
        {dialog.kind === "key" ? (
          <DialogContent title="API key created" onInteractOutside={(e) => e.preventDefault()}>
            <SecretOnce
              secret={dialog.key}
              what="API key"
              again="if it is lost, revoke it and create another"
              onDone={() => setDialog({ kind: "none" })}
            />
          </DialogContent>
        ) : null}
      </Dialog>
    </section>
  );
}

function CreateKey({ onKey }: { onKey: (key: string) => void }) {
  const create = useCreateApiKey();
  const [name, setName] = useState("");
  const [scopes, setScopes] = useState<Array<(typeof SCOPES)[number]>>([...SCOPES]);
  const [problem, setProblem] = useState<Problem | null>(null);
  return (
    <DialogContent title="Create API key">
      <form
        className="space-y-4"
        onSubmit={async (e) => {
          e.preventDefault();
          setProblem(null);
          try {
            onKey(await create.mutateAsync({ name: name.trim(), scopes }));
          } catch (err) {
            setProblem(toProblem(err));
          }
        }}
      >
        {problem ? <ProblemMessage problem={problem} /> : null}
        <div className="space-y-1.5">
          <Label htmlFor="key-name">Name (optional)</Label>
          <Input
            id="key-name"
            maxLength={200}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="production backend"
          />
        </div>
        <fieldset className="space-y-2">
          <legend className="text-sm font-medium">Scopes</legend>
          {SCOPES.map((s) => (
            <label key={s} className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={scopes.includes(s)}
                onChange={(e) =>
                  setScopes((cur) => (e.target.checked ? [...cur, s] : cur.filter((x) => x !== s)))
                }
              />
              {s === "events:write" ? "events:write — send events" : "events:read — read events back"}
            </label>
          ))}
          {scopes.length === 0 ? (
            <p className="text-sm text-destructive">Choose at least one scope.</p>
          ) : null}
        </fieldset>
        <div className="flex justify-end">
          <Button type="submit" disabled={create.isPending || scopes.length === 0}>
            Create key
          </Button>
        </div>
      </form>
    </DialogContent>
  );
}
