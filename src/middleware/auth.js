const jwt = require("jsonwebtoken");
require("dotenv").config();

function authenticateToken(req, res, next) {
  const authHeader = req.headers["authorization"];
  const token = authHeader && authHeader.split(" ")[1];
  if (!token) return res.status(401).json({ error: "Требуется авторизация" });
  jwt.verify(token, process.env.JWT_SECRET, (err, user) => {
    if (err) return res.status(403).json({ error: "Неверный токен" });
    req.user = user;
    next();
  });
}

function requireTeacher(req, res, next) {
  if (req.user.role !== "teacher") return res.status(403).json({ error: "Только для учителей" });
  next();
}

module.exports = { authenticateToken, requireTeacher };