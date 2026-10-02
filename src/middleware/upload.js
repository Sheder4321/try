const multer = require("multer");
const fs = require("fs");
const path = require("path");

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

// Файлы работ учеников (фото/документы)
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    const uploadPath = "uploads/submissions/";
    ensureDir(uploadPath);
    cb(null, uploadPath);
  },
  filename: function (req, file, cb) {
    const uniqueSuffix = Date.now() + "-" + Math.round(Math.random() * 1e9);
    const ext = path.extname(file.originalname) || ".jpg";
    cb(null, uniqueSuffix + ext);
  },
});

const upload = multer({
  storage: storage,
  limits: { fileSize: 20 * 1024 * 1024 },
});

// Голосовые комментарии
const audioStorage = multer.diskStorage({
  destination: function (req, file, cb) {
    const uploadPath = "uploads/audio/";
    ensureDir(uploadPath);
    cb(null, uploadPath);
  },
  filename: function (req, file, cb) {
    const uniqueSuffix = Date.now() + "-" + Math.round(Math.random() * 1e9);
    // Сохраняем реальное расширение файла (на iOS это .mp4, на остальных .webm)
    const ext = path.extname(file.originalname) || ".webm";
    cb(null, "voice_" + uniqueSuffix + ext);
  },
});

const audioUpload = multer({
  storage: audioStorage,
  limits: { fileSize: 10 * 1024 * 1024 },
});

// Файлы заданий (картинки вопросов)
const assignmentStorage = multer.diskStorage({
  destination: function (req, file, cb) {
    const uploadPath = "uploads/assignments/";
    ensureDir(uploadPath);
    cb(null, uploadPath);
  },
  filename: function (req, file, cb) {
    const uniqueSuffix = Date.now() + "-" + Math.round(Math.random() * 1e9);
    cb(null, "q-" + uniqueSuffix + path.extname(file.originalname));
  },
});

const assignmentUpload = multer({
  storage: assignmentStorage,
  limits: { fileSize: 20 * 1024 * 1024 },
});

module.exports = { upload, audioUpload, assignmentUpload };