import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import type Stripe from "stripe";
import { z } from "zod";
import { withoutTenant, withTenant } from "../db.js";
import { Problem } from "../problem.js";

/**
 * Stripe billing in test mode (spec section 8). Checkout moves a tenant to the paid plan;
 * subscription changes move it back. The webhook is verified by Stripe's signature over the
 * raw body and applied once per Stripe event id (control.apply_stripe_event).
 */
export async function billingRoutes(app: FastifyInstance) {
  const api = app.withTypeProvider<ZodTypeProvider>();
  const { db, config, stripe } = app.deps;
  const owner = { onRequest: [app.authenticate, app.requireRole("owner")] };

  const unavailable = () => new Problem(503, "billing-unavailable", "Billing is not configured");

  api.post("/billing/checkout-session", { ...owner }, async (request) => {
    if (!stripe || !config.stripe.pricePro) throw unavailable();
    const tenantId = request.principal.tenantId;
    const customer = await withTenant(db, tenantId, async (tx) => {
      const r = await tx.query("SELECT stripe_customer_id FROM control.billing_accounts");
      return (r.rows[0]?.stripe_customer_id as string | undefined) ?? undefined;
    });
    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      line_items: [{ price: config.stripe.pricePro, quantity: 1 }],
      client_reference_id: tenantId,
      ...(customer ? { customer } : {}),
      success_url: `${config.publicUrl}/billing?checkout=success`,
      cancel_url: `${config.publicUrl}/billing?checkout=cancelled`,
    });
    return { url: session.url };
  });

  // The raw body is needed to check Stripe's signature, so this route parses its own body.
  await app.register(async (hook) => {
    hook.addContentTypeParser("application/json", { parseAs: "buffer" }, (_req, body, done) =>
      done(null, body),
    );
    hook.post("/billing/webhook", { schema: { hide: true, security: [] } }, async (request, reply) => {
      if (!stripe || !config.stripe.webhookSecret) throw unavailable();
      const signature = request.headers["stripe-signature"];
      let event: Stripe.Event;
      try {
        event = stripe.webhooks.constructEvent(
          request.body as Buffer,
          String(signature ?? ""),
          config.stripe.webhookSecret,
        );
      } catch {
        throw new Problem(400, "invalid-signature", "Stripe signature did not verify");
      }
      const applied = await applyEvent(event);
      return reply.send({ received: true, applied });
    });
  });

  async function applyEvent(event: Stripe.Event): Promise<boolean> {
    let tenantId: string | null = null;
    let customer: string | null = null;
    let subscription: string | null = null;
    let status: string | null = null;
    switch (event.type) {
      case "checkout.session.completed": {
        const s = event.data.object as Stripe.Checkout.Session;
        tenantId = z.string().uuid().safeParse(s.client_reference_id).success
          ? (s.client_reference_id as string)
          : null;
        customer = typeof s.customer === "string" ? s.customer : (s.customer?.id ?? null);
        subscription = typeof s.subscription === "string" ? s.subscription : (s.subscription?.id ?? null);
        status = s.payment_status === "paid" || s.status === "complete" ? "active" : "incomplete";
        break;
      }
      case "customer.subscription.created":
      case "customer.subscription.updated":
      case "customer.subscription.deleted": {
        const s = event.data.object as Stripe.Subscription;
        customer = typeof s.customer === "string" ? s.customer : s.customer.id;
        subscription = s.id;
        status = event.type === "customer.subscription.deleted" ? "canceled" : s.status;
        break;
      }
      default:
        return false; // other event types are acknowledged and ignored
    }
    return withoutTenant(db, async (tx) => {
      const r = await tx.query("SELECT control.apply_stripe_event($1, $2, $3, $4, $5, $6) AS applied", [
        event.id,
        event.type,
        tenantId,
        customer,
        subscription,
        status,
      ]);
      return Boolean(r.rows[0]?.applied);
    });
  }
}
