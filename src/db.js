const { Pool } = require("pg");
const fs = require("fs");
const path = require("path");

require("dotenv").config();

const pool = new Pool(
  process.env.DATABASE_URL
    ? {
        connectionString: process.env.DATABASE_URL,
        ssl: process.env.DATABASE_URL.includes("localhost") ? false : { rejectUnauthorized: false },
      }
    : {
        user: process.env.DB_USER,
        password: process.env.DB_PASSWORD,
        host: process.env.DB_HOST,
        port: process.env.DB_PORT,
        database: process.env.DB_DATABASE,
      },
);

/**
 * Разбивает SQL-файл на отдельные операторы.
 * Учитывает dollar-quoting ($$ ... $$) и одинарные кавычки —
 * точки с запятой внутри них не считаются разделителями.
 */
function splitStatements(sql) {
  const statements = [];
  let current = "";
  let inDollarQuote = false;
  let dollarTag = "";
  let inSingleQuote = false;

  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    const next = sql[i + 1];

    // Открытие dollar-quoted строки ($$ или $tag$)
    if (!inSingleQuote && !inDollarQuote && ch === "$" && next === "$") {
      inDollarQuote = true;
      dollarTag = "$$";
      current += "$$";
      i++;
      continue;
    }
    if (!inSingleQuote && !inDollarQuote && ch === "$") {
      const match = /^\$[A-Za-z_][A-Za-z0-9_]*\$/.exec(sql.slice(i));
      if (match) {
        inDollarQuote = true;
        dollarTag = match[0];
        current += match[0];
        i += match[0].length - 1;
        continue;
      }
    }

    // Закрытие dollar-quoted строки
    if (inDollarQuote && sql.startsWith(dollarTag, i)) {
      current += dollarTag;
      i += dollarTag.length - 1;
      inDollarQuote = false;
      dollarTag = "";
      continue;
    }

    // Одинарная кавычка (экранированная '' считается частью строки)
    if (!inDollarQuote && ch === "'") {
      if (next === "'") {
        current += "''";
        i++;
        continue;
      }
      inSingleQuote = !inSingleQuote;
      current += ch;
      continue;
    }

    // Разделитель операторов на верхнем уровне
    if (!inDollarQuote && !inSingleQuote && ch === ";") {
      const trimmed = current.trim();
      if (trimmed) statements.push(trimmed);
      current = "";
      continue;
    }

    current += ch;
  }

  const trimmed = current.trim();
  if (trimmed) statements.push(trimmed);
  return statements;
}

async function initDatabase() {
  try {
    const schemaPath = path.join(__dirname, "..", "schema.sql");
    const sql = fs.readFileSync(schemaPath, "utf8");
    const statements = splitStatements(sql);
    for (const statement of statements) {
      await pool.query(statement);
    }
    console.log(`✅ Схема БД применена (${statements.length} операторов)`);
  } catch (error) {
    console.error("❌ Ошибка создания таблиц:", error.message);
  }
}

module.exports = { pool, initDatabase };