import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema.js";

const url = process.env.DATABASE_URL;

export const db = drizzle(url, { schema });
