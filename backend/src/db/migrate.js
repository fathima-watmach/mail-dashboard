require("dotenv").config();
const fs = require("fs");
const path = require("path");
const { Pool } = require("pg");

async function migrate() {
  if (!process.env.DATABASE_URL) {
    console.error("Missing DATABASE_URL in .env - copy .env.example to .env and fill it in first.");
    process.exit(1);
  }

  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }, // Supabase requires SSL; this is standard for hosted Postgres
  });

  const migrationsDir = path.join(__dirname, "..", "..", "migrations");
  const files = fs.readdirSync(migrationsDir).filter((f) => f.endsWith(".sql")).sort();

  if (files.length === 0) {
    console.log("No migration files found in", migrationsDir);
    await pool.end();
    return;
  }

  for (const file of files) {
    const filePath = path.join(migrationsDir, file);
    const sql = fs.readFileSync(filePath, "utf8");
    console.log(`Running migration: ${file}`);
    try {
      await pool.query(sql);
      console.log(`  done.`);
    } catch (err) {
      console.error(`  FAILED on ${file}:`, err.message);
      await pool.end();
      process.exit(1);
    }
  }

  console.log("All migrations applied successfully.");
  await pool.end();
}

migrate();
