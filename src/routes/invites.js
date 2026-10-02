const express = require("express");
const jwt = require("jsonwebtoken");
require("dotenv").config();

const { pool } = require("../db");
const { authenticateToken, requireTeacher } = require("../middleware/auth");

const router = express.Router();

router.post("/classes/:classId/invite", authenticateToken, requireTeacher, async (req, res) => {
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

    await pool.query(`
            CREATE TABLE IF NOT EXISTS class_invites (
                id SERIAL PRIMARY KEY,
                class_id INTEGER REFERENCES classes(id) ON DELETE CASCADE,
                token VARCHAR(100) UNIQUE NOT NULL,
                created_by INTEGER REFERENCES users(id) ON DELETE CASCADE,
                max_uses INTEGER DEFAULT 1,
                used_count INTEGER DEFAULT 0,
                expires_at TIMESTAMP,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                is_active BOOLEAN DEFAULT TRUE
            )
        `);

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

router.get("/invite/:token", async (req, res) => {
  const { token } = req.params;

  try {
    const tableCheck = await pool.query(`
            SELECT EXISTS (
                SELECT FROM information_schema.tables 
                WHERE table_name = 'class_invites'
            );
        `);

    if (!tableCheck.rows[0].exists) {
      return res.status(404).json({ error: "Приглашение не найдено" });
    }

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

router.post("/invite/:token/join", authenticateToken, async (req, res) => {
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

router.get("/classes/:classId/invites", authenticateToken, requireTeacher, async (req, res) => {
  const { classId } = req.params;

  try {
    const classCheck = await pool.query("SELECT id FROM classes WHERE id = $1 AND teacher_id = $2", [
      classId,
      req.user.id,
    ]);

    if (classCheck.rows.length === 0) {
      return res.status(404).json({ error: "Класс не найден" });
    }

    const tableCheck = await pool.query(`
      SELECT EXISTS (
        SELECT FROM information_schema.tables 
        WHERE table_name = 'class_invites'
      );
    `);

    if (!tableCheck.rows[0].exists) {
      return res.json([]);
    }

    await pool.query(
      `DELETE FROM class_invites 
      WHERE class_id = $1 
        AND (expires_at < NOW() OR used_count >= max_uses)`,
      [classId],
    );

    await pool.query(
      `DELETE FROM class_invites 
      WHERE class_id = $1 
        AND is_active = false 
        AND used_count >= max_uses`,
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

router.delete("/invite/:token", authenticateToken, requireTeacher, async (req, res) => {
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

module.exports = router;