const express = require("express");
const { pool } = require("../db");
const { authenticateToken } = require("../middleware/auth");

const router = express.Router();
router.use(authenticateToken);

// ============ ЛИЧНАЯ ДОСКА ============

router.get("/board", async (req, res) => {
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

router.post("/board", async (req, res) => {
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

router.get("/class-board/:classId", async (req, res) => {
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

router.post("/class-board/:classId", async (req, res) => {
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

router.get("/shared-board/:classId/:studentId?", async (req, res) => {
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

router.post("/shared-board/:classId/:studentId?", async (req, res) => {
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

module.exports = router;