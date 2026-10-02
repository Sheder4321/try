const express = require("express");
const cors = require("cors");
const path = require("path");
const http = require("http");
const WebSocket = require("ws");
require("dotenv").config();

const { pool, initDatabase } = require("./src/db");
const { setupBoardSocket } = require("./src/ws/boards");

const app = express();
const port = process.env.PORT || 3000;

// ============================================================
// СТРАНИЦЫ
// ============================================================
app.get("/join-class/:token", (req, res) => {
  res.sendFile(path.join(__dirname, "join-class.html"));
});
app.get("/reset-password", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

app.use(cors());
app.use(express.json({ limit: "100mb" }));
app.use(express.static("public"));
app.use("/uploads", express.static("uploads"));

// ============================================================
// API-РОУТЫ
// ============================================================
app.use("/api", require("./src/routes/auth"));
app.use("/api", require("./src/routes/classes"));
app.use("/api", require("./src/routes/invites"));
app.use("/api", require("./src/routes/assignments"));
app.use("/api", require("./src/routes/boards"));
app.use("/api", require("./src/routes/submissions").router);
app.use("/api", require("./src/routes/comments"));

// ============================================================
// HTTP + WebSocket
// ============================================================
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

setupBoardSocket(wss);

// ============================================================
// ПОДКЛЮЧЕНИЕ К БД И ЗАПУСК
// ============================================================
pool.connect(async (err) => {
  if (err) {
    console.error("❌ Ошибка подключения к БД:", err.message);
    process.exit(1);
  } else {
    await initDatabase(); // <-- ЖДЁМ создания таблиц!
    server.listen(port, "0.0.0.0", () => {
      console.log(`🚀 Сервер запущен на http://localhost:${port}`);
    });
  }
});