import { drizzle } from "drizzle-orm/d1";

import {
  apiKeys,
  events,
  issues,
  sends,
  settings,
  subscribers,
} from "./schema";

const schema = { apiKeys, events, issues, sends, settings, subscribers };

export const createDb = (binding: D1Database) => drizzle(binding, { schema });

export type Database = ReturnType<typeof createDb>;
