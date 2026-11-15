# Deploying Relay

One k3s node (Oracle Cloud Always Free), two Helm charts, and a deploy job in CI. Nothing
here has been deployed yet; see the README's Known limitations.

## 1. The machine (Terraform)

```bash
cd deploy/terraform/oci/bootstrap && terraform init && terraform apply
```

This creates the bucket that holds the main stack's state. Then create a Customer Secret Key
for your OCI user (Identity > Users > Customer secret keys) and copy
`deploy/terraform/oci/backend.hcl.example` to `backend.hcl` with the bootstrap outputs.

```bash
cd deploy/terraform/oci
export AWS_ACCESS_KEY_ID=<customer secret key id> AWS_SECRET_ACCESS_KEY=<its secret>
terraform init -backend-config=backend.hcl
terraform apply -var region=... -var compartment_ocid=... -var admin_cidr=<your IP>/32 \
  -var ssh_public_key="$(cat ~/.ssh/id_ed25519.pub)"
```

The machine is an Ampere A1 with 2 OCPUs and 12 GB (variables `ocpus` and `memory_gb`,
validated against the Always Free limits). Cloud-init opens ports 80, 443 and 6443 in the host
firewall and installs k3s. SSH and port 6443 are reachable only from `admin_cidr`. Point the
DuckDNS name at the `public_ip` output.

`deploy/terraform/aws` is a comparison only. CI validates it and never applies it.

## 2. The Secret

Both charts read one Secret, `relay-secrets`, in the `relay` namespace. Generate every value
(for example `openssl rand -hex 24`). Use hex or other URL-safe values: the passwords are
placed inside connection strings.

| Key | Used by |
| --- | --- |
| `postgres-password` | PostgreSQL superuser (relay-datastores) |
| `postgres-superuser-url` | migration job: `postgres://postgres:<pw>@relay-postgres:5432/relay?sslmode=disable` |
| `password-tenant`, `password-control`, `password-scheduler`, `password-publisher`, `password-worker`, `password-reaper`, `password-retention` | each service's own database role |
| `password-owner` | optional: lets the operator log in as `relay_owner` to create invite codes |
| `amqp-password` | RabbitMQ user `relay` |
| `valkey-password` | Valkey `requirepass` |
| `jwt-secret` | control plane access tokens (at least 32 characters) |
| `secret-keys` | master keys for endpoint signing secrets: `k1:<base64 of 32 random bytes>` |
| `stripe-secret-key`, `stripe-webhook-secret`, `stripe-price-pro` | optional, Stripe test mode |

```bash
kubectl create namespace relay
kubectl -n relay create secret generic relay-secrets --from-literal=... # every key above
```

## 3. The charts

```bash
helm install relay-data deploy/helm/relay-datastores -n relay --wait
helm install relay deploy/helm/relay -n relay --wait -f production-values.yaml
helm test relay -n relay --logs
```

- `relay-datastores`: single-node PostgreSQL 16 and RabbitMQ 3.13 on persistent volumes, and
  Valkey 8.1 without persistence. Valkey holds only counters, breaker state and pub/sub, so a
  restart resets rate limits, login locks and breaker windows.
- `relay`: the six data-plane processes, the control plane and the Ingress. Before every
  install and upgrade, a hook Job (image `relay-migrations`) applies new migrations, each in
  one transaction, and sets each role's password.
- `production-values.yaml` is not in git. It sets `ingress.host`, `publicUrl`,
  `tls.issuer: letsencrypt` with `tls.email`, and, in `networkPolicy.extraBlockedCidrs`, the
  node's public IP as a `/32`.

### TLS

cert-manager issues and renews the certificate for `ingress.host` from Let's Encrypt (HTTP-01
through Traefik, so port 80 must be open, which the Terraform security list does). Install it
once before the charts; the deploy workflow does this on every run:

```bash
helm upgrade --install cert-manager cert-manager --repo https://charts.jetstack.io \
  --version v1.21.3 -n cert-manager --create-namespace --set crds.enabled=true --wait
```

`tls.issuer` is `none` (bring your own Secret), `letsencrypt` or `selfsigned` (CI). To try Let's
Encrypt without its production rate limits, set `tls.acmeServer` to
`https://acme-staging-v02.api.letsencrypt.org/directory` first.

## 4. Network policy (the second SSRF layer)

Every pod in both releases is denied in both directions unless a policy allows it.

- **Worker:** may reach DNS, the three datastores, and public IPv4 only. Private,
  loopback, CGNAT, link-local (including the `169.254.169.254` metadata address), reserved
  and multicast ranges are excluded, and those also cover pod, service and node addresses.
- **Control plane:** may reach DNS, PostgreSQL, Valkey, and public HTTPS (Stripe).
- **Other data-plane processes:** may reach DNS and the datastores only.
- **Datastores:** accept connections only from the components that use them.

`helm test` runs a pod with the worker's labels that tries to reach the Kubernetes API, the
control plane, ingestion, the node's kubelet, k3s API and SSH ports, the metadata address and
each extra blocked address. It fails if any connection still succeeds after `egressSmokeTest.waitSeconds`
(default 60): k3s's policy controller programs a new pod's rules a few seconds after the pod starts, so the
first attempts may get through. The same delay applies to every new pod, including workers. In CI the same test runs on
real k3s, and is also run with the policies switched off to show that it then fails.

## 5. Continuous deployment

`.github/workflows/deploy.yml` runs after the Image workflow succeeds on `main`, once the
repository variable `DEPLOY_ENABLED` is `true`. It needs the secrets listed at the top of that
file in the `production` environment. It opens an SSH tunnel to the k3s API, upgrades both
releases with the commit's `sha-<commit>` images (`--atomic` rolls back on failure) and runs
the egress smoke test. If the GHCR packages are private, add a docker-registry Secret and set
`images.pullSecrets`.

## 6. Status page

`site/index.html` is a static page on GitHub Pages that stays up when the demo is down. It
tries the demo's API from the visitor's browser and says whether it answered, and links to the
code and docs. To publish it, once:

1. Repository settings > Pages > Source: **GitHub Actions**.
2. Repository variable `RELAY_PUBLIC_URL`, for example `https://relay.example.duckdns.org`.
   Without it the page says the demo is not deployed yet.

`.github/workflows/pages.yml` then publishes it on every change to `site/` on `main`.
