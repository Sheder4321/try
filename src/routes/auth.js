const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const crypto = require("crypto");
require("dotenv").config();

const { pool } = require("../db");
const { sendPasswordResetEmail } = require("../../mailer");

const router = express.Router();

router.post("/register", async (req, res) => {
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

router.post("/login", async (req, res) => {
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

router.post("/forgot-password", async (req, res) => {
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

    await sendPasswordResetEmail(email, rawToken);

    res.json(genericResponse);
  } catch (error) {
    console.error("❌ Ошибка forgot-password:", error);
    res.json(genericResponse);
  }
});

router.post("/reset-password", async (req, res) => {
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

router.get("/reset-password/check", async (req, res) => {
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

module.exports = router;