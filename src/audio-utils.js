const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");

// Конвертация аудио в MP4 (AAC), чтобы iOS Safari мог его воспроизводить.
// WebM iOS не декодирует — поэтому любой voice-комментарий, сохранившийся
// как .webm, транскодируем в .mp4 на лету (если доступен ffmpeg).

function findFfmpeg() {
  const explicit = process.env.FFMPEG_PATH;
  if (explicit && fs.existsSync(explicit)) return explicit;
  const names = process.platform === "win32" ? ["ffmpeg.exe", "ffmpeg"] : ["ffmpeg"];
  for (const n of names) {
    try {
      const { execSync } = require("child_process");
      const r = execSync(process.platform === "win32" ? `where ${n}` : `which ${n}`, { stdio: "pipe" })
        .toString()
        .trim();
      if (r) {
        const first = r.split(/\r?\n/)[0].trim();
        if (first) return first;
      }
    } catch (e) {}
  }
  return null;
}

let ffmpegPath = undefined;
function getFfmpeg() {
  if (ffmpegPath === undefined) ffmpegPath = findFfmpeg();
  return ffmpegPath;
}

function fileIsWebm(filePath) {
  try {
    const fd = fs.openSync(filePath, "r");
    const buf = Buffer.alloc(4);
    fs.readSync(fd, buf, 0, 4, 0);
    fs.closeSync(fd);
    // Matroska/WebM начинается с 1A 45 DF A3
    return buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3;
  } catch (e) {
    return false;
  }
}

/**
 * Конвертирует webm → mp4 (AAC) рядом с исходным файлом.
 * @param {string} filePath  абсолютный путь в файловой системе
 * @returns {Promise<string|null>} новый путь, или null если конвертация не нужна/не удалась
 */
function convertWebmToMp4(filePath) {
  return new Promise((resolve) => {
    const ff = getFfmpeg();
    if (!filePath || !fs.existsSync(filePath)) return resolve(null);
    if (!fileIsWebm(filePath)) return resolve(null); // уже не webm — не трогаем
    if (!ff) {
      console.warn("ffmpeg не найден — webm не сконвертирован:", filePath);
      return resolve(null);
    }

    const ext = path.extname(filePath);
    const mp4Path = filePath.slice(0, filePath.length - ext.length) + ".mp4";

    execFile(
      ff,
      ["-y", "-i", filePath, "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart", mp4Path],
      { timeout: 120000 },
      (err) => {
        if (err) {
          console.error("❌ Ошибка конвертации аудио в mp4:", err.message);
          return resolve(null); // оставляем исходный webm
        }
        // Успешно — удаляем webm, возвращаем новый путь
        try {
          fs.unlinkSync(filePath);
        } catch (e) {}
        resolve(mp4Path);
      },
    );
  });
}

function toServePath(fsPath) {
  let p = fsPath.replace(/\\/g, "/");
  const idx = p.indexOf("uploads/");
  p = idx >= 0 ? p.slice(idx) : p;
  return p;
}

module.exports = { convertWebmToMp4, toServePath, getFfmpeg };