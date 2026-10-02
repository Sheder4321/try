const express = require("express");
const { pool } = require("../db");
const { authenticateToken, requireTeacher } = require("../middleware/auth");
const { upload } = require("../middleware/upload");

const router = express.Router();
router.use(authenticateToken);

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
router.post("/", async (req, res) => {
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
router.post("/:submissionId/files", upload.array("files", 10), async (req, res) => {
  const { submissionId } = req.params;
  try {
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
router.get("/:submissionId/files", async (req, res) => {
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
router.post("/batch", upload.any(), async (req, res) => {
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
router.get("/:submissionId/full", async (req, res) => {
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

    const filesResult = await pool.query(
      "SELECT * FROM submission_files WHERE submission_id = $1 ORDER BY uploaded_at",
      [submissionId],
    );
    submission.files = filesResult.rows || [];

    const annotationsResult = await pool.query(
      "SELECT * FROM annotation_comments WHERE submission_id = $1 ORDER BY created_at",
      [submissionId],
    );
    submission.annotations = annotationsResult.rows || [];

    const textCommentsResult = await pool.query(
      "SELECT * FROM text_comments WHERE submission_id = $1 ORDER BY created_at",
      [submissionId],
    );
    submission.textComments = textCommentsResult.rows || [];

    const voiceCommentsResult = await pool.query(
      `SELECT v.*, u.full_name as teacher_name 
            FROM voice_comments v
            JOIN users u ON v.teacher_id = u.id
            WHERE v.submission_id = $1
            ORDER BY v.created_at ASC`,
      [submissionId],
    );
    submission.voiceComments = voiceCommentsResult.rows || [];

    const assignmentResult = await pool.query(
      `
            SELECT a.*, COALESCE(u.full_name, u.username) as teacher_name
            FROM assignments a
            JOIN users u ON a.teacher_id = u.id
            WHERE a.id = $1
        `,
      [submission.assignment_id],
    );
    submission.assignment = assignmentResult.rows[0] || null;

    res.json(submission);
  } catch (error) {
    console.error("❌ Ошибка получения полных данных:", error);
    res.status(500).json({ error: "Ошибка получения данных: " + error.message });
  }
});

// Оценка работы (учитель)
router.post("/:submissionId/grade", requireTeacher, async (req, res) => {
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
router.get("/:submissionId", async (req, res) => {
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

module.exports = { router, compareAnswers };