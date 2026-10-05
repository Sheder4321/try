// ============================================================
// МОНОЛИТНЫЙ СЕРВЕР (собран build_monolith.js из src/)
// ============================================================
const express = require("express");
const compression = require("compression");
const cors = require("cors");
const path = require("path");
const http = require("http");
const WebSocket = require("ws");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const multer = require("multer");
const fs = require("fs");
const crypto = require("crypto");
const { Pool } = require("pg");
require("dotenv").config();
const { sendPasswordResetEmail } = require("./mailer");

const app = express();
const port = process.env.PORT || 3000;

// gzip/deflate для всех ответов: index.html ~760 КБ ужимается до ~150 КБ.
app.use(compression());

// ============================================================
// ПОДКЛЮЧЕНИЕ К БД
// ============================================================
const pool = new Pool({
  ...(process.env.DATABASE_URL
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
      }),
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
  keepAlive: true,
});

pool.on("error", (err) => {
  console.error("Ошибка пула БД (соединение разорвано):", err.message);
});

// ============================================================
// MIDDLEWARE: АВТОРИЗАЦИЯ
// ============================================================
function authenticateToken(req, res, next) {
  const authHeader = req.headers["authorization"];
  const token = authHeader && authHeader.split(" ")[1];
  if (!token) return res.status(401).json({ error: "Требуется авторизация" });
  jwt.verify(token, process.env.JWT_SECRET, (err, user) => {
    if (err) return res.status(403).json({ error: "Неверный токен" });
    req.user = user;
    next();
  });
}

function requireTeacher(req, res, next) {
  if (req.user.role !== "teacher") return res.status(403).json({ error: "Только для учителей" });
  next();
}

// ============================================================
// MULTER (загрузка файлов)
// ============================================================
function ensureDir(dir) { if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true }); }

const storage = multer.diskStorage({
  destination: function (req, file, cb) { ensureDir("uploads/submissions/"); cb(null, "uploads/submissions/"); },
  filename: function (req, file, cb) { const s = Date.now() + "-" + Math.round(Math.random()*1e9); const e = path.extname(file.originalname) || ".jpg"; cb(null, s + e); },
});
const upload = multer({ storage, limits: { fileSize: 20*1024*1024 } });

const audioStorage = multer.diskStorage({
  destination: function (req, file, cb) { ensureDir("uploads/audio/"); cb(null, "uploads/audio/"); },
  filename: function (req, file, cb) { const s = Date.now() + "-" + Math.round(Math.random()*1e9); const e = path.extname(file.originalname) || ".webm"; cb(null, "voice_" + s + e); },
});
const audioUpload = multer({ storage: audioStorage, limits: { fileSize: 10*1024*1024 } });

const assignmentStorage = multer.diskStorage({
  destination: function (req, file, cb) { ensureDir("uploads/assignments/"); cb(null, "uploads/assignments/"); },
  filename: function (req, file, cb) { const s = Date.now() + "-" + Math.round(Math.random()*1e9); cb(null, "q-" + s + path.extname(file.originalname)); },
});
const assignmentUpload = multer({ storage: assignmentStorage, limits: { fileSize: 20*1024*1024 } });

// ============================================================
// АУДИО: КОНВЕРТАЦИЯ webm → mp4 (для iOS)
// ============================================================
function findFfmpeg() {
  const explicit = process.env.FFMPEG_PATH;
  if (explicit && fs.existsSync(explicit)) return explicit;
  const names = process.platform === "win32" ? ["ffmpeg.exe", "ffmpeg"] : ["ffmpeg"];
  for (const n of names) {
    try { const { execSync } = require("child_process"); const r = execSync(process.platform === "win32" ? "where " + n : "which " + n, { stdio: "pipe" }).toString().trim(); if (r) { const first = r.split(/\r?\n/)[0].trim(); if (first) return first; } } catch (e) {}
  }
  return null;
}
let ffmpegPath = undefined;
function getFfmpeg() { if (ffmpegPath === undefined) ffmpegPath = findFfmpeg(); return ffmpegPath; }

function fileIsWebm(filePath) {
  try {
    const fd = fs.openSync(filePath, "r");
    const buf = Buffer.alloc(4);
    fs.readSync(fd, buf, 0, 4, 0);
    fs.closeSync(fd);
    return buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3;
  } catch (e) { return false; }
}

function convertWebmToMp4(filePath) {
  return new Promise((resolve) => {
    const ff = getFfmpeg();
    if (!filePath || !fs.existsSync(filePath)) return resolve(null);
    if (!fileIsWebm(filePath)) return resolve(null);
    if (!ff) { console.warn("ffmpeg не найден — webm не сконвертирован:", filePath); return resolve(null); }
    const ext = path.extname(filePath);
    const mp4Path = filePath.slice(0, filePath.length - ext.length) + ".mp4";
    const { execFile } = require("child_process");
    execFile(ff, ["-y", "-i", filePath, "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart", mp4Path], { timeout: 120000 }, (err) => {
      if (err) { console.error("Ошибка конвертации аудио в mp4:", err.message); return resolve(null); }
      try { fs.unlinkSync(filePath); } catch (e) {}
      resolve(mp4Path);
    });
  });
}
function toServePath(fp) { let p = fp.replace(/\\/g, "/"); const i = p.indexOf("uploads/"); p = i >= 0 ? p.slice(i) : p; return p; }

// ============================================================
// СХЕМА БД
// ============================================================
function splitStatements(sql) {
  const statements = []; let current = ""; let inDollarQuote = false; let dollarTag = ""; let inSingleQuote = false;
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i]; const next = sql[i+1];
    if (!inSingleQuote && !inDollarQuote && ch === "$" && next === "$") { inDollarQuote = true; dollarTag = "$$"; current += "$$"; i++; continue; }
    if (!inSingleQuote && !inDollarQuote && ch === "$") { const m = /^\$[A-Za-z_][A-Za-z0-9_]*\$/.exec(sql.slice(i)); if (m) { inDollarQuote = true; dollarTag = m[0]; current += m[0]; i += m[0].length - 1; continue; } }
    if (inDollarQuote && sql.startsWith(dollarTag, i)) { current += dollarTag; i += dollarTag.length - 1; inDollarQuote = false; dollarTag = ""; continue; }
    if (!inDollarQuote && ch === "'") { if (next === "'") { current += "''"; i++; continue; } inSingleQuote = !inSingleQuote; current += ch; continue; }
    if (!inDollarQuote && !inSingleQuote && ch === ";") { const t = current.trim(); if (t) statements.push(t); current = ""; continue; }
    current += ch;
  }
  const t = current.trim(); if (t) statements.push(t);
  return statements;
}

async function initDatabase() {
  try {
    const schemaPath = path.join(__dirname, "schema.sql");
    const sql = fs.readFileSync(schemaPath, "utf8");
    const statements = splitStatements(sql);
    for (const s of statements) await pool.query(s);
    console.log("Схема БД применена (" + statements.length + " операторов)");
  } catch (error) { console.error("Ошибка создания таблиц:", error.message); }
}

// ============================================================
// СТРАНИЦЫ
// ============================================================
app.get("/join-class/:token", (req, res) => res.sendFile(path.join(__dirname, "join-class.html")));
app.get("/reset-password", (req, res) => res.sendFile(path.join(__dirname, "index.html")));
app.get("/", (req, res) => res.sendFile(path.join(__dirname, "index.html")));

// Простой health-check для платформ (Render/OnReza): обычный GET без WebSocket,
// чтобы smoke test завершался мгновенно и не вис, дожидаясь апгрейда до WS.
app.get("/health", (req, res) => res.status(200).send("ok"));

app.use(cors());
app.use(express.json({ limit: "100mb" }));
// Имена файлов уникальны (timestamp+random) — можно кэшировать надолго.
app.use("/uploads", express.static("uploads", { maxAge: "7d", immutable: true }));

// ============================================================
// API /api (auth)
// ============================================================



app.post("/api/register", async (req, res) => {
  const { username, password, role = "student", fullName, email } = req.body;

  if (!username || !password) {
    return res.status(400).json({ error: "Логин и пароль обязательны" });
  }
  if (!email || !email.includes("@")) {
    return res.status(400).json({ error: "Укажите корректный email" });
  }
  if (password.length < 6) {
    return res.status(400).json({ error: "Пароль должен быть не менее 6 символов" });
  }

  try {
    const hashedPassword = await bcrypt.hash(password, 10);
    const result = await pool.query(
      "INSERT INTO users (username, password_hash, role, full_name, email) VALUES ($1, $2, $3, $4, $5) RETURNING id, username, role",
      [username, hashedPassword, role, fullName || username, email.toLowerCase().trim()],
    );
    const user = result.rows[0];
    await pool.query("INSERT INTO boards (user_id, board_data) VALUES ($1, $2)", [
      user.id,
      JSON.stringify({ objects: [] }),
    ]);
    const token = jwt.sign({ id: user.id, username: user.username, role: user.role }, process.env.JWT_SECRET, {
      expiresIn: "7d",
    });
    res.json({ token, user: { id: user.id, username: user.username, role: user.role } });
  } catch (error) {
    if (error.code === "23505") {
      if (error.constraint && error.constraint.includes("email")) {
        return res.status(400).json({ error: "Этот email уже зарегистрирован" });
      }
      return res.status(400).json({ error: "Пользователь с таким логином уже существует" });
    }
    console.error(error);
    res.status(500).json({ error: "Ошибка сервера" });
  }
});

app.post("/api/login", async (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({ error: "Все поля обязательны" });
  }

  try {
    const input = String(username).trim();
    let user;
    let searchBy;

    const isEmailLike = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input);

    if (isEmailLike) {
      searchBy = "email";
      const cleanEmail = input.toLowerCase();
      const result = await pool.query("SELECT * FROM users WHERE email = $1", [cleanEmail]);
      user = result.rows[0];
    } else {
      searchBy = "username";
      const cleanUsername = input;
      const result = await pool.query("SELECT * FROM users WHERE username = $1", [cleanUsername]);
      user = result.rows[0];
    }

    if (!user) {
      return res.status(401).json({ error: "Неверные учетные данные" });
    }

    const isValid = await bcrypt.compare(password, user.password_hash);
    if (!isValid) {
      return res.status(401).json({ error: "Неверные учетные данные" });
    }

    const token = jwt.sign({ id: user.id, username: user.username, role: user.role }, process.env.JWT_SECRET, {
      expiresIn: "7d",
    });

    res.json({
      token,
      user: {
        id: user.id,
        username: user.username,
        role: user.role,
        fullName: user.full_name,
        email: user.email,
      },
    });
  } catch (error) {
    console.error("[LOGIN ERROR]", error);
    res.status(500).json({ error: "Ошибка сервера" });
  }
});

app.post("/api/forgot-password", async (req, res) => {
  const { email } = req.body;
  const genericResponse = { message: "Если такой email зарегистрирован, письмо отправлено" };

  if (!email || !email.includes("@")) {
    return res.json(genericResponse);
  }

  try {
    const userResult = await pool.query("SELECT id, username FROM users WHERE email = $1", [
      email.toLowerCase().trim(),
    ]);

    if (userResult.rows.length === 0) {
      return res.json(genericResponse);
    }

    const userId = userResult.rows[0].id;

    await pool.query("DELETE FROM password_reset_tokens WHERE user_id = $1", [userId]);

    const rawToken = crypto.randomBytes(32).toString("hex");
    const tokenHash = crypto.createHash("sha256").update(rawToken).digest("hex");
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000);

    await pool.query(`INSERT INTO password_reset_tokens (user_id, token_hash, expires_at) VALUES ($1, $2, $3)`, [
      userId,
      tokenHash,
      expiresAt,
    ]);

    // Отправка письма идёт в фоне (fire-and-forget): даже если SMTP недоступен,
    // запрос вернётся мгновенно, а ошибка не заблокирует пользователя.
    sendPasswordResetEmail(email, rawToken).catch((err) => {
      console.error("❌ Ошибка фоновой отправки письма:", err && err.message ? err.message : err);
    });

    res.json(genericResponse);
  } catch (error) {
    console.error("❌ Ошибка forgot-password:", error);
    res.json(genericResponse);
  }
});

app.post("/api/reset-password", async (req, res) => {
  const { token, newPassword } = req.body;

  if (!token || !newPassword) {
    return res.status(400).json({ error: "Недостаточно данных" });
  }
  if (newPassword.length < 6) {
    return res.status(400).json({ error: "Пароль должен быть не менее 6 символов" });
  }

  try {
    const tokenHash = crypto.createHash("sha256").update(token).digest("hex");

    const result = await pool.query(
      `SELECT id, user_id FROM password_reset_tokens 
               WHERE token_hash = $1 AND expires_at > NOW() AND used_at IS NULL`,
      [tokenHash],
    );

    if (result.rows.length === 0) {
      return res.status(400).json({ error: "Ссылка недействительна или истекла" });
    }

    const tokenRecord = result.rows[0];
    const passwordHash = await bcrypt.hash(newPassword, 10);

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("UPDATE users SET password_hash = $1 WHERE id = $2", [passwordHash, tokenRecord.user_id]);
      await client.query("UPDATE password_reset_tokens SET used_at = NOW() WHERE id = $1", [tokenRecord.id]);
      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }

    res.json({ message: "Пароль успешно изменён" });
  } catch (error) {
    console.error("❌ Ошибка reset-password:", error);
    res.status(500).json({ error: "Ошибка сервера" });
  }
});

app.get("/api/reset-password/check", async (req, res) => {
  const { token } = req.query;
  if (!token) return res.json({ valid: false });

  try {
    const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
    const result = await pool.query(
      `SELECT id FROM password_reset_tokens 
               WHERE token_hash = $1 AND expires_at > NOW() AND used_at IS NULL`,
      [tokenHash],
    );
    res.json({ valid: result.rows.length > 0 });
  } catch (error) {
    res.json({ valid: false });
  }
});


// ============================================================
// API /api (invites) — каждый защищённый роут несёт auth сам,
// GET /invite/:token — публичный (по ссылке-приглашению)
// ============================================================



app.post("/api/classes/:classId/invite", authenticateToken, requireTeacher, async (req, res) => {
  const { classId } = req.params;
  const { maxUses = 1, expiresInHours = 24 } = req.body;

  try {
    const classCheck = await pool.query("SELECT id FROM classes WHERE id = $1 AND teacher_id = $2", [
      classId,
      req.user.id,
    ]);

    if (classCheck.rows.length === 0) {
      return res.status(404).json({ error: "Класс не найден" });
    }

    const token = "invite_" + Date.now() + "_" + Math.random().toString(36).substring(2, 10);
    const expiresAt = new Date(Date.now() + expiresInHours * 60 * 60 * 1000);

    const result = await pool.query(
      `INSERT INTO class_invites (class_id, token, created_by, max_uses, expires_at)
            VALUES ($1, $2, $3, $4, $5)
            RETURNING *`,
      [classId, token, req.user.id, maxUses, expiresAt],
    );

    const invite = result.rows[0];
    const inviteUrl = `${req.protocol}://${req.get("host")}/join-class/${invite.token}`;

    res.json({
      token: invite.token,
      url: inviteUrl,
      expires_at: invite.expires_at,
      max_uses: invite.max_uses,
    });
  } catch (error) {
    console.error("❌ Ошибка создания приглашения:", error);
    res.status(500).json({ error: "Ошибка создания приглашения: " + error.message });
  }
});

app.get("/api/invite/:token", async (req, res) => {
  const { token } = req.params;

  try {
    const result = await pool.query(
      `
            SELECT i.*, c.name as class_name, c.id as class_id, COALESCE(u.full_name, u.username) as teacher_name
            FROM class_invites i
            JOIN classes c ON i.class_id = c.id
            JOIN users u ON c.teacher_id = u.id
            WHERE i.token = $1 AND i.is_active = true
        `,
      [token],
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Приглашение не найдено или неактивно" });
    }

    const invite = result.rows[0];

    if (new Date(invite.expires_at) < new Date()) {
      return res.status(410).json({ error: "Срок действия приглашения истёк" });
    }

    if (invite.used_count >= invite.max_uses) {
      return res.status(410).json({ error: "Приглашение уже использовано" });
    }

    let isAlreadyMember = false;
    if (req.headers.authorization) {
      try {
        const authToken = req.headers.authorization.split(" ")[1];
        const decoded = jwt.verify(authToken, process.env.JWT_SECRET);
        const memberCheck = await pool.query(
          "SELECT class_id FROM class_students WHERE class_id = $1 AND student_id = $2",
          [invite.class_id, decoded.id],
        );
        isAlreadyMember = memberCheck.rows.length > 0;
      } catch (e) {}
    }

    res.json({
      class_id: invite.class_id,
      class_name: invite.class_name,
      teacher_name: invite.teacher_name,
      expires_at: invite.expires_at,
      max_uses: invite.max_uses,
      used_count: invite.used_count,
      is_already_member: isAlreadyMember,
    });
  } catch (error) {
    console.error("❌ Ошибка получения приглашения:", error);
    res.status(500).json({ error: "Ошибка получения приглашения: " + error.message });
  }
});

app.post("/api/invite/:token/join", authenticateToken, async (req, res) => {
  const { token } = req.params;

  try {
    const inviteResult = await pool.query(
      `
            SELECT i.*, c.id as class_id
            FROM class_invites i
            JOIN classes c ON i.class_id = c.id
            WHERE i.token = $1 AND i.is_active = true
        `,
      [token],
    );

    if (inviteResult.rows.length === 0) {
      return res.status(404).json({ error: "Приглашение не найдено или неактивно" });
    }

    const invite = inviteResult.rows[0];

    if (new Date(invite.expires_at) < new Date()) {
      return res.status(410).json({ error: "Срок действия приглашения истёк" });
    }

    if (invite.used_count >= invite.max_uses) {
      return res.status(410).json({ error: "Приглашение уже использовано" });
    }

    const memberCheck = await pool.query(
      "SELECT class_id FROM class_students WHERE class_id = $1 AND student_id = $2",
      [invite.class_id, req.user.id],
    );

    if (memberCheck.rows.length > 0) {
      return res.status(400).json({ error: "Вы уже состоите в этом классе" });
    }

    await pool.query("INSERT INTO class_students (class_id, student_id) VALUES ($1, $2)", [
      invite.class_id,
      req.user.id,
    ]);

    await pool.query("UPDATE class_invites SET used_count = used_count + 1 WHERE id = $1", [invite.id]);

    if (invite.used_count + 1 >= invite.max_uses) {
      await pool.query("UPDATE class_invites SET is_active = false WHERE id = $1", [invite.id]);
    }

    res.json({
      message: "Вы успешно присоединились к классу!",
      class_id: invite.class_id,
    });
  } catch (error) {
    console.error("❌ Ошибка присоединения к классу:", error);
    res.status(500).json({ error: "Ошибка присоединения к классу: " + error.message });
  }
});

app.get("/api/classes/:classId/invites", authenticateToken, requireTeacher, async (req, res) => {
  const { classId } = req.params;

  try {
    const classCheck = await pool.query("SELECT id FROM classes WHERE id = $1 AND teacher_id = $2", [
      classId,
      req.user.id,
    ]);

    if (classCheck.rows.length === 0) {
      return res.status(404).json({ error: "Класс не найден" });
    }

    // Чистка истёкших/исчерпанных приглашений этого класса
    await pool.query(
      `DELETE FROM class_invites 
      WHERE class_id = $1 
        AND (expires_at < NOW() OR used_count >= max_uses)`,
      [classId],
    );

    const result = await pool.query(
      `SELECT id, token, max_uses, used_count, expires_at, created_at, is_active
      FROM class_invites
      WHERE class_id = $1 
        AND is_active = true
        AND expires_at > NOW()
        AND used_count < max_uses
      ORDER BY created_at DESC`,
      [classId],
    );

    const invites = result.rows.map((invite) => ({
      ...invite,
      url: `${req.protocol}://${req.get("host")}/join-class/${invite.token}`,
    }));

    res.json(invites);
  } catch (error) {
    console.error("❌ Ошибка получения приглашений:", error);
    res.status(500).json({ error: "Ошибка получения приглашений: " + error.message });
  }
});

app.delete("/api/invite/:token", authenticateToken, requireTeacher, async (req, res) => {
  const { token } = req.params;

  try {
    const result = await pool.query(
      `
            UPDATE class_invites 
            SET is_active = false 
            WHERE token = $1 
            AND created_by = $2
            RETURNING id
        `,
      [token, req.user.id],
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Приглашение не найдено" });
    }

    res.json({ message: "Приглашение отключено" });
  } catch (error) {
    console.error("❌ Ошибка отключения приглашения:", error);
    res.status(500).json({ error: "Ошибка отключения приглашения: " + error.message });
  }
});


// ============================================================
// API /api (классы и далее) — требуется авторизация
// ============================================================
app.use("/api", authenticateToken);



app.post("/api/classes", requireTeacher, async (req, res) => {
  const { name, description } = req.body;
  try {
    const result = await pool.query(
      "INSERT INTO classes (teacher_id, name, description) VALUES ($1, $2, $3) RETURNING *",
      [req.user.id, name, description],
    );
    res.json(result.rows[0]);
  } catch (error) {
    console.error("❌ Ошибка создания класса:", error);
    res.status(500).json({ error: "Ошибка создания класса: " + error.message });
  }
});

app.get("/api/classes/my", async (req, res) => {
  try {
    let query, params;
    if (req.user.role === "teacher") {
      query = `
                SELECT c.*, 
                    COUNT(DISTINCT cs.student_id) as student_count,
                    COALESCE(u.full_name, u.username) as teacher_name
                FROM classes c
                LEFT JOIN class_students cs ON c.id = cs.class_id
                JOIN users u ON c.teacher_id = u.id
                WHERE c.teacher_id = $1
                GROUP BY c.id, u.username, u.full_name
                ORDER BY c.created_at DESC
            `;
      params = [req.user.id];
    } else {
      query = `
                SELECT c.*, 
                    COUNT(DISTINCT cs2.student_id) as student_count,
                    COALESCE(u.full_name, u.username) as teacher_name
                FROM classes c
                JOIN class_students cs ON c.id = cs.class_id AND cs.student_id = $1
                LEFT JOIN class_students cs2 ON c.id = cs2.class_id
                JOIN users u ON c.teacher_id = u.id
                WHERE cs.student_id = $1
                GROUP BY c.id, u.username, u.full_name
                ORDER BY c.created_at DESC
            `;
      params = [req.user.id];
    }
    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (error) {
    console.error("❌ Ошибка получения классов:", error);
    res.status(500).json({ error: "Ошибка получения классов" });
  }
});

app.get("/api/classes/:classId", async (req, res) => {
  const { classId } = req.params;
  try {
    if (!/^\d+$/.test(classId)) {
      return res.status(400).json({ error: "Некорректный id класса" });
    }
    let hasAccess = false;
    if (req.user.role === "teacher") {
      const check = await pool.query("SELECT id FROM classes WHERE id = $1 AND teacher_id = $2", [
        classId,
        req.user.id,
      ]);
      if (check.rows.length > 0) hasAccess = true;
    } else if (req.user.role === "student") {
      const check = await pool.query("SELECT class_id FROM class_students WHERE class_id = $1 AND student_id = $2", [
        classId,
        req.user.id,
      ]);
      if (check.rows.length > 0) hasAccess = true;
    }

    if (!hasAccess) {
      return res.status(403).json({ error: "Нет доступа" });
    }

    const result = await pool.query("SELECT * FROM classes WHERE id = $1", [classId]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Класс не найден" });
    }

    res.json(result.rows[0]);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Ошибка получения класса" });
  }
});

app.get("/api/classes/:classId/students", async (req, res) => {
  const { classId } = req.params;
  try {
    if (!/^\d+$/.test(classId)) {
      return res.status(400).json({ error: "Некорректный id класса" });
    }
    const result = await pool.query(
      `
            SELECT u.id, u.username, u.full_name
            FROM users u
            JOIN class_students cs ON u.id = cs.student_id
            WHERE cs.class_id = $1
            ORDER BY u.username
        `,
      [classId],
    );
    res.json(result.rows);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Ошибка получения учеников" });
  }
});

app.delete("/api/classes/:classId/students/:studentId", requireTeacher, async (req, res) => {
  const { classId, studentId } = req.params;
  try {
    if (!/^\d+$/.test(classId) || !/^\d+$/.test(studentId)) {
      return res.status(400).json({ error: "Некорректный id" });
    }
    const ownerCheck = await pool.query("SELECT id FROM classes WHERE id = $1 AND teacher_id = $2", [
      classId,
      req.user.id,
    ]);
    if (ownerCheck.rows.length === 0) {
      return res.status(403).json({ error: "Нет доступа к этому классу" });
    }

    const result = await pool.query(
      `DELETE FROM class_students WHERE class_id = $1 AND student_id = $2 RETURNING student_id`,
      [classId, studentId],
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Ученик не в этом классе" });
    }

    res.json({ message: "Ученик удалён из класса" });
  } catch (error) {
    console.error("❌ Ошибка удаления ученика из класса:", error);
    res.status(500).json({ error: "Ошибка удаления ученика: " + error.message });
  }
});

// Сброс пароля ученика учителем — без почты (на OnReza SMTP недоступен).
// Возвращает временный пароль и одноразовую ссылку для смены пароля.
app.post("/api/classes/:classId/students/:studentId/reset-password", requireTeacher, async (req, res) => {
  const { classId, studentId } = req.params;
  try {
    if (!/^\d+$/.test(classId) || !/^\d+$/.test(studentId)) {
      return res.status(400).json({ error: "Некорректный id" });
    }

    const ownerCheck = await pool.query("SELECT id FROM classes WHERE id = $1 AND teacher_id = $2", [
      classId,
      req.user.id,
    ]);
    if (ownerCheck.rows.length === 0) {
      return res.status(403).json({ error: "Нет доступа к этому классу" });
    }

    const studentCheck = await pool.query(
      "SELECT student_id FROM class_students WHERE class_id = $1 AND student_id = $2",
      [classId, studentId],
    );
    if (studentCheck.rows.length === 0) {
      return res.status(404).json({ error: "Ученик не в этом классе" });
    }

    // Читаемый временный пароль из 8 символов (без неоднозначных 0/O, 1/l).
    const alphabet = "abcdefghjkmnpqrstuvwxyz23456789";
    const tempPassword = Array.from(crypto.randomBytes(8))
      .map((b) => alphabet[b % alphabet.length])
      .join("");
    const passwordHash = await bcrypt.hash(tempPassword, 10);
    await pool.query("UPDATE users SET password_hash = $1 WHERE id = $2", [passwordHash, studentId]);

    // Одноразовая ссылка — ученик сам задаст новый пароль (действует 1 час).
    await pool.query("DELETE FROM password_reset_tokens WHERE user_id = $1", [studentId]);
    const rawToken = crypto.randomBytes(32).toString("hex");
    const tokenHash = crypto.createHash("sha256").update(rawToken).digest("hex");
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000);
    await pool.query(
      `INSERT INTO password_reset_tokens (user_id, token_hash, expires_at) VALUES ($1, $2, $3)`,
      [studentId, tokenHash, expiresAt],
    );

    res.json({ tempPassword, resetToken: rawToken });
  } catch (error) {
    console.error("❌ Ошибка сброса пароля ученика:", error);
    res.status(500).json({ error: "Ошибка сброса пароля: " + error.message });
  }
});

app.delete("/api/classes/:classId", requireTeacher, async (req, res) => {
  const { classId } = req.params;
  try {
    if (!/^\d+$/.test(classId)) {
      return res.status(400).json({ error: "Некорректный id класса" });
    }
    const classCheck = await pool.query("SELECT id FROM classes WHERE id = $1 AND teacher_id = $2", [
      classId,
      req.user.id,
    ]);

    if (classCheck.rows.length === 0) {
      return res.status(404).json({ error: "Класс не найден или у вас нет прав" });
    }

    await pool.query("DELETE FROM classes WHERE id = $1", [classId]);

    res.json({ message: "Класс успешно удалён" });
  } catch (error) {
    console.error("❌ Ошибка удаления класса:", error);
    res.status(500).json({ error: "Ошибка удаления класса: " + error.message });
  }
});


// ============================================================
// API /api (assignments)
// ============================================================



// Создание задания
app.post("/api/assignments", requireTeacher, assignmentUpload.any(), async (req, res) => {
  const { classId, title, description, autoCheck, maxScore, dueDate, items, assignmentHint, targetStudentIds } =
    req.body;

  if (!classId || !title) {
    return res.status(400).json({ error: "Необходимо указать класс и название" });
  }

  let parsedItems = [];
  try {
    parsedItems = items ? JSON.parse(items) : [];
  } catch (e) {
    return res.status(400).json({ error: "Некорректный формат вопросов" });
  }

  if (!parsedItems.length) {
    return res.status(400).json({ error: "Добавьте хотя бы один вопрос" });
  }

  const uploadedFiles = req.files || [];

  const itemsWithData = parsedItems.map((item, index) => {
    const questionFile = uploadedFiles.find((f) => f.fieldname === `image_${index}`);
    if (questionFile) {
      item.image = questionFile.path;
    }

    const hintFile = uploadedFiles.find((f) => f.fieldname === `hint_image_${index}`);
    if (hintFile) {
      item.teacherHint = {
        text: item.teacherHint?.text || "",
        image: hintFile.path,
      };
    } else if (item.teacherHint?.text) {
      item.teacherHint = {
        text: item.teacherHint.text,
        image: null,
      };
    }

    item.autoCheck = item.autoCheck === true;
    const rawScore = parseFloat(item.score);
    item.score = !isNaN(rawScore) && rawScore >= 0 ? rawScore : 1;
    return item;
  });

  const totalMaxScore = itemsWithData.reduce((sum, it) => sum + (parseFloat(it.score) || 1), 0);
  const hasAutoCheck = itemsWithData.some((it) => it.autoCheck);

  let assignmentHintData = null;
  if (assignmentHint) {
    try {
      assignmentHintData = JSON.parse(assignmentHint);
      const hintImageFile = uploadedFiles.find((f) => f.fieldname === "assignment_hint_image");
      if (hintImageFile) {
        assignmentHintData.image = hintImageFile.path;
      }
    } catch (e) {
      console.error("Ошибка парсинга assignmentHint:", e);
    }
  }

  try {
    let targetIds = [];
    if (targetStudentIds) {
      try {
        const parsed = JSON.parse(targetStudentIds);
        if (Array.isArray(parsed)) targetIds = parsed.map(Number).filter((n) => !isNaN(n));
      } catch (e) {
        targetIds = [];
      }
    }
    const targetJson = targetIds.length ? JSON.stringify(targetIds) : null;

    const result = await pool.query(
      `INSERT INTO assignments 
            (class_id, teacher_id, title, description, content, due_date, max_score, auto_check, target_student_ids) 
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) 
            RETURNING *`,
      [
        classId,
        req.user.id,
        title,
        description || "",
        JSON.stringify({
          items: itemsWithData,
          assignmentHint: assignmentHintData,
        }),
        dueDate || null,
        totalMaxScore,
        hasAutoCheck,
        targetJson,
      ],
    );
    res.json(result.rows[0]);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Ошибка создания задания: " + error.message });
  }
});

// Список заданий класса
app.get("/api/assignments/class/:classId", async (req, res) => {
  const { classId } = req.params;
  try {
    let listSql = `
            SELECT a.*, COALESCE(u.full_name, u.username) as teacher_name
            FROM assignments a
            JOIN users u ON a.teacher_id = u.id
            WHERE a.class_id = $1
        `;
    const listParams = [classId];
    if (req.user.role === "student") {
      listSql += ` AND (a.target_student_ids IS NULL OR a.target_student_ids @> $2::jsonb)`;
      listParams.push(JSON.stringify([req.user.id]));
    }
    listSql += ` ORDER BY a.created_at DESC`;

    const result = await pool.query(listSql, listParams);

    const studentsCountResult = await pool.query("SELECT COUNT(*) as count FROM class_students WHERE class_id = $1", [
      classId,
    ]);
    const classTotal = parseInt(studentsCountResult.rows[0]?.count || 0);

    for (const assignment of result.rows) {
      const submittedResult = await pool.query(
        `SELECT COUNT(*) as count FROM submissions 
                WHERE assignment_id = $1 AND status IN ('submitted', 'graded')`,
        [assignment.id],
      );
      const submittedCount = parseInt(submittedResult.rows[0]?.count || 0);

      const gradedResult = await pool.query(
        `SELECT COUNT(*) as count FROM submissions 
                WHERE assignment_id = $1 AND status = 'graded'`,
        [assignment.id],
      );
      const gradedCount = parseInt(gradedResult.rows[0]?.count || 0);

      const targeted =
        Array.isArray(assignment.target_student_ids) && assignment.target_student_ids.length > 0
          ? assignment.target_student_ids.length
          : classTotal;
      const totalStudents = targeted;

      assignment._stats = {
        totalStudents: totalStudents,
        submitted: submittedCount,
        graded: gradedCount,
        pending: totalStudents - submittedCount,
      };

      if (req.user.role === "student") {
        const submissionResult = await pool.query(
          `SELECT id, status, score, teacher_comment, submitted_at, content 
                    FROM submissions 
                    WHERE assignment_id = $1 AND student_id = $2`,
          [assignment.id, req.user.id],
        );

        if (submissionResult.rows.length > 0) {
          const sub = submissionResult.rows[0];
          if (sub.content) {
            try {
              sub.answers = typeof sub.content === "string" ? JSON.parse(sub.content) : sub.content;
            } catch (e) {
              sub.answers = [];
            }
          }
          assignment.submission = sub;
        } else {
          assignment.submission = { status: "pending" };
        }
      }
    }

    res.json(result.rows);
  } catch (error) {
    console.error("Ошибка получения заданий:", error);
    res.status(500).json({ error: "Ошибка получения заданий" });
  }
});

// Получение задания
app.get("/api/assignments/:id", async (req, res) => {
  const { id } = req.params;
  try {
    const result = await pool.query(
      `
            SELECT a.*, COALESCE(u.full_name, u.username) as teacher_name
            FROM assignments a
            JOIN users u ON a.teacher_id = u.id
            WHERE a.id = $1
        `,
      [id],
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Задание не найдено" });
    }

    const assignment = result.rows[0];

    if (req.user.role === "student") {
      const targeted = Array.isArray(assignment.target_student_ids) && assignment.target_student_ids.length > 0;
      if (targeted && !assignment.target_student_ids.includes(req.user.id)) {
        return res.status(403).json({ error: "Задание не выдано вам" });
      }
    }

    const countResult = await pool.query("SELECT COUNT(*) as count FROM submissions WHERE assignment_id = $1", [id]);
    assignment.submissions_count = parseInt(countResult.rows[0]?.count || 0);

    if (req.user.role === "student") {
      const submissionResult = await pool.query(
        `
            SELECT 
                s.*,
                COALESCE(
                    (SELECT json_agg(f.*) FROM submission_files f WHERE f.submission_id = s.id),
                    '[]'::json
                ) as files,
                COALESCE(
                    (SELECT json_agg(a.* ORDER BY a.created_at) FROM annotation_comments a WHERE a.submission_id = s.id),
                    '[]'::json
                ) as annotations
            FROM submissions s
            WHERE s.assignment_id = $1 AND s.student_id = $2
        `,
        [id, req.user.id],
      );

      assignment.submission = submissionResult.rows[0] || null;

      if (assignment.submission) {
        if (assignment.submission.content) {
          try {
            assignment.submission.answers =
              typeof assignment.submission.content === "string"
                ? JSON.parse(assignment.submission.content)
                : assignment.submission.content;
          } catch (e) {
            assignment.submission.answers = [];
          }
        }
      }
    }

    res.json(assignment);
  } catch (error) {
    console.error("❌ Ошибка получения задания:", error);
    res.status(500).json({ error: "Ошибка получения задания: " + error.message });
  }
});

// Работы по заданию (учитель)
app.get("/api/assignments/:assignmentId/submissions", requireTeacher, async (req, res) => {
  const { assignmentId } = req.params;

  try {
    const assignmentCheck = await pool.query(
      "SELECT teacher_id, target_student_ids FROM assignments WHERE id = $1",
      [assignmentId],
    );

    if (assignmentCheck.rows.length === 0) {
      return res.status(404).json({ error: "Задание не найдено" });
    }

    if (assignmentCheck.rows[0].teacher_id !== req.user.id) {
      return res.status(403).json({ error: "Нет доступа к этому заданию" });
    }

    const assignmentTargetIds = assignmentCheck.rows[0].target_student_ids;

    const result = await pool.query(
      `
            SELECT 
                s.*,
                u.username,
                u.full_name,
                u.id as student_id
            FROM submissions s
            JOIN users u ON s.student_id = u.id
            WHERE s.assignment_id = $1
            ORDER BY s.submitted_at DESC NULLS LAST, s.created_at DESC
        `,
      [assignmentId],
    );

    let submissionRows = result.rows;
    if (Array.isArray(assignmentTargetIds) && assignmentTargetIds.length > 0) {
      const targetSet = new Set(assignmentTargetIds.map((id) => Number(id)));
      submissionRows = submissionRows.filter((r) => targetSet.has(Number(r.student_id)));
    }

    const submissions = [];
    for (const row of submissionRows) {
      const filesResult = await pool.query("SELECT * FROM submission_files WHERE submission_id = $1", [row.id]);
      submissions.push({
        ...row,
        files: filesResult.rows || [],
      });
    }

    res.json(submissions);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Ошибка получения работ" });
  }
});

// Ученики по заданию (учитель)
app.get("/api/assignments/:assignmentId/students", requireTeacher, async (req, res) => {
  const { assignmentId } = req.params;

  try {
    const assignmentResult = await pool.query(
      "SELECT class_id, target_student_ids FROM assignments WHERE id = $1 AND teacher_id = $2",
      [assignmentId, req.user.id],
    );

    if (assignmentResult.rows.length === 0) {
      return res.status(404).json({ error: "Задание не найдено" });
    }

    const classId = assignmentResult.rows[0].class_id;
    const targetIds = assignmentResult.rows[0].target_student_ids;

    const studentsResult = await pool.query(
      `
            SELECT u.id, u.username, u.full_name,
                s.id as submission_id,
                s.status,
                s.score,
                s.submitted_at
            FROM users u
            JOIN class_students cs ON u.id = cs.student_id
            LEFT JOIN submissions s ON s.student_id = u.id AND s.assignment_id = $1
            WHERE cs.class_id = $2
            ORDER BY u.full_name, u.username
        `,
      [assignmentId, classId],
    );

    let rows = studentsResult.rows;
    if (Array.isArray(targetIds) && targetIds.length > 0) {
      const targetSet = new Set(targetIds.map((id) => Number(id)));
      rows = rows.filter((r) => targetSet.has(Number(r.id)));
    }

    res.json(rows);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Ошибка получения студентов" });
  }
});


// ============================================================
// API /api (boards)
// ============================================================



// ============ ЛИЧНАЯ ДОСКА ============

app.get("/api/board", async (req, res) => {
  try {
    const result = await pool.query("SELECT board_data FROM boards WHERE user_id = $1", [req.user.id]);
    if (result.rows.length === 0) {
      await pool.query("INSERT INTO boards (user_id, board_data) VALUES ($1, $2)", [
        req.user.id,
        JSON.stringify({ objects: [] }),
      ]);
      return res.json({ objects: [] });
    }
    res.json(result.rows[0].board_data);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Ошибка получения доски" });
  }
});

app.post("/api/board", async (req, res) => {
  const { boardData } = req.body;
  if (!boardData) return res.status(400).json({ error: "Нет данных для сохранения" });
  try {
    await pool.query(
      `INSERT INTO boards (user_id, board_data, updated_at) 
            VALUES ($1, $2, CURRENT_TIMESTAMP)
            ON CONFLICT (user_id) DO UPDATE SET board_data = $2, updated_at = CURRENT_TIMESTAMP`,
      [req.user.id, JSON.stringify(boardData)],
    );
    res.json({ message: "Доска сохранена" });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Ошибка сохранения доски" });
  }
});

// ============ ДОСКА КЛАССА ============

app.get("/api/class-board/:classId", async (req, res) => {
  const { classId } = req.params;
  try {
    let hasAccess = false;
    if (req.user.role === "teacher") {
      const classCheck = await pool.query("SELECT id FROM classes WHERE id = $1 AND teacher_id = $2", [
        classId,
        req.user.id,
      ]);
      if (classCheck.rows.length > 0) hasAccess = true;
    } else if (req.user.role === "student") {
      const classCheck = await pool.query(
        "SELECT class_id FROM class_students WHERE class_id = $1 AND student_id = $2",
        [classId, req.user.id],
      );
      if (classCheck.rows.length > 0) hasAccess = true;
    }
    if (!hasAccess) return res.status(403).json({ error: "Нет доступа" });

    const result = await pool.query("SELECT * FROM class_boards WHERE class_id = $1", [classId]);
    if (result.rows.length > 0) return res.json(result.rows[0]);

    const newBoard = await pool.query(
      `INSERT INTO class_boards (class_id, board_data, updated_at) 
            VALUES ($1, $2, CURRENT_TIMESTAMP) RETURNING *`,
      [classId, JSON.stringify({ objects: [] })],
    );
    res.json(newBoard.rows[0]);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Ошибка получения доски" });
  }
});

app.post("/api/class-board/:classId", async (req, res) => {
  const { classId } = req.params;
  const { boardData } = req.body;
  if (!boardData || !boardData.objects) return res.status(400).json({ error: "Нет данных" });
  try {
    let hasAccess = false;
    if (req.user.role === "teacher") {
      const classCheck = await pool.query("SELECT id FROM classes WHERE id = $1 AND teacher_id = $2", [
        classId,
        req.user.id,
      ]);
      if (classCheck.rows.length > 0) hasAccess = true;
    } else if (req.user.role === "student") {
      const classCheck = await pool.query(
        "SELECT class_id FROM class_students WHERE class_id = $1 AND student_id = $2",
        [classId, req.user.id],
      );
      if (classCheck.rows.length > 0) hasAccess = true;
    }
    if (!hasAccess) return res.status(403).json({ error: "Нет доступа" });

    const result = await pool.query(
      `INSERT INTO class_boards (class_id, board_data, updated_at) 
            VALUES ($1, $2, CURRENT_TIMESTAMP)
            ON CONFLICT (class_id) 
            DO UPDATE SET board_data = $2, updated_at = CURRENT_TIMESTAMP
            RETURNING *`,
      [classId, JSON.stringify(boardData)],
    );
    res.json(result.rows[0]);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Ошибка сохранения" });
  }
});

// ============ ОБЩАЯ ДОСКА (ученик+учитель) ============

app.get("/api/shared-board/:classId/:studentId?", async (req, res) => {
  const { classId, studentId } = req.params;
  try {
    let teacherId = null,
      studentIdValue = null;
    if (req.user.role === "teacher" && studentId) {
      teacherId = req.user.id;
      studentIdValue = parseInt(studentId);
    } else if (req.user.role === "student") {
      const teacherResult = await pool.query("SELECT teacher_id FROM classes WHERE id = $1", [classId]);
      if (teacherResult.rows.length === 0) return res.status(404).json({ error: "Класс не найден" });
      teacherId = teacherResult.rows[0].teacher_id;
      studentIdValue = req.user.id;
    } else {
      const result = await pool.query("SELECT board_data FROM boards WHERE user_id = $1", [req.user.id]);
      return res.json({ board_data: result.rows[0]?.board_data || { objects: [] }, isPersonal: true });
    }
    if (!teacherId || !studentIdValue) return res.json({ board_data: { objects: [] }, isNew: true });

    const result = await pool.query(
      "SELECT * FROM shared_boards WHERE teacher_id = $1 AND student_id = $2 AND class_id = $3",
      [teacherId, studentIdValue, parseInt(classId)],
    );
    if (result.rows.length > 0) return res.json(result.rows[0]);

    const newBoard = await pool.query(
      `INSERT INTO shared_boards (teacher_id, student_id, class_id, board_data, updated_at) 
            VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP) RETURNING *`,
      [teacherId, studentIdValue, parseInt(classId), JSON.stringify({ objects: [] })],
    );
    res.json(newBoard.rows[0]);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Ошибка получения доски" });
  }
});

app.post("/api/shared-board/:classId/:studentId?", async (req, res) => {
  const { classId, studentId } = req.params;
  const { boardData } = req.body;
  if (!boardData || !boardData.objects) return res.status(400).json({ error: "Нет данных" });
  try {
    let teacherId = null,
      studentIdValue = null;
    if (req.user.role === "teacher" && studentId) {
      teacherId = req.user.id;
      studentIdValue = parseInt(studentId);
    } else if (req.user.role === "student") {
      const teacherResult = await pool.query("SELECT teacher_id FROM classes WHERE id = $1", [classId]);
      if (teacherResult.rows.length === 0) return res.status(404).json({ error: "Класс не найден" });
      teacherId = teacherResult.rows[0].teacher_id;
      studentIdValue = req.user.id;
    } else {
      return res.status(400).json({ error: "Неверные параметры" });
    }
    if (!teacherId || !studentIdValue) return res.status(400).json({ error: "Недостаточно данных" });

    const result = await pool.query(
      `INSERT INTO shared_boards (teacher_id, student_id, class_id, board_data, updated_at) 
            VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP)
            ON CONFLICT (teacher_id, student_id, class_id) 
            DO UPDATE SET board_data = $4, updated_at = CURRENT_TIMESTAMP
            RETURNING *`,
      [teacherId, studentIdValue, parseInt(classId), JSON.stringify(boardData)],
    );
    res.json(result.rows[0]);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Ошибка сохранения" });
  }
});


// ============================================================
// API /api (submissions)
// ============================================================



// Сравнение ответа ученика с правильным ответом для автопроверки
function compareAnswers(answer, correct) {
  if (correct === null || correct === undefined) return false;
  const normalize = (s) =>
    String(s)
      .trim()
      .replace(/\s+/g, " ")
      .toLowerCase();
  const normAnswer = normalize(answer);

  const numAnswer = parseFloat(normAnswer.replace(",", "."));
  const numCorrect = parseFloat(normalize(correct).replace(",", "."));
  if (!isNaN(numCorrect) && !isNaN(numAnswer) && normalize(correct) !== "") {
    if (numAnswer === numCorrect) return true;
  }

  const alternatives = String(correct)
    .split("|")
    .map((a) => normalize(a))
    .filter(Boolean);
  if (!alternatives.length) return false;
  return alternatives.includes(normAnswer);
}

// Отправка ответа (простой режим)
app.post("/api/submissions", async (req, res) => {
  const { assignmentId, content } = req.body;
  try {
    const existing = await pool.query("SELECT id FROM submissions WHERE assignment_id = $1 AND student_id = $2", [
      assignmentId,
      req.user.id,
    ]);

    let submissionId;
    if (existing.rows.length > 0) {
      const result = await pool.query(
        `UPDATE submissions 
                SET content = $1, status = 'submitted', submitted_at = CURRENT_TIMESTAMP
                WHERE assignment_id = $2 AND student_id = $3
                RETURNING id`,
        [content, assignmentId, req.user.id],
      );
      submissionId = result.rows[0].id;
    } else {
      const result = await pool.query(
        `INSERT INTO submissions (assignment_id, student_id, content, status, submitted_at) 
                VALUES ($1, $2, $3, 'submitted', CURRENT_TIMESTAMP) RETURNING id`,
        [assignmentId, req.user.id, content],
      );
      submissionId = result.rows[0].id;
    }

    res.json({ submissionId, message: "Ответ отправлен" });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Ошибка отправки ответа" });
  }
});

// Простой POST /api/submissions/:submissionId/files
app.post("/api/submissions/:submissionId/files", upload.array("files", 10), async (req, res) => {
  const { submissionId } = req.params;
  try {
    // Проверка владения: файлы может прикреплять автор работы или учитель задания
    const sub = await pool.query(
      `SELECT s.student_id, a.teacher_id
       FROM submissions s JOIN assignments a ON s.assignment_id = a.id
       WHERE s.id = $1`,
      [submissionId],
    );
    if (sub.rows.length === 0) {
      return res.status(404).json({ error: "Работа не найдена" });
    }
    if (sub.rows[0].student_id !== req.user.id && sub.rows[0].teacher_id !== req.user.id) {
      return res.status(403).json({ error: "Нет доступа к этой работе" });
    }

    const files = req.files.map((file) => ({
      fileName: file.originalname,
      filePath: file.path,
      fileType: file.mimetype,
      fileSize: file.size,
    }));

    for (const file of files) {
      await pool.query(
        `INSERT INTO submission_files (submission_id, file_name, file_path, file_type, file_size) 
                VALUES ($1, $2, $3, $4, $5)`,
        [submissionId, file.fileName, file.filePath, file.fileType, file.fileSize],
      );
    }

    res.json({ files, message: "Файлы загружены" });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Ошибка загрузки файлов" });
  }
});

// GET /api/submissions/:submissionId/files
app.get("/api/submissions/:submissionId/files", async (req, res) => {
  const { submissionId } = req.params;
  try {
    const result = await pool.query("SELECT * FROM submission_files WHERE submission_id = $1 ORDER BY uploaded_at", [
      submissionId,
    ]);
    res.json(result.rows);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Ошибка получения файлов" });
  }
});

// Пакет отправки ответов (с автопроверкой)
app.post("/api/submissions/batch", upload.any(), async (req, res) => {
  const { assignmentId, answers } = req.body;

  if (!assignmentId || !answers) {
    return res.status(400).json({ error: "Недостаточно данных" });
  }

  try {
    const parsedAnswers = JSON.parse(answers);
    if (!Array.isArray(parsedAnswers) || !parsedAnswers.length) {
      return res.status(400).json({ error: "Некорректный формат ответов" });
    }

    const assignmentCheck = await pool.query(
      `SELECT a.id, a.class_id, a.auto_check, a.content, a.max_score, a.target_student_ids
            FROM assignments a
            JOIN class_students cs ON a.class_id = cs.class_id
            WHERE a.id = $1 AND cs.student_id = $2`,
      [assignmentId, req.user.id],
    );

    if (assignmentCheck.rows.length === 0) {
      return res.status(403).json({ error: "Нет доступа к этому заданию" });
    }

    const assignment = assignmentCheck.rows[0];

    if (Array.isArray(assignment.target_student_ids) && assignment.target_student_ids.length > 0) {
      if (!assignment.target_student_ids.includes(req.user.id)) {
        return res.status(403).json({ error: "Задание не выдано вам" });
      }
    }

    const items = assignment.content?.items || [];

    if (req.files && req.files.length > 0) {
      for (const file of req.files) {
        const fileIndex = parseInt(file.fieldname.replace("image_", ""));
        if (!isNaN(fileIndex)) {
          const fileName = file.filename;
          const answer = parsedAnswers.find((a) => a.index === fileIndex);
          if (answer) {
            answer.image = fileName;
          }
        }
      }
    }

    const answersJson = JSON.stringify(parsedAnswers);

    const existing = await pool.query("SELECT id FROM submissions WHERE assignment_id = $1 AND student_id = $2", [
      assignmentId,
      req.user.id,
    ]);

    let subtaskScores = null;
    let autoResult = null;

    if (assignment.auto_check && items.length > 0 && parsedAnswers.length > 0) {
      const results = items.map((item, idx) => {
        const maxScore = parseFloat(item.score) || 1;
        const answer = parsedAnswers.find((a) => a.index === idx);
        const answerText = answer && typeof answer.text === "string" ? answer.text.trim() : "";
        const autoGraded = !!(item.autoCheck && item.correctAnswer !== null && item.correctAnswer !== undefined);

        if (autoGraded) {
          const correct = compareAnswers(answerText, item.correctAnswer);
          return { index: idx, maxScore, earned: correct ? maxScore : 0, correct, autoGraded: true };
        }
        return { index: idx, maxScore, earned: null, correct: null, autoGraded: false };
      });

      const totalEarned = results.reduce((s, r) => s + (r.earned ?? 0), 0);
      const allAutoGraded = results.every((r) => r.autoGraded);
      subtaskScores = results;

      autoResult = {
        autoGraded: true,
        score: allAutoGraded ? totalEarned : null,
        totalMaxScore: items.reduce((s, it) => s + (parseFloat(it.score) || 1), 0),
        allAutoGraded,
        results,
      };
    }

    let submissionId;
    const newStatus = autoResult && autoResult.allAutoGraded ? "graded" : "submitted";
    const newScore = autoResult && autoResult.allAutoGraded ? autoResult.score : null;
    const newGradedAt = newStatus === "graded" ? new Date() : null;

    if (existing.rows.length > 0) {
      const updateResult = await pool.query(
        `UPDATE submissions 
                SET content = $1,
                    status = $2,
                    score = $3,
                    subtask_scores = $4,
                    graded_at = $5,
                    submitted_at = CURRENT_TIMESTAMP
                WHERE assignment_id = $6 AND student_id = $7
                RETURNING id`,
        [
          answersJson,
          newStatus,
          newScore,
          subtaskScores ? JSON.stringify(subtaskScores) : null,
          newGradedAt,
          assignmentId,
          req.user.id,
        ],
      );
      submissionId = updateResult.rows[0].id;
    } else {
      const insertResult = await pool.query(
        `INSERT INTO submissions (assignment_id, student_id, content, status, score, subtask_scores, submitted_at, graded_at) 
                VALUES ($1, $2, $3, $4, $5, $6, CURRENT_TIMESTAMP, $7)
                RETURNING id`,
        [
          assignmentId,
          req.user.id,
          answersJson,
          newStatus,
          newScore,
          subtaskScores ? JSON.stringify(subtaskScores) : null,
          newGradedAt,
        ],
      );
      submissionId = insertResult.rows[0].id;
    }

    res.json({
      submissionId,
      message: autoResult ? "Ответы отправлены и проверены автоматически" : "Ответы отправлены",
      autoResult,
    });
  } catch (error) {
    console.error("❌ Ошибка:", error);
    res.status(500).json({ error: "Ошибка отправки ответов: " + error.message });
  }
});

// Полные данные по работе
app.get("/api/submissions/:submissionId/full", async (req, res) => {
  const { submissionId } = req.params;

  try {
    const subResult = await pool.query(
      `
            SELECT 
                s.*,
                u.username,
                u.full_name
            FROM submissions s
            JOIN users u ON s.student_id = u.id
            WHERE s.id = $1
        `,
      [submissionId],
    );

    if (subResult.rows.length === 0) {
      return res.status(404).json({ error: "Работа не найдена" });
    }

    const submission = subResult.rows[0];

    let hasAccess = false;

    if (req.user.role === "teacher") {
      const check = await pool.query("SELECT teacher_id FROM assignments WHERE id = $1", [submission.assignment_id]);
      if (check.rows.length > 0 && check.rows[0].teacher_id === req.user.id) {
        hasAccess = true;
      }
    } else if (req.user.role === "student") {
      if (submission.student_id === req.user.id) {
        hasAccess = true;
      }
    }

    if (!hasAccess) {
      return res.status(403).json({ error: "Нет доступа к этой работе" });
    }

    // Независимые запросы — параллельно
    const [filesResult, annotationsResult, textCommentsResult, voiceCommentsResult, assignmentResult] =
      await Promise.all([
        pool.query("SELECT * FROM submission_files WHERE submission_id = $1 ORDER BY uploaded_at", [
          submissionId,
        ]),
        pool.query("SELECT * FROM annotation_comments WHERE submission_id = $1 ORDER BY created_at", [
          submissionId,
        ]),
        pool.query("SELECT * FROM text_comments WHERE submission_id = $1 ORDER BY created_at", [
          submissionId,
        ]),
        pool.query(
          `SELECT v.*, u.full_name as teacher_name 
            FROM voice_comments v
            JOIN users u ON v.teacher_id = u.id
            WHERE v.submission_id = $1
            ORDER BY v.created_at ASC`,
          [submissionId],
        ),
        pool.query(
          `
            SELECT a.*, COALESCE(u.full_name, u.username) as teacher_name
            FROM assignments a
            JOIN users u ON a.teacher_id = u.id
            WHERE a.id = $1
        `,
          [submission.assignment_id],
        ),
      ]);
    submission.files = filesResult.rows || [];
    submission.annotations = annotationsResult.rows || [];
    submission.textComments = textCommentsResult.rows || [];
    submission.voiceComments = voiceCommentsResult.rows || [];
    submission.assignment = assignmentResult.rows[0] || null;

    res.json(submission);
  } catch (error) {
    console.error("❌ Ошибка получения полных данных:", error);
    res.status(500).json({ error: "Ошибка получения данных: " + error.message });
  }
});

// Оценка работы (учитель)
app.post("/api/submissions/:submissionId/grade", requireTeacher, async (req, res) => {
  const { submissionId } = req.params;
  const { score, comment, subtaskScores } = req.body;

  if (score === undefined || score === null) {
    return res.status(400).json({ error: "Оценка обязательна" });
  }

  try {
    const submissionCheck = await pool.query(
      `
            SELECT a.teacher_id, s.id, s.assignment_id
            FROM submissions s
            JOIN assignments a ON s.assignment_id = a.id
            WHERE s.id = $1
        `,
      [submissionId],
    );

    if (submissionCheck.rows.length === 0) {
      return res.status(404).json({ error: "Ответ не найден" });
    }

    if (submissionCheck.rows[0].teacher_id !== req.user.id) {
      return res.status(403).json({ error: "Нет доступа к этому ответу" });
    }

    let subScoresJson = null;
    if (Array.isArray(subtaskScores) && subtaskScores.length > 0) {
      subScoresJson = JSON.stringify(subtaskScores);
    }

    await pool.query(
      `
            UPDATE submissions 
            SET score = $1, 
                teacher_comment = $2, 
                status = 'graded', 
                subtask_scores = COALESCE($3, subtask_scores),
                graded_at = CURRENT_TIMESTAMP
            WHERE id = $4
        `,
      [score, comment || null, subScoresJson, submissionId],
    );

    res.json({ message: "Оценка сохранена" });
  } catch (error) {
    console.error("❌ Ошибка сохранения оценки:", error);
    res.status(500).json({ error: "Ошибка сохранения оценки: " + error.message });
  }
});

// Единичная работа
app.get("/api/submissions/:submissionId", async (req, res) => {
  const { submissionId } = req.params;

  try {
    const result = await pool.query(
      `
            SELECT 
                s.*,
                u.username,
                u.full_name
            FROM submissions s
            JOIN users u ON s.student_id = u.id
            WHERE s.id = $1
        `,
      [submissionId],
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Работа не найдена" });
    }

    const submission = result.rows[0];

    if (req.user.role === "teacher") {
      const assignmentCheck = await pool.query("SELECT teacher_id FROM assignments WHERE id = $1", [
        submission.assignment_id,
      ]);
      if (assignmentCheck.rows.length === 0 || assignmentCheck.rows[0].teacher_id !== req.user.id) {
        return res.status(403).json({ error: "Нет доступа к этой работе" });
      }
    } else if (req.user.role === "student") {
      if (submission.student_id !== req.user.id) {
        return res.status(403).json({ error: "Нет доступа к этой работе" });
      }
    }

    const filesResult = await pool.query("SELECT * FROM submission_files WHERE submission_id = $1", [submissionId]);
    submission.files = filesResult.rows || [];

    const annotationsResult = await pool.query(
      "SELECT * FROM annotation_comments WHERE submission_id = $1 ORDER BY created_at",
      [submissionId],
    );
    submission.annotations = annotationsResult.rows || [];

    res.json(submission);
  } catch (error) {
    console.error("Ошибка получения работы:", error);
    res.status(500).json({ error: "Ошибка получения работы" });
  }
});


// ============================================================
// API /api (comments)
// ============================================================



// ============ АННОТАЦИИ ============

app.post("/api/annotations", requireTeacher, async (req, res) => {
  try {
    const { submissionId, x, y, width, height, comment, color, subtaskIndex } = req.body;
    const teacherId = req.user.id;

    const checkResult = await pool.query(
      `
            SELECT a.teacher_id 
            FROM submissions s
            JOIN assignments a ON s.assignment_id = a.id
            WHERE s.id = $1
        `,
      [submissionId],
    );

    if (checkResult.rows.length === 0) {
      return res.status(404).json({ error: "Работа не найдена" });
    }
    if (checkResult.rows[0].teacher_id !== teacherId) {
      return res.status(403).json({ error: "Нет доступа к этой работе" });
    }

    const columnCheck = await pool.query(`
            SELECT EXISTS (
                SELECT FROM information_schema.columns 
                WHERE table_name = 'annotation_comments' AND column_name = 'subtask_index'
            );
        `);

    if (!columnCheck.rows[0].exists) {
      await pool.query(`
                ALTER TABLE annotation_comments 
                ADD COLUMN subtask_index INTEGER DEFAULT 0
            `);
    }

    const result = await pool.query(
      `INSERT INTO annotation_comments (submission_id, teacher_id, x, y, width, height, comment, color, subtask_index, created_at)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, CURRENT_TIMESTAMP)
            RETURNING id`,
      [submissionId, teacherId, x, y, width, height, comment, color || "#ff3b30", subtaskIndex || 0],
    );

    res.json({ id: result.rows[0].id });
  } catch (error) {
    console.error("❌ Ошибка сохранения аннотации:", error);
    res.status(500).json({ error: "Ошибка сохранения: " + error.message });
  }
});

app.get("/api/annotations/:submissionId", async (req, res) => {
  const { submissionId } = req.params;

  try {
    const tableCheck = await pool.query(`
            SELECT EXISTS (
                SELECT FROM information_schema.tables 
                WHERE table_name = 'annotation_comments'
            );
        `);

    if (!tableCheck.rows[0].exists) {
      return res.json([]);
    }

    let hasAccess = false;

    if (req.user.role === "teacher") {
      const checkResult = await pool.query(
        `
            SELECT a.teacher_id 
            FROM submissions s
            JOIN assignments a ON s.assignment_id = a.id
            WHERE s.id = $1
        `,
        [submissionId],
      );

      if (checkResult.rows.length > 0 && checkResult.rows[0].teacher_id === req.user.id) {
        hasAccess = true;
      }
    } else if (req.user.role === "student") {
      const checkResult = await pool.query(`SELECT student_id FROM submissions WHERE id = $1`, [submissionId]);

      if (checkResult.rows.length > 0 && checkResult.rows[0].student_id === req.user.id) {
        hasAccess = true;
      }
    }

    if (!hasAccess) {
      return res.status(403).json({ error: "Нет доступа" });
    }

    const result = await pool.query(
      `SELECT a.*, u.full_name as teacher_name 
            FROM annotation_comments a
            JOIN users u ON a.teacher_id = u.id
            WHERE a.submission_id = $1
            ORDER BY a.created_at ASC`,
      [submissionId],
    );

    res.json(result.rows);
  } catch (error) {
    console.error("❌ Ошибка получения аннотаций:", error);
    res.status(500).json({ error: "Ошибка получения: " + error.message });
  }
});

app.delete("/api/annotations/:id", requireTeacher, async (req, res) => {
  const { id } = req.params;

  try {
    const result = await pool.query(
      `DELETE FROM annotation_comments WHERE id = $1 AND teacher_id = $2 RETURNING id, subtask_index`,
      [id, req.user.id],
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Комментарий не найден или нет прав" });
    }

    const annSubtask = result.rows[0].subtask_index || 0;

    try {
      const voiceRes = await pool.query(
        `SELECT id, audio_path FROM voice_comments WHERE annotation_id = $1
         UNION
         SELECT id, audio_path FROM voice_comments
         WHERE annotation_id IS NULL AND subtask_index = $2 AND selected_text = 'Комментарий к фото'`,
        [id, annSubtask],
      );
      for (const vc of voiceRes.rows) {
        if (vc.audio_path) {
          const filePath = vc.audio_path.startsWith("uploads/") ? vc.audio_path : "uploads/" + vc.audio_path;
          if (fs.existsSync(filePath)) {
            try {
              fs.unlinkSync(filePath);
            } catch (e) {}
          }
        }
        await pool.query(`DELETE FROM voice_comments WHERE id = $1`, [vc.id]);
      }
    } catch (e) {
      console.error("❌ Ошибка удаления голосового комментария аннотации:", e.message);
    }

    res.json({ success: true });
  } catch (error) {
    console.error("❌ Ошибка удаления аннотации:", error);
    res.status(500).json({ error: "Ошибка удаления: " + error.message });
  }
});

app.put("/api/annotations/:id", async (req, res) => {
  const { id } = req.params;
  const { audioPath } = req.body;
  const userId = req.user.id;

  try {
    const result = await pool.query(
      `UPDATE annotations 
            SET audio_path = $1 
            WHERE id = $2 AND teacher_id = $3`,
      [audioPath, id, userId],
    );
    if (result.rowCount === 0) {
      return res.status(404).json({ error: "Аннотация не найдена" });
    }
    res.json({ success: true });
  } catch (error) {
    console.error("Ошибка обновления аннотации:", error);
    res.status(500).json({ error: "Ошибка сервера" });
  }
});

// ============ ГОЛОСОВЫЕ КОММЕНТАРИИ ============

app.post("/api/voice-comments", requireTeacher, audioUpload.single("audio"), async (req, res) => {
  const { submissionId, subtaskIndex, duration, selectedText, annotationId } = req.body;

  if (!submissionId || !req.file) {
    return res.status(400).json({ error: "Недостаточно данных" });
  }

  try {
    // ===== КОНВЕРТАЦИЯ webm → mp4 (для совместимости с iOS) =====
    // Если браузер записал webm, а ffmpeg есть — транскодируем в AAC/mp4,
    // чтобы iPhone/планшет могли воспроизвести.
    let storedFsPath = req.file.path;
    let converted = null;
    try {
      converted = await convertWebmToMp4(path.resolve(storedFsPath));
    } catch (e) {
      console.error("⚠️ Конвертация аудио пропущена:", e.message);
    }
    if (converted) {
      storedFsPath = converted;
    }

    let audioPath = storedFsPath.replace(/\\/g, "/");
    if (!audioPath.startsWith("uploads/")) {
      // may be absolute → привести к serve-пути
      audioPath = toServePath(audioPath);
    }

    const result = await pool.query(
      `INSERT INTO voice_comments (submission_id, teacher_id, subtask_index, audio_path, duration, selected_text, annotation_id, created_at)
            VALUES ($1, $2, $3, $4, $5, $6, $7, CURRENT_TIMESTAMP)
            RETURNING id, audio_path, duration, selected_text, created_at`,
      [submissionId, req.user.id, subtaskIndex || 0, audioPath, duration || 0, selectedText || null, annotationId || null],
    );

    res.json(result.rows[0]);
  } catch (error) {
    console.error("❌ Ошибка сохранения голосового комментария:", error);
    res.status(500).json({ error: "Ошибка сохранения: " + error.message });
  }
});

app.get("/api/voice-comments/:submissionId", async (req, res) => {
  const { submissionId } = req.params;

  try {
    let hasAccess = false;
    if (req.user.role === "teacher") {
      const check = await pool.query(
        `
            SELECT a.teacher_id 
            FROM submissions s
            JOIN assignments a ON s.assignment_id = a.id
            WHERE s.id = $1
        `,
        [submissionId],
      );
      if (check.rows.length > 0 && check.rows[0].teacher_id === req.user.id) {
        hasAccess = true;
      }
    } else if (req.user.role === "student") {
      const check = await pool.query("SELECT student_id FROM submissions WHERE id = $1", [submissionId]);
      if (check.rows.length > 0 && check.rows[0].student_id === req.user.id) {
        hasAccess = true;
      }
    }

    if (!hasAccess) {
      return res.status(403).json({ error: "Нет доступа" });
    }

    const result = await pool.query(
      `SELECT v.*, u.full_name as teacher_name 
            FROM voice_comments v
            JOIN users u ON v.teacher_id = u.id
            WHERE v.submission_id = $1
            ORDER BY v.created_at ASC`,
      [submissionId],
    );

    const comments = result.rows.map((c) => {
      let path = c.audio_path || "";
      path = path.replace(/\\/g, "/");
      path = path.replace(/uploadsaudio/g, "uploads/audio/");
      path = path.replace(/\/\/+/g, "/");

      return {
        ...c,
        audio_path: path,
        audio_url: path ? `/${path}` : null,
      };
    });

    res.json(comments);
  } catch (error) {
    console.error("❌ Ошибка получения голосовых комментариев:", error);
    res.status(500).json({ error: "Ошибка получения: " + error.message });
  }
});

app.delete("/api/voice-comments/:id", requireTeacher, async (req, res) => {
  const { id } = req.params;

  try {
    const fileResult = await pool.query("SELECT audio_path FROM voice_comments WHERE id = $1 AND teacher_id = $2", [
      id,
      req.user.id,
    ]);

    if (fileResult.rows.length === 0) {
      return res.status(404).json({ error: "Комментарий не найден" });
    }

    const filePath = fileResult.rows[0].audio_path;
    if (filePath && fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }

    await pool.query("DELETE FROM voice_comments WHERE id = $1", [id]);

    res.json({ success: true });
  } catch (error) {
    console.error("❌ Ошибка удаления голосового комментария:", error);
    res.status(500).json({ error: "Ошибка удаления: " + error.message });
  }
});

// ============ ТЕКСТОВЫЕ КОММЕНТАРИИ ============

app.post("/api/text-comments", requireTeacher, async (req, res) => {
  const { submissionId, subtaskIndex, selectedText, comment } = req.body;

  if (!submissionId || !selectedText || !comment) {
    return res.status(400).json({ error: "Недостаточно данных" });
  }

  try {
    const result = await pool.query(
      `INSERT INTO text_comments (submission_id, teacher_id, subtask_index, selected_text, comment)
            VALUES ($1, $2, $3, $4, $5)
            RETURNING id, created_at`,
      [submissionId, req.user.id, subtaskIndex || 0, selectedText, comment],
    );

    res.json({
      id: result.rows[0].id,
      created_at: result.rows[0].created_at,
    });
  } catch (error) {
    console.error("❌ Ошибка сохранения текстового комментария:", error);
    res.status(500).json({ error: "Ошибка сохранения: " + error.message });
  }
});

app.get("/api/text-comments/:submissionId", async (req, res) => {
  const { submissionId } = req.params;

  try {
    let hasAccess = false;

    if (req.user.role === "teacher") {
      const check = await pool.query(
        `
            SELECT a.teacher_id 
            FROM submissions s
            JOIN assignments a ON s.assignment_id = a.id
            WHERE s.id = $1
        `,
        [submissionId],
      );

      if (check.rows.length > 0 && check.rows[0].teacher_id === req.user.id) {
        hasAccess = true;
      }
    } else if (req.user.role === "student") {
      const check = await pool.query(`SELECT student_id FROM submissions WHERE id = $1`, [submissionId]);

      if (check.rows.length > 0 && check.rows[0].student_id === req.user.id) {
        hasAccess = true;
      }
    }

    if (!hasAccess) {
      return res.status(403).json({ error: "Нет доступа" });
    }

    const result = await pool.query(
      `SELECT id, subtask_index, selected_text, comment, created_at
            FROM text_comments
            WHERE submission_id = $1
            ORDER BY created_at ASC`,
      [submissionId],
    );

    res.json(result.rows);
  } catch (error) {
    console.error("❌ Ошибка получения текстовых комментариев:", error);
    res.status(500).json({ error: "Ошибка получения: " + error.message });
  }
});

app.delete("/api/text-comments/:id", requireTeacher, async (req, res) => {
  const { id } = req.params;

  try {
    const result = await pool.query(`DELETE FROM text_comments WHERE id = $1 AND teacher_id = $2 RETURNING id`, [
      id,
      req.user.id,
    ]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Комментарий не найден или нет прав" });
    }

    res.json({ success: true });
  } catch (error) {
    console.error("❌ Ошибка удаления текстового комментария:", error);
    res.status(500).json({ error: "Ошибка удаления: " + error.message });
  }
});


// ============================================================
// WEBSOCKET (комнаты досок)
// ============================================================
const rooms = new Map();

// Рассылка сообщения всем клиентам комнаты, кроме отправителя.
function broadcastToRoom(roomId, exclude, payload) {
  const room = rooms.get(roomId);
  if (!room) return;
  const msg = JSON.stringify(payload);
  for (const client of room) {
    if (client !== exclude && client.readyState === WebSocket.OPEN) client.send(msg);
  }
}

function removeFromRoom(ws) {
  const room = rooms.get(ws.roomId);
  if (!room) return;
  room.delete(ws);
  if (room.size === 0) rooms.delete(ws.roomId);
}

function setupBoardSocket(wss) {
  wss.on("connection", (ws) => {
    ws.on("message", (message) => {
      try {
        const data = JSON.parse(message);
        switch (data.type) {
          case "sync_request":
            broadcastToRoom(ws.roomId, ws, { type: "sync_request", boardId: ws.roomId, userId: ws.userId });
            break;
          case "undo":
          case "redo":
            broadcastToRoom(ws.roomId, ws, { type: data.type, boardId: ws.roomId, data: data.data, userId: ws.userId, userName: ws.userName || "Пользователь" });
            break;
          case "join":
            ws.roomId = data.roomId; ws.userId = data.userId; ws.role = data.role;
            rooms.forEach((clients, rId) => { clients.delete(ws); if (clients.size === 0) rooms.delete(rId); });
            if (!rooms.has(ws.roomId)) rooms.set(ws.roomId, new Set());
            rooms.get(ws.roomId).add(ws);
            break;
          case "draw":
            broadcastToRoom(ws.roomId, ws, { type: "draw", boardId: ws.roomId, data: { ...data.data, userId: ws.userId } });
            break;
          case "clear":
            broadcastToRoom(ws.roomId, ws, { type: "clear", boardId: ws.roomId });
            break;
          case "sync":
            broadcastToRoom(ws.roomId, ws, { type: "sync", boardId: ws.roomId, data: data.data });
            break;
          case "leave":
            removeFromRoom(ws);
            break;
        }
      } catch (error) { console.error("Ошибка WebSocket:", error); }
    });
    ws.on("close", () => removeFromRoom(ws));
  });
}

// ============================================================
// HTTP + WebSocket + ЗАПУСК
// ============================================================
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });
setupBoardSocket(wss);

async function ensureDbKeepAlive() {
  const timer = setInterval(async () => {
    try { await pool.query("SELECT 1"); }
    catch (e) { console.error("keep-alive ping:", e.message); }
  }, 30000);
  timer.unref();
}

pool.connect(async (err) => {
  if (err) { console.error("Ошибка подключения к БД:", err.message); process.exit(1); }
  else {
    await initDatabase();
    server.listen(port, "0.0.0.0", () => console.log("Сервер запущен на http://localhost:" + port));
    if (!process.env.DB_KEEP_ALIVE) await ensureDbKeepAlive();
  }
});
