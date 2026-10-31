import { drizzle } from "drizzle-orm/d1";

import { events, issues, sends, settings, subscribers } from "./schema";

const schema = { events, issues, sends, settings, subscribers };

export const createDb = (binding: D1Database) => drizzle(binding, { schema });

export type Database = ReturnType<typeof createDb>;
