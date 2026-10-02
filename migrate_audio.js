// Разовая миграция: конвертирует все существующие .webm голосовые комментарии
// в .mp4 (AAC) и обновляет audio_path в БД, чтобы iOS мог их воспроизвести.
// Запуск: node migrate_audio.js
const fs = require("fs");
const path = require("path");
const { pool } = require("./src/db");
const { convertWebmToMp4, toServePath } = require("./src/audio-utils");

(async () => {
  try {
    const { rows } = await pool.query("SELECT id, audio_path FROM voice_comments WHERE audio_path IS NOT NULL");
    console.log(`Найдено записей: ${rows.length}`);

    let convertedCount = 0;
    for (const row of rows) {
      let fsPath = toServePath(row.audio_path);
      // toServePath приводит к uploads/... — сделаем абсолют относительно cwd
      const abs = path.resolve(fsPath);
      if (!fs.existsSync(abs)) {
        console.warn(`Файл не найден, пропускаю id=${row.id}: ${abs}`);
        continue;
      }
      if (!abs.toLowerCase().endsWith(".mp4")) {
        const newPath = await convertWebmToMp4(abs);
        if (newPath) {
          const serve = toServePath(newPath);
          await pool.query("UPDATE voice_comments SET audio_path = $1 WHERE id = $2", [serve, row.id]);
          console.log(`OK id=${row.id}: ${row.audio_path} -> ${serve}`);
          convertedCount++;
        } else {
          console.warn(`Не удалось конвертировать id=${row.id}: ${abs}`);
        }
      } else {
        console.log(`Уже mp4, пропуск id=${row.id}`);
      }
    }
    console.log(`Готово. Сконвертировано: ${convertedCount}`);
  } catch (e) {
    console.error("❌ Ошибка миграции:", e);
    process.exit(1);
  } finally {
    await pool.end();
  }
})();