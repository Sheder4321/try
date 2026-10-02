const express = require("express");
const { pool } = require("../db");
const { authenticateToken, requireTeacher } = require("../middleware/auth");
const { assignmentUpload } = require("../middleware/upload");

const router = express.Router();
router.use(authenticateToken);

// Создание задания
router.post("/", requireTeacher, assignmentUpload.any(), async (req, res) => {
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
router.get("/class/:classId", async (req, res) => {
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
router.get("/:id", async (req, res) => {
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
router.get("/:assignmentId/submissions", requireTeacher, async (req, res) => {
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
router.get("/:assignmentId/students", requireTeacher, async (req, res) => {
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

module.exports = router;