const express = require("express");
const fs = require("fs");
const { pool } = require("../db");
const { authenticateToken, requireTeacher } = require("../middleware/auth");
const { audioUpload } = require("../middleware/upload");

const router = express.Router();
router.use(authenticateToken);

// ============ АННОТАЦИИ ============

router.post("/annotations", requireTeacher, async (req, res) => {
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

router.get("/annotations/:submissionId", async (req, res) => {
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

router.delete("/annotations/:id", requireTeacher, async (req, res) => {
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

router.put("/annotations/:id", async (req, res) => {
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

router.post("/voice-comments", requireTeacher, audioUpload.single("audio"), async (req, res) => {
  const { submissionId, subtaskIndex, duration, selectedText, annotationId } = req.body;

  if (!submissionId || !req.file) {
    return res.status(400).json({ error: "Недостаточно данных" });
  }

  try {
    let audioPath = req.file.path.replace(/\\/g, "/");
    if (!audioPath.startsWith("uploads/")) {
      audioPath = "uploads/" + audioPath;
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

router.get("/voice-comments/:submissionId", async (req, res) => {
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

router.delete("/voice-comments/:id", requireTeacher, async (req, res) => {
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

router.post("/text-comments", requireTeacher, async (req, res) => {
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

router.get("/text-comments/:submissionId", async (req, res) => {
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

router.delete("/text-comments/:id", requireTeacher, async (req, res) => {
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

module.exports = router;