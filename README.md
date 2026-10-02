# Образовательная платформа

Веб-приложение для школы: интерактивная доска с совместным рисованием (WebSocket),
классы, задания с автопроверкой, работы учеников с текстовыми, голосовыми и
графическими комментариями учителя.

Стек: **Node.js / Express, PostgreSQL, WebSocket (`ws`), plain HTML/CSS/JS**.

## Возможности

- Регистрация/вход учителей и учеников, сброс пароля по email (SMTP).
- Интерактивная доска: рисование, фигуры (планиметрия, 3D), текст, таблицы,
  совместное редактирование в реальном времени, личные / классные / общие доски.
- Классы и приглашения по ссылке.
- Задания: подзадания, картинки, подсказки, целевые ученики, автопроверка ответов.
- Работы учеников: файлы, аннотации на фото, текстовые и голосовые комментарии, оценки.

## Быстрый старт

Требуется Node.js 18+ и PostgreSQL.

```bash
# 1. Установить зависимости
npm install

# 2. Настроить окружение
cp .env.example .env
#   отредактируйте .env (БД, JWT_SECRET, SMTP)

# 3. Запустить
npm start
```

Схема БД создаётся автоматически при первом запуске (см. `schema.sql`).

Приложение: http://localhost:3000

> Приглашение в класс: `http://localhost:3000/join-class/<token>`

## Структура проекта

```
├── server.js                 # точка входа: Express + WebSocket + статика
├── schema.sql                # схема БД (применяется при запуске)
├── mailer.js                 # отправка писем (сброс пароля)
├── src/
│   ├── db.js                 # пул подключений + применение schema.sql
│   ├── middleware/
│   │   ├── auth.js           # JWT-авторизация, проверка роли
│   │   └── upload.js         # multer: файлы работ, аудио, файлы заданий
│   ├── routes/
│   │   ├── auth.js           # /api/register, /login, сброс пароля
│   │   ├── classes.js        # /api/classes
│   │   ├── invites.js        # /api/invite, /api/classes/:id/invite*
│   │   ├── assignments.js    # /api/assignments
│   │   ├── submissions.js    # /api/submissions (+ автопроверка)
│   │   ├── comments.js       # аннотации, голосовые и текстовые комментарии
│   │   └── boards.js         # /api/board, /api/class-board, /api/shared-board
│   └── ws/
│       └── boards.js         # WebSocket-комнаты досок
├── public/                   # статика
│   ├── index.html / join-class.html (корень проекта)
│   ├── app.js, style.css     # фронтенд (вынесены из index.html)
│   └── icons/                # иконки панели инструментов
└── uploads/                  # загруженные файлы (не в git)
```

## Скрипты

| Команда       | Описание                     |
|---------------|------------------------------|
| `npm start`   | Запуск в production          |
| `npm run dev` | Запуск с автоперезапуском (nodemon) |

## Переменные окружения

См. `.env.example`:

| Переменная | Описание |
|-----------|----------|
| `PORT` | Порт HTTP/WebSocket сервера |
| `DB_USER`, `DB_PASSWORD`, `DB_HOST`, `DB_PORT`, `DB_DATABASE` | PostgreSQL (или `DATABASE_URL`) |
| `JWT_SECRET` | Секрет подписи JWT (обязательно свой!) |
| `APP_URL` | Публичный адрес приложения |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS` | SMTP для писем |

## Заметки по безопасности

- `.env` и `uploads/` не коммитятся (см. `.gitignore`).
- JWT-токены живут 7 дней.
- Пароли хешируются bcrypt (10 раундов).