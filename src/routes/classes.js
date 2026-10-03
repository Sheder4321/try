const express = require("express");
const { pool } = require("../db");
const { authenticateToken, requireTeacher } = require("../middleware/auth");

const router = express.Router();
router.use(authenticateToken);

router.post("/", requireTeacher, async (req, res) => {
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

router.get("/my", async (req, res) => {
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

router.get("/:classId", async (req, res) => {
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

router.get("/:classId/students", async (req, res) => {
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

router.delete("/:classId/students/:studentId", requireTeacher, async (req, res) => {
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

router.delete("/:classId", requireTeacher, async (req, res) => {
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

module.exports = router;