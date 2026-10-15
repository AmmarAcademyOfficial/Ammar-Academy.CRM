import { startLocalPostgres } from "../../scripts/local-postgres.mjs";

export default async function setup({ provide }: { provide: (key: string, value: string) => void }) {
  const db = await startLocalPostgres({ name: "test", port: 54331, database: "crm_test" });
  provide("databaseUrl", db.url);
  return async () => {
    await db.stop();
  };
}

declare module "vitest" {
  export interface ProvidedContext {
    databaseUrl: string;
  }
}
