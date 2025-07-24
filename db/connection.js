const { drizzle } = require("drizzle-orm/node-postgres");
const { Pool } = require("pg");
const schema = require("./schema.js");

const url = process.env.DATABASE_URL;

const db = drizzle(url, { schema });

module.exports = { db };
