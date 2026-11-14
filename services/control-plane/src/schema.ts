/**
 * Drizzle definitions of the tables the control plane reads and writes. Each lists only the
 * columns relay_control is granted, so a query can never select a password hash, key hash or
 * token hash by accident. Migrations stay plain SQL in db/migrations (one schema owner for
 * both languages); these definitions follow them.
 */
import {
  bigint,
  boolean,
  date,
  integer,
  jsonb,
  pgSchema,
  smallint,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

const control = pgSchema("control");
const delivery = pgSchema("delivery");
const tz = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });

export const plans = control.table("plans", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  priceCents: integer("price_cents").notNull(),
  eventsPerMonth: integer("events_per_month").notNull(),
  ingestRatePerSec: integer("ingest_rate_per_sec").notNull(),
  ingestBurst: integer("ingest_burst").notNull(),
  maxEndpoints: integer("max_endpoints").notNull(),
  retentionDays: integer("retention_days").notNull(),
  dispatchCap: integer("dispatch_cap").notNull(),
});

export const tenants = control.table("tenants", {
  id: uuid("id").primaryKey(),
  name: text("name").notNull(),
  planId: text("plan_id").notNull(),
  status: text("status").notNull(),
  retentionDays: integer("retention_days").notNull(),
  ingestRatePerSec: integer("ingest_rate_per_sec").notNull(),
  ingestBurst: integer("ingest_burst").notNull(),
  dispatchCap: integer("dispatch_cap").notNull(),
  createdAt: tz("created_at").notNull(),
});

export const users = control.table("users", {
  id: uuid("id").primaryKey(),
  tenantId: uuid("tenant_id").notNull(),
  email: text("email").notNull(),
  role: text("role").notNull(),
  createdAt: tz("created_at").notNull(),
});

export const endpoints = control.table("endpoints", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull(),
  url: text("url").notNull(),
  status: text("status").notNull(),
  concurrencyLimit: integer("concurrency_limit").notNull(),
  signingSecrets: jsonb("signing_secrets").notNull(),
  breakerUntil: tz("breaker_until"),
  transformationId: uuid("transformation_id"),
  createdAt: tz("created_at").notNull().defaultNow(),
});

export const eventTypes = control.table("event_types", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull(),
  name: text("name").notNull(),
  createdAt: tz("created_at").notNull().defaultNow(),
});

export const subscriptions = control.table("subscriptions", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull(),
  endpointId: uuid("endpoint_id").notNull(),
  eventTypeId: uuid("event_type_id").notNull(),
  createdAt: tz("created_at").notNull().defaultNow(),
});

export const apiKeys = control.table("api_keys", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull(),
  prefix: text("prefix").notNull(),
  name: text("name").notNull(),
  scopes: text("scopes").array().notNull(),
  createdAt: tz("created_at").notNull().defaultNow(),
  revokedAt: tz("revoked_at"),
  lastUsedAt: tz("last_used_at"),
});

export const usageDaily = control.table("usage_daily", {
  tenantId: uuid("tenant_id").notNull(),
  day: date("day", { mode: "string" }).notNull(),
  eventsIngested: bigint("events_ingested", { mode: "number" }).notNull(),
  attempts: bigint("attempts", { mode: "number" }).notNull(),
  successes: bigint("successes", { mode: "number" }).notNull(),
});

export const billingAccounts = control.table("billing_accounts", {
  tenantId: uuid("tenant_id").primaryKey(),
  stripeCustomerId: text("stripe_customer_id"),
  stripeSubscriptionId: text("stripe_subscription_id"),
  status: text("status").notNull(),
  updatedAt: tz("updated_at").notNull(),
});

export const events = delivery.table("events", {
  id: uuid("id").notNull(),
  tenantId: uuid("tenant_id").notNull(),
  eventType: text("event_type").notNull(),
  payload: jsonb("payload").notNull(),
  createdAt: tz("created_at").notNull(),
});

export const deliveries = delivery.table("deliveries", {
  id: uuid("id").primaryKey(),
  tenantId: uuid("tenant_id").notNull(),
  endpointId: uuid("endpoint_id").notNull(),
  eventId: uuid("event_id").notNull(),
  eventCreatedAt: tz("event_created_at").notNull(),
  status: text("status").notNull(),
  attemptCount: smallint("attempt_count").notNull(),
  nextAttemptAt: tz("next_attempt_at").notNull(),
  messageId: uuid("message_id").notNull(),
  replayOf: uuid("replay_of"),
  lastErrorClass: text("last_error_class"),
  createdAt: tz("created_at").notNull(),
  updatedAt: tz("updated_at").notNull(),
});

export const attempts = delivery.table("delivery_attempts", {
  id: bigint("id", { mode: "number" }).primaryKey(),
  deliveryId: uuid("delivery_id").notNull(),
  tenantId: uuid("tenant_id"),
  attemptNo: integer("attempt_no").notNull(),
  counted: boolean("counted").notNull(),
  outcome: text("outcome").notNull(),
  statusCode: integer("status_code"),
  errorClass: text("error_class"),
  createdAt: tz("created_at").notNull(),
});
