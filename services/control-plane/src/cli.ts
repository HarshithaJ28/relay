/**
 * Operator commands.
 *
 *   node dist/cli.js create-invite [--days N] [--note TEXT]
 *
 * Connects with RELAY_OPERATOR_DSN as relay_owner, the only role that may create invites.
 * Prints the code once; only its hash is stored. Days: 1 to 30, default 7.
 */
import { parseArgs } from "node:util";
import pg from "pg";
import { toConnectionString } from "./db.js";
import { generateInvite, inviteHash } from "./invites.js";

export async function createInvite(dsn: string, days: number, note: string): Promise<string> {
  const code = generateInvite();
  const client = new pg.Client({ connectionString: toConnectionString(dsn) });
  await client.connect();
  try {
    await client.query("SELECT control.create_invite($1, make_interval(days => $2), $3)", [
      inviteHash(code),
      days,
      note,
    ]);
  } finally {
    await client.end();
  }
  return code;
}

async function main(argv: string[]): Promise<number> {
  const { positionals, values } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: { days: { type: "string", default: "7" }, note: { type: "string", default: "" } },
  });
  if (positionals[0] !== "create-invite" || positionals.length !== 1) {
    process.stderr.write("usage: cli.js create-invite [--days N] [--note TEXT]\n");
    return 2;
  }
  const days = Number(values.days);
  const dsn = process.env.RELAY_OPERATOR_DSN;
  if (!dsn || !Number.isInteger(days) || days < 1 || days > 30 || values.note.length > 200) {
    process.stderr.write(
      "configuration error: set RELAY_OPERATOR_DSN; --days 1-30; --note up to 200 characters\n",
    );
    return 2;
  }
  process.stdout.write(`${await createInvite(dsn, days, values.note)}\n`);
  return 0;
}

if (process.argv[1]?.endsWith("cli.js")) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (e) => {
      process.stderr.write(`error: ${(e as Error).message}\n`);
      process.exit(1);
    },
  );
}
