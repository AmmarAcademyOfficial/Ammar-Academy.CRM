import "server-only";
import postgres from "postgres";
import { env } from "./env";

/**
 * One connection pool per server process.
 *
 * On Supabase use the pooler connection string in transaction mode (port 6543).
 * Prepared statements are off because transaction pooling does not keep them.
 */
type Sql = postgres.Sql<Record<string, never>>;
export type Tx = postgres.TransactionSql<Record<string, never>>;

const globalForDb = globalThis as unknown as { __crmSql?: Sql };

export function sql(): Sql {
  if (!globalForDb.__crmSql) {
    globalForDb.__crmSql = postgres(env().DATABASE_URL, {
      prepare: false,
      max: Number(process.env.DATABASE_POOL_MAX ?? 5),
      idle_timeout: 20,
      connect_timeout: 10,
      onnotice: () => {},
    });
  }
  return globalForDb.__crmSql;
}

/**
 * Runs `fn` as the signed-in staff member, inside one transaction.
 *
 * The connection switches to the "authenticated" role and sets the user's id
 * as the JWT subject, exactly as Supabase does for API requests. From then on
 * PostgreSQL row-level security decides what this user can read, and the
 * business functions check what they may change. Nothing here trusts the browser.
 */
export async function asUser<T>(userId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return sql().begin(async (tx) => {
    await tx`set local role authenticated`;
    await tx`select set_config('request.jwt.claims', ${JSON.stringify({ sub: userId, role: "authenticated" })}, true)`;
    return fn(tx);
  }) as Promise<T>;
}

/**
 * Privileged access without row-level security. Used only for:
 *  - resolving a signed-in login to its staff profile, and
 *  - local development sign-in.
 * Never call this with input from the browser without an explicit permission check.
 */
export async function asSystem<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  return sql().begin(fn) as Promise<T>;
}
