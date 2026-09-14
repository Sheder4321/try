(async function main() {
    const express = require('express');
    const { Pool } = require('pg');
    const bcrypt = require('bcryptjs');
    const jwt = require('jsonwebtoken');
    const cors = require('cors');
    const multer = require('multer');
    const path = require('path');
    const fs = require('fs');
    const WebSocket = require('ws');
    const http = require('http');
    require('dotenv').config();
    const crypto = require('crypto');
    const { sendPasswordResetEmail } = require('./mailer');
    const app = express();
    const port = process.env.PORT || 3000;

    // ============================================================
    // СТРАНИЦА ПРИСОЕДИНЕНИЯ К КЛАССУ
    // ============================================================
    app.get('/join-class/:token', (req, res) => {
        // Отдаём страницу join-class.html
        res.sendFile(path.join(__dirname, 'join-class.html'));
    });
    app.get('/reset-password', (req, res) => {
        res.sendFile(path.join(__dirname, 'index.html'));
    });

    // Также обрабатываем корневой путь для статики
    app.get('/', (req, res) => {
        res.sendFile(path.join(__dirname, 'index.html'));
    });

    app.use(cors());
    app.use(express.json({ limit: '100mb' }));
    app.use(express.static('public'));
    app.use('/uploads', express.static('uploads'));

    // HTTP + WebSocket
    const server = http.createServer(app);
    const wss = new WebSocket.Server({ server });

    // ============================================================
    // WEBSOCKET
    // ============================================================
    const rooms = new Map();

    wss.on('connection', (ws, req) => {
        console.log('🔗 Новое WebSocket подключение');

        ws.on('message', (message) => {
            try {
                const data = JSON.parse(message);
                console.log('📨 Получено:', data.type);

                switch (data.type) {
                    case 'sync_request':
                        if (ws.roomId && rooms.has(ws.roomId)) {
                            const clients = rooms.get(ws.roomId);
                            clients.forEach(client => {
                                if (client !== ws && client.readyState === WebSocket.OPEN) {
                                    client.send(JSON.stringify({
                                        type: 'sync_request',
                                        userId: ws.userId
                                    }));
                                }
                            });
                        }
                        break;

                    case 'undo':
                    case 'redo':
                        if (ws.roomId && rooms.has(ws.roomId)) {
                            const clients = rooms.get(ws.roomId);
                            clients.forEach(client => {
                                if (client !== ws && client.readyState === WebSocket.OPEN) {
                                    client.send(JSON.stringify({
                                        type: data.type,
                                        data: data.data,
                                        userId: ws.userId,
                                        userName: ws.userName || 'Пользователь'
                                    }));
                                }
                            });
                            console.log(`${data.type === 'undo' ? '↩️ Отмена' : '↪️ Повтор'} отправлена в комнату ${ws.roomId}`);
                        }
                        break;

                    case 'join':
                        const roomId = data.roomId;
                        ws.roomId = roomId;
                        ws.userId = data.userId;
                        ws.role = data.role;

                        if (!rooms.has(roomId)) {
                            rooms.set(roomId, new Set());
                        }
                        rooms.get(roomId).add(ws);

                        console.log(`👤 Пользователь ${ws.userId} присоединился к комнате ${roomId}`);
                        console.log(`📊 В комнате ${roomId} сейчас ${rooms.get(roomId).size} пользователей`);
                        break;

                    case 'draw':
                        if (ws.roomId && rooms.has(ws.roomId)) {
                            const clients = rooms.get(ws.roomId);
                            clients.forEach(client => {
                                if (client !== ws && client.readyState === WebSocket.OPEN) {
                                    client.send(JSON.stringify({
                                        type: 'draw',
                                        data: data.data,
                                        userId: ws.userId
                                    }));
                                }
                            });
                        }
                        break;

                    case 'clear':
                        if (ws.roomId && rooms.has(ws.roomId)) {
                            const clients = rooms.get(ws.roomId);
                            clients.forEach(client => {
                                if (client !== ws && client.readyState === WebSocket.OPEN) {
                                    client.send(JSON.stringify({ type: 'clear' }));
                                }
                            });
                        }
                        break;

                    case 'sync':
                        if (ws.roomId && rooms.has(ws.roomId)) {
                            const clients = rooms.get(ws.roomId);
                            clients.forEach(client => {
                                if (client !== ws && client.readyState === WebSocket.OPEN) {
                                    client.send(JSON.stringify({
                                        type: 'sync',
                                        data: data.data
                                    }));
                                }
                            });
                        }
                        break;

                    case 'leave':
                        if (ws.roomId && rooms.has(ws.roomId)) {
                            rooms.get(ws.roomId).delete(ws);
                            if (rooms.get(ws.roomId).size === 0) {
                                rooms.delete(ws.roomId);
                            }
                        }
                        console.log(`👤 Пользователь ${ws.userId} покинул комнату`);
                        break;
                }
            } catch (error) {
                console.error('❌ Ошибка WebSocket:', error);
            }
        });

        ws.on('close', () => {
            if (ws.roomId && rooms.has(ws.roomId)) {
                rooms.get(ws.roomId).delete(ws);
                if (rooms.get(ws.roomId).size === 0) {
                    rooms.delete(ws.roomId);
                }
            }
            console.log('🔌 WebSocket отключён');
        });
    });

    // ============================================================
    // НАСТРОЙКА MULTER
    // ============================================================
    const storage = multer.diskStorage({
        destination: function (req, file, cb) {
            const uploadPath = 'uploads/submissions/';
            if (!fs.existsSync(uploadPath)) {
                fs.mkdirSync(uploadPath, { recursive: true });
            }
            cb(null, uploadPath);
        },
        filename: function (req, file, cb) {
            const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
            const ext = path.extname(file.originalname) || '.jpg';
            cb(null, uniqueSuffix + ext);
        }
    });

    const upload = multer({
        storage: storage,
        limits: { fileSize: 20 * 1024 * 1024 }
    });

    // ============================================================
    // ПОДКЛЮЧЕНИЕ К БД
    // ============================================================
    const pool = new Pool(
        process.env.DATABASE_URL
            ? {
                connectionString: process.env.DATABASE_URL,
                ssl: process.env.DATABASE_URL.includes('localhost') 
                    ? false 
                    : { rejectUnauthorized: false }
              }
            : {
                user: process.env.DB_USER,
                password: process.env.DB_PASSWORD,
                host: process.env.DB_HOST,
                port: process.env.DB_PORT,
                database: process.env.DB_DATABASE,
              }
    );

    pool.connect((err) => {
        if (err) {
            console.error('❌ Ошибка подключения к БД:', err.message);
        } else {
            console.log('✅ Подключено к PostgreSQL');
            initDatabase();
        }
    });

    async function initDatabase() {
        try {
            // Сначала проверяем, существует ли таблица class_invites
            const tableCheck = await pool.query(`
                SELECT EXISTS (
                    SELECT FROM information_schema.tables 
                    WHERE table_name = 'class_invites'
                );
            `);
            
            // Создаём таблицу annotation_comments
            await pool.query(`
                CREATE TABLE IF NOT EXISTS annotation_comments (
                    id SERIAL PRIMARY KEY,
                    submission_id INTEGER REFERENCES submissions(id) ON DELETE CASCADE,
                    teacher_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
                    x INTEGER NOT NULL,
                    y INTEGER NOT NULL,
                    width INTEGER,
                    height INTEGER,
                    comment TEXT NOT NULL,
                    color VARCHAR(20) DEFAULT '#ff3b30',
                    subtask_index INTEGER DEFAULT 0,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                )
            `);
            await pool.query(`
                CREATE TABLE IF NOT EXISTS voice_comments (
                    id SERIAL PRIMARY KEY,
                    submission_id INTEGER REFERENCES submissions(id) ON DELETE CASCADE,
                    teacher_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
                    subtask_index INTEGER DEFAULT 0,
                    audio_path VARCHAR(500) NOT NULL,
                    duration INTEGER DEFAULT 0,
                    selected_text TEXT,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                )
            `);
            
            // ===== НОВАЯ ТАБЛИЦА ДЛЯ ТЕКСТОВЫХ КОММЕНТАРИЕВ =====
            await pool.query(`
                CREATE TABLE IF NOT EXISTS text_comments (
                    id SERIAL PRIMARY KEY,
                    submission_id INTEGER REFERENCES submissions(id) ON DELETE CASCADE,
                    teacher_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
                    subtask_index INTEGER DEFAULT 0,
                    selected_text TEXT NOT NULL,
                    comment TEXT NOT NULL,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                )
            `);
            console.log('✅ Таблица text_comments создана/обновлена');
            
            // Если таблица class_invites существует, проверяем наличие колонки token
            if (tableCheck.rows[0].exists) {
                const columnCheck = await pool.query(`
                    SELECT EXISTS (
                        SELECT FROM information_schema.columns 
                        WHERE table_name = 'class_invites' AND column_name = 'token'
                    );
                `);
                
                if (!columnCheck.rows[0].exists) {
                    await pool.query(`
                        ALTER TABLE class_invites 
                        ADD COLUMN token VARCHAR(100) UNIQUE NOT NULL DEFAULT 'invite_' || gen_random_uuid()
                    `);
                    console.log('✅ Колонка token добавлена в class_invites');
                }
            }
            
            // Создаём все остальные таблицы
                        await pool.query(`
                CREATE TABLE IF NOT EXISTS users (
                    id SERIAL PRIMARY KEY,
                    username VARCHAR(50) UNIQUE NOT NULL,
                    password_hash VARCHAR(255) NOT NULL,
                    role VARCHAR(20) DEFAULT 'student',
                    full_name VARCHAR(100),
                    email VARCHAR(100) UNIQUE,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                )
            `);

            // Добавляем UNIQUE на email, если ещё нет
            try {
                await pool.query(`ALTER TABLE users ADD CONSTRAINT users_email_unique UNIQUE (email)`);
            } catch (e) {
                // уже существует — игнорируем
            }

            // Таблица токенов сброса пароля
            await pool.query(`
                CREATE TABLE IF NOT EXISTS password_reset_tokens (
                    id SERIAL PRIMARY KEY,
                    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                    token_hash VARCHAR(128) NOT NULL,
                    expires_at TIMESTAMP NOT NULL,
                    used_at TIMESTAMP,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                )
            `);
            console.log('✅ Таблица password_reset_tokens создана');
            await pool.query(`
                CREATE TABLE IF NOT EXISTS classes (
                    id SERIAL PRIMARY KEY,
                    teacher_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
                    name VARCHAR(100) NOT NULL,
                    description TEXT,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                )
            `);
            await pool.query(`
                CREATE TABLE IF NOT EXISTS class_students (
                    class_id INTEGER REFERENCES classes(id) ON DELETE CASCADE,
                    student_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
                    joined_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    PRIMARY KEY (class_id, student_id)
                )
            `);
            await pool.query(`
                CREATE TABLE IF NOT EXISTS boards (
                    id SERIAL PRIMARY KEY,
                    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
                    board_data JSONB NOT NULL,
                    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    UNIQUE(user_id)
                )
            `);
            await pool.query(`
                CREATE TABLE IF NOT EXISTS shared_boards (
                    id SERIAL PRIMARY KEY,
                    teacher_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
                    student_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
                    class_id INTEGER REFERENCES classes(id) ON DELETE CASCADE,
                    board_data JSONB NOT NULL,
                    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    UNIQUE(teacher_id, student_id, class_id)
                )
            `);
            await pool.query(`
                CREATE TABLE IF NOT EXISTS class_boards (
                    id SERIAL PRIMARY KEY,
                    class_id INTEGER REFERENCES classes(id) ON DELETE CASCADE,
                    board_data JSONB NOT NULL,
                    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    UNIQUE(class_id)
                )
            `);
            await pool.query(`
                CREATE TABLE IF NOT EXISTS assignments (
                    id SERIAL PRIMARY KEY,
                    class_id INTEGER REFERENCES classes(id) ON DELETE CASCADE,
                    teacher_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
                    title VARCHAR(200) NOT NULL,
                    description TEXT,
                    content JSONB,
                    files JSONB,
                    due_date TIMESTAMP,
                    max_score DECIMAL(5,2) DEFAULT 100,
                    auto_check BOOLEAN DEFAULT FALSE,
                    answers JSONB,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                )
            `);
            await pool.query(`
                CREATE TABLE IF NOT EXISTS submissions (
                    id SERIAL PRIMARY KEY,
                    assignment_id INTEGER REFERENCES assignments(id) ON DELETE CASCADE,
                    student_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
                    content TEXT,
                    status VARCHAR(20) DEFAULT 'pending',
                    score DECIMAL(5,2),
                    teacher_comment TEXT,
                    submitted_at TIMESTAMP,
                    graded_at TIMESTAMP,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    UNIQUE(assignment_id, student_id)
                )
            `);
            await pool.query(`
                CREATE TABLE IF NOT EXISTS submission_files (
                    id SERIAL PRIMARY KEY,
                    submission_id INTEGER REFERENCES submissions(id) ON DELETE CASCADE,
                    file_name VARCHAR(255) NOT NULL,
                    file_path VARCHAR(500) NOT NULL,
                    file_type VARCHAR(50),
                    file_size INTEGER,
                    uploaded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                )
            `);
            await pool.query(`
                CREATE TABLE IF NOT EXISTS class_invites (
                    id SERIAL PRIMARY KEY,
                    class_id INTEGER REFERENCES classes(id) ON DELETE CASCADE,
                    token VARCHAR(100) UNIQUE NOT NULL,
                    created_by INTEGER REFERENCES users(id) ON DELETE CASCADE,
                    max_uses INTEGER DEFAULT 1,
                    used_count INTEGER DEFAULT 0,
                    expires_at TIMESTAMP,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    is_active BOOLEAN DEFAULT TRUE
                )
            `);
            
            console.log('✅ Все таблицы созданы/обновлены');
        } catch (error) {
            console.error('❌ Ошибка создания таблиц:', error.message);
        }
    }

    const authenticateToken = (req, res, next) => {
        const authHeader = req.headers['authorization'];
        const token = authHeader && authHeader.split(' ')[1];
        if (!token) return res.status(401).json({ error: 'Требуется авторизация' });
        jwt.verify(token, process.env.JWT_SECRET, (err, user) => {
            if (err) return res.status(403).json({ error: 'Неверный токен' });
            req.user = user;
            next();
        });
    };

    // ============================================================
    // АВТОРИЗАЦИЯ
    // ============================================================
        app.post('/api/register', async (req, res) => {
        const { username, password, role = 'student', fullName, email } = req.body;

        if (!username || !password) {
            return res.status(400).json({ error: 'Логин и пароль обязательны' });
        }
        if (!email || !email.includes('@')) {
            return res.status(400).json({ error: 'Укажите корректный email' });
        }
        if (password.length < 6) {
            return res.status(400).json({ error: 'Пароль должен быть не менее 6 символов' });
        }

        try {
            const hashedPassword = await bcrypt.hash(password, 10);
            const result = await pool.query(
                'INSERT INTO users (username, password_hash, role, full_name, email) VALUES ($1, $2, $3, $4, $5) RETURNING id, username, role',
                [username, hashedPassword, role, fullName || username, email.toLowerCase().trim()]
            );
            const user = result.rows[0];
            await pool.query(
                'INSERT INTO boards (user_id, board_data) VALUES ($1, $2)',
                [user.id, JSON.stringify({ objects: [] })]
            );
            const token = jwt.sign({ id: user.id, username: user.username, role: user.role }, process.env.JWT_SECRET, { expiresIn: '7d' });
            res.json({ token, user: { id: user.id, username: user.username, role: user.role } });
        } catch (error) {
            if (error.code === '23505') {
                if (error.constraint && error.constraint.includes('email')) {
                    return res.status(400).json({ error: 'Этот email уже зарегистрирован' });
                }
                return res.status(400).json({ error: 'Пользователь с таким логином уже существует' });
            }
            console.error(error);
            res.status(500).json({ error: 'Ошибка сервера' });
        }
    });

    app.post('/api/login', async (req, res) => {
        const { username, password } = req.body;
        if (!username || !password) return res.status(400).json({ error: 'Все поля обязательны' });
        try {
            const result = await pool.query('SELECT * FROM users WHERE username = $1', [username]);
            const user = result.rows[0];
            if (!user) return res.status(401).json({ error: 'Неверные учетные данные' });
            const isValid = await bcrypt.compare(password, user.password_hash);
            if (!isValid) return res.status(401).json({ error: 'Неверные учетные данные' });
            const token = jwt.sign({ id: user.id, username: user.username, role: user.role }, process.env.JWT_SECRET, { expiresIn: '7d' });
            res.json({ token, user: { id: user.id, username: user.username, role: user.role, fullName: user.full_name } });
        } catch (error) {
            console.error(error);
            res.status(500).json({ error: 'Ошибка сервера' });
        }
    });
        // ============================================================
    // СБРОС ПАРОЛЯ
    // ============================================================

    app.post('/api/forgot-password', async (req, res) => {
        const { email } = req.body;
        const genericResponse = { message: 'Если такой email зарегистрирован, письмо отправлено' };

        if (!email || !email.includes('@')) {
            return res.json(genericResponse);
        }

        try {
            const userResult = await pool.query(
                'SELECT id, username FROM users WHERE email = $1',
                [email.toLowerCase().trim()]
            );

            if (userResult.rows.length === 0) {
                return res.json(genericResponse);
            }

            const userId = userResult.rows[0].id;

            await pool.query('DELETE FROM password_reset_tokens WHERE user_id = $1', [userId]);

            const rawToken = crypto.randomBytes(32).toString('hex');
            const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
            const expiresAt = new Date(Date.now() + 60 * 60 * 1000);

            await pool.query(
                `INSERT INTO password_reset_tokens (user_id, token_hash, expires_at) VALUES ($1, $2, $3)`,
                [userId, tokenHash, expiresAt]
            );

            await sendPasswordResetEmail(email, rawToken);

            res.json(genericResponse);
        } catch (error) {
            console.error('❌ Ошибка forgot-password:', error);
            res.json(genericResponse);
        }
    });

    app.post('/api/reset-password', async (req, res) => {
        const { token, newPassword } = req.body;

        if (!token || !newPassword) {
            return res.status(400).json({ error: 'Недостаточно данных' });
        }
        if (newPassword.length < 6) {
            return res.status(400).json({ error: 'Пароль должен быть не менее 6 символов' });
        }

        try {
            const tokenHash = crypto.createHash('sha256').update(token).digest('hex');

            const result = await pool.query(
                `SELECT id, user_id FROM password_reset_tokens 
                 WHERE token_hash = $1 AND expires_at > NOW() AND used_at IS NULL`,
                [tokenHash]
            );

            if (result.rows.length === 0) {
                return res.status(400).json({ error: 'Ссылка недействительна или истекла' });
            }

            const tokenRecord = result.rows[0];
            const passwordHash = await bcrypt.hash(newPassword, 10);

            const client = await pool.connect();
            try {
                await client.query('BEGIN');
                await client.query('UPDATE users SET password_hash = $1 WHERE id = $2', [passwordHash, tokenRecord.user_id]);
                await client.query('UPDATE password_reset_tokens SET used_at = NOW() WHERE id = $1', [tokenRecord.id]);
                await client.query('COMMIT');
            } catch (e) {
                await client.query('ROLLBACK');
                throw e;
            } finally {
                client.release();
            }

            res.json({ message: 'Пароль успешно изменён' });
        } catch (error) {
            console.error('❌ Ошибка reset-password:', error);
            res.status(500).json({ error: 'Ошибка сервера' });
        }
    });

    app.get('/api/reset-password/check', async (req, res) => {
        const { token } = req.query;
        if (!token) return res.json({ valid: false });

        try {
            const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
            const result = await pool.query(
                `SELECT id FROM password_reset_tokens 
                 WHERE token_hash = $1 AND expires_at > NOW() AND used_at IS NULL`,
                [tokenHash]
            );
            res.json({ valid: result.rows.length > 0 });
        } catch (error) {
            res.json({ valid: false });
        }
    });

    // ============================================================
    // КЛАССЫ
    // ============================================================
    app.post('/api/classes', authenticateToken, async (req, res) => {
        if (req.user.role !== 'teacher') return res.status(403).json({ error: 'Только для учителей' });
        const { name, description } = req.body;
        try {
            // ✅ ПРАВИЛЬНО: БЕЗ invite_code
            const result = await pool.query(
                'INSERT INTO classes (teacher_id, name, description) VALUES ($1, $2, $3) RETURNING *',
                [req.user.id, name, description]
            );
            res.json(result.rows[0]);
        } catch (error) {
            console.error('❌ Ошибка создания класса:', error);
            res.status(500).json({ error: 'Ошибка создания класса: ' + error.message });
        }
    });

        // ПОЛУЧЕНИЕ ВСЕХ ДАННЫХ ПО РАБОТЕ (ОДНИМ ЗАПРОСОМ)
        // ============================================================
        app.get('/api/submissions/:submissionId/full', authenticateToken, async (req, res) => {
            const { submissionId } = req.params;
            
            try {
                // 1. Получаем работу
                const subResult = await pool.query(`
                    SELECT 
                        s.*,
                        u.username,
                        u.full_name
                    FROM submissions s
                    JOIN users u ON s.student_id = u.id
                    WHERE s.id = $1
                `, [submissionId]);
                
                if (subResult.rows.length === 0) {
                    return res.status(404).json({ error: 'Работа не найдена' });
                }
                
                const submission = subResult.rows[0];
                
                // Проверяем доступ
                let hasAccess = false;
                
                if (req.user.role === 'teacher') {
                    const check = await pool.query(
                        'SELECT teacher_id FROM assignments WHERE id = $1',
                        [submission.assignment_id]
                    );
                    if (check.rows.length > 0 && check.rows[0].teacher_id === req.user.id) {
                        hasAccess = true;
                    }
                } else if (req.user.role === 'student') {
                    if (submission.student_id === req.user.id) {
                        hasAccess = true;
                    }
                }
                
                if (!hasAccess) {
                    return res.status(403).json({ error: 'Нет доступа к этой работе' });
                }
                
                // 2. Получаем файлы
                const filesResult = await pool.query(
                    'SELECT * FROM submission_files WHERE submission_id = $1 ORDER BY uploaded_at',
                    [submissionId]
                );
                submission.files = filesResult.rows || [];
                
                // 3. Получаем аннотации на фото
                const annotationsResult = await pool.query(
                    'SELECT * FROM annotation_comments WHERE submission_id = $1 ORDER BY created_at',
                    [submissionId]
                );
                submission.annotations = annotationsResult.rows || [];
                
                // 4. Получаем текстовые комментарии
                const textCommentsResult = await pool.query(
                    'SELECT * FROM text_comments WHERE submission_id = $1 ORDER BY created_at',
                    [submissionId]
                );
                submission.textComments = textCommentsResult.rows || [];
                
                // 5. Получаем голосовые комментарии
                const voiceCommentsResult = await pool.query(
                    `SELECT v.*, u.full_name as teacher_name 
                    FROM voice_comments v
                    JOIN users u ON v.teacher_id = u.id
                    WHERE v.submission_id = $1
                    ORDER BY v.created_at ASC`,
                    [submissionId]
                );
                submission.voiceComments = voiceCommentsResult.rows || [];
                
                // 6. Получаем задание (для контекста)
                const assignmentResult = await pool.query(`
                    SELECT a.*, u.username as teacher_name
                    FROM assignments a
                    JOIN users u ON a.teacher_id = u.id
                    WHERE a.id = $1
                `, [submission.assignment_id]);
                submission.assignment = assignmentResult.rows[0] || null;
                
                // Логируем для отладки
                console.log('📥 Загружены данные для submission:', {
                    id: submission.id,
                    textComments: submission.textComments?.length || 0,
                    annotations: submission.annotations?.length || 0,
                    voiceComments: submission.voiceComments?.length || 0,
                    files: submission.files?.length || 0
                });
                
                res.json(submission);
                
            } catch (error) {
                console.error('❌ Ошибка получения полных данных:', error);
                res.status(500).json({ error: 'Ошибка получения данных: ' + error.message });
            }
        });

    app.get('/api/classes/my', authenticateToken, async (req, res) => {
        try {
            let query, params;
            if (req.user.role === 'teacher') {
                query = `
                    SELECT c.*, 
                        COUNT(DISTINCT cs.student_id) as student_count,
                        u.username as teacher_name
                    FROM classes c
                    LEFT JOIN class_students cs ON c.id = cs.class_id
                    JOIN users u ON c.teacher_id = u.id
                    WHERE c.teacher_id = $1
                    GROUP BY c.id, u.username
                    ORDER BY c.created_at DESC
                `;
                params = [req.user.id];
            } else {
                // Для ученика — тоже считаем учеников в классе
                query = `
                    SELECT c.*, 
                        COUNT(DISTINCT cs2.student_id) as student_count,
                        u.username as teacher_name
                    FROM classes c
                    JOIN class_students cs ON c.id = cs.class_id AND cs.student_id = $1
                    LEFT JOIN class_students cs2 ON c.id = cs2.class_id
                    JOIN users u ON c.teacher_id = u.id
                    WHERE cs.student_id = $1
                    GROUP BY c.id, u.username
                    ORDER BY c.created_at DESC
                `;
                params = [req.user.id];
            }
            const result = await pool.query(query, params);
            res.json(result.rows);
        } catch (error) {
            console.error('❌ Ошибка получения классов:', error);
            res.status(500).json({ error: 'Ошибка получения классов' });
        }
    });

    app.get('/api/classes/:classId/students', authenticateToken, async (req, res) => {
        const { classId } = req.params;
        try {
            const result = await pool.query(`
                SELECT u.id, u.username, u.full_name
                FROM users u
                JOIN class_students cs ON u.id = cs.student_id
                WHERE cs.class_id = $1
                ORDER BY u.username
            `, [classId]);
            res.json(result.rows);
        } catch (error) {
            console.error(error);
            res.status(500).json({ error: 'Ошибка получения учеников' });
        }
    });

    // ============================================================
    // НАСТРОЙКА MULTER ДЛЯ АУДИО
    // ============================================================
    const audioStorage = multer.diskStorage({
        destination: function (req, file, cb) {
            const uploadPath = 'uploads/audio/';
            if (!fs.existsSync(uploadPath)) {
                fs.mkdirSync(uploadPath, { recursive: true });
            }
            cb(null, uploadPath);
        },
        filename: function (req, file, cb) {
            const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
            cb(null, 'voice_' + uniqueSuffix + '.webm');
        }
    });

    const audioUpload = multer({
        storage: audioStorage,
        limits: { fileSize: 10 * 1024 * 1024 } // 10MB
    });

    // ============================================================
    // НОВАЯ ТАБЛИЦА ДЛЯ ГОЛОСОВЫХ КОММЕНТАРИЕВ
    // ============================================================
    // Добавьте это в initDatabase():

    await pool.query(`
        CREATE TABLE IF NOT EXISTS voice_comments (
            id SERIAL PRIMARY KEY,
            submission_id INTEGER REFERENCES submissions(id) ON DELETE CASCADE,
            teacher_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
            subtask_index INTEGER DEFAULT 0,
            audio_path VARCHAR(500) NOT NULL,
            duration INTEGER DEFAULT 0,
            transcript TEXT,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    `);
    console.log('✅ Таблица voice_comments создана');

    // ============================================================
    // ЭНДПОИНТ ДЛЯ СОХРАНЕНИЯ ГОЛОСОВОГО КОММЕНТАРИЯ
    // ============================================================
    app.post('/api/voice-comments', authenticateToken, audioUpload.single('audio'), async (req, res) => {
        if (req.user.role !== 'teacher') {
            return res.status(403).json({ error: 'Только для учителей' });
        }
        
        const { submissionId, subtaskIndex, duration, selectedText } = req.body;
        
        if (!submissionId || !req.file) {
            return res.status(400).json({ error: 'Недостаточно данных' });
        }
        
        try {
            // ===== ИСПРАВЛЯЕМ ПУТЬ =====
            // Убираем "uploads/" из пути, если она уже есть
            let audioPath = req.file.path.replace(/\\/g, '/');
            // Если путь начинается с "uploads/", оставляем как есть
            // Если нет - добавляем
            if (!audioPath.startsWith('uploads/')) {
                audioPath = 'uploads/' + audioPath;
            }
            
            const result = await pool.query(
                `INSERT INTO voice_comments (submission_id, teacher_id, subtask_index, audio_path, duration, selected_text, created_at)
                VALUES ($1, $2, $3, $4, $5, $6, CURRENT_TIMESTAMP)
                RETURNING id, audio_path, duration, selected_text, created_at`,
                [submissionId, req.user.id, subtaskIndex || 0, audioPath, duration || 0, selectedText || null]
            );
            
            res.json(result.rows[0]);
        } catch (error) {
            console.error('❌ Ошибка сохранения голосового комментария:', error);
            res.status(500).json({ error: 'Ошибка сохранения: ' + error.message });
        }
    });
    // ============================================================
    // ПОЛУЧЕНИЕ ГОЛОСОВЫХ КОММЕНТАРИЕВ
    // ============================================================
    app.get('/api/voice-comments/:submissionId', authenticateToken, async (req, res) => {
        const { submissionId } = req.params;
        
        try {
            // Проверка доступа
            let hasAccess = false;
            if (req.user.role === 'teacher') {
                const check = await pool.query(`
                    SELECT a.teacher_id 
                    FROM submissions s
                    JOIN assignments a ON s.assignment_id = a.id
                    WHERE s.id = $1
                `, [submissionId]);
                if (check.rows.length > 0 && check.rows[0].teacher_id === req.user.id) {
                    hasAccess = true;
                }
            } else if (req.user.role === 'student') {
                const check = await pool.query(
                    'SELECT student_id FROM submissions WHERE id = $1',
                    [submissionId]
                );
                if (check.rows.length > 0 && check.rows[0].student_id === req.user.id) {
                    hasAccess = true;
                }
            }
            
            if (!hasAccess) {
                return res.status(403).json({ error: 'Нет доступа' });
            }
            
            const result = await pool.query(
                `SELECT v.*, u.full_name as teacher_name 
                FROM voice_comments v
                JOIN users u ON v.teacher_id = u.id
                WHERE v.submission_id = $1
                ORDER BY v.created_at ASC`,
                [submissionId]
            );
            
            // ===== ИСПРАВЛЯЕМ ПУТЬ ПРИ ВЫДАЧЕ =====
            const comments = result.rows.map(c => {
                let path = c.audio_path || '';
                // Убираем дублирование
                path = path.replace(/\\/g, '/');
                path = path.replace(/uploadsaudio/g, 'uploads/audio/');
                path = path.replace(/\/\/+/g, '/');
                
                return {
                    ...c,
                    audio_path: path,
                    audio_url: path ? `/${path}` : null
                };
            });
            
            res.json(comments);
        } catch (error) {
            console.error('❌ Ошибка получения голосовых комментариев:', error);
            res.status(500).json({ error: 'Ошибка получения: ' + error.message });
        }
    });

    // ============================================================
    // УДАЛЕНИЕ ГОЛОСОВОГО КОММЕНТАРИЯ
    // ============================================================
    app.delete('/api/voice-comments/:id', authenticateToken, async (req, res) => {
        if (req.user.role !== 'teacher') {
            return res.status(403).json({ error: 'Только для учителей' });
        }
        
        const { id } = req.params;
        
        try {
            // Получаем путь к файлу
            const fileResult = await pool.query(
                'SELECT audio_path FROM voice_comments WHERE id = $1 AND teacher_id = $2',
                [id, req.user.id]
            );
            
            if (fileResult.rows.length === 0) {
                return res.status(404).json({ error: 'Комментарий не найден' });
            }
            
            // Удаляем файл
            const filePath = fileResult.rows[0].audio_path;
            if (filePath && fs.existsSync(filePath)) {
                fs.unlinkSync(filePath);
            }
            
            // Удаляем запись
            await pool.query(
                'DELETE FROM voice_comments WHERE id = $1',
                [id]
            );
            
            res.json({ success: true });
        } catch (error) {
            console.error('❌ Ошибка удаления голосового комментария:', error);
            res.status(500).json({ error: 'Ошибка удаления: ' + error.message });
        }
    });

    // ============================================================
    // ЗАДАНИЯ
    // ============================================================
    const assignmentStorage = multer.diskStorage({
        destination: function (req, file, cb) {
            const uploadPath = 'uploads/assignments/';
            if (!fs.existsSync(uploadPath)) {
                fs.mkdirSync(uploadPath, { recursive: true });
            }
            cb(null, uploadPath);
        },
        filename: function (req, file, cb) {
            const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
            cb(null, 'q-' + uniqueSuffix + path.extname(file.originalname));
        }
    });

    const assignmentUpload = multer({
        storage: assignmentStorage,
        limits: { fileSize: 20 * 1024 * 1024 }
    });

    app.post('/api/assignments', authenticateToken, assignmentUpload.any(), async (req, res) => {
        if (req.user.role !== 'teacher') {
            return res.status(403).json({ error: 'Только для учителей' });
        }

        const { classId, title, description, autoCheck, maxScore, dueDate, items, assignmentHint } = req.body;

        if (!classId || !title) {
            return res.status(400).json({ error: 'Необходимо указать класс и название' });
        }

        let parsedItems = [];
        try {
            parsedItems = items ? JSON.parse(items) : [];
        } catch (e) {
            return res.status(400).json({ error: 'Некорректный формат вопросов' });
        }

        if (!parsedItems.length) {
            return res.status(400).json({ error: 'Добавьте хотя бы один вопрос' });
        }

        const uploadedFiles = req.files || [];
        
        const itemsWithData = parsedItems.map((item, index) => {
            const questionFile = uploadedFiles.find(f => f.fieldname === `image_${index}`);
            if (questionFile) {
                item.image = questionFile.path;
            }
            
            const hintFile = uploadedFiles.find(f => f.fieldname === `hint_image_${index}`);
            if (hintFile) {
                item.teacherHint = {
                    text: item.teacherHint?.text || '',
                    image: hintFile.path
                };
            } else if (item.teacherHint?.text) {
                item.teacherHint = {
                    text: item.teacherHint.text,
                    image: null
                };
            }
            
            item.autoCheck = item.autoCheck === true;
            return item;
        });

        let assignmentHintData = null;
        if (assignmentHint) {
            try {
                assignmentHintData = JSON.parse(assignmentHint);
                const hintImageFile = uploadedFiles.find(f => f.fieldname === 'assignment_hint_image');
                if (hintImageFile) {
                    assignmentHintData.image = hintImageFile.path;
                }
            } catch (e) {
                console.error('Ошибка парсинга assignmentHint:', e);
            }
        }

        try {
            const result = await pool.query(
                `INSERT INTO assignments 
                (class_id, teacher_id, title, description, content, due_date, max_score, auto_check) 
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8) 
                RETURNING *`,
                [
                    classId,
                    req.user.id,
                    title,
                    description || '',
                    JSON.stringify({ 
                        items: itemsWithData,
                        assignmentHint: assignmentHintData
                    }),
                    dueDate || null,
                    maxScore || 100,
                    false
                ]
            );
            res.json(result.rows[0]);
        } catch (error) {
            console.error(error);
            res.status(500).json({ error: 'Ошибка создания задания: ' + error.message });
        }
    });

    app.get('/api/assignments/class/:classId', authenticateToken, async (req, res) => {
        const { classId } = req.params;
        try {
            const result = await pool.query(`
                SELECT a.*, u.username as teacher_name
                FROM assignments a
                JOIN users u ON a.teacher_id = u.id
                WHERE a.class_id = $1
                ORDER BY a.created_at DESC
            `, [classId]);

            const studentsCountResult = await pool.query(
                'SELECT COUNT(*) as count FROM class_students WHERE class_id = $1',
                [classId]
            );
            const totalStudents = parseInt(studentsCountResult.rows[0]?.count || 0);

            for (const assignment of result.rows) {
                const submittedResult = await pool.query(
                    `SELECT COUNT(*) as count FROM submissions 
                    WHERE assignment_id = $1 AND status IN ('submitted', 'graded')`,
                    [assignment.id]
                );
                const submittedCount = parseInt(submittedResult.rows[0]?.count || 0);

                const gradedResult = await pool.query(
                    `SELECT COUNT(*) as count FROM submissions 
                    WHERE assignment_id = $1 AND status = 'graded'`,
                    [assignment.id]
                );
                const gradedCount = parseInt(gradedResult.rows[0]?.count || 0);

                assignment._stats = {
                    totalStudents: totalStudents,
                    submitted: submittedCount,
                    graded: gradedCount,
                    pending: totalStudents - submittedCount
                };

                if (req.user.role === 'student') {
                    const submissionResult = await pool.query(
                        `SELECT id, status, score, teacher_comment, submitted_at, content 
                        FROM submissions 
                        WHERE assignment_id = $1 AND student_id = $2`,
                        [assignment.id, req.user.id]
                    );
                    
                    if (submissionResult.rows.length > 0) {
                        const sub = submissionResult.rows[0];
                        if (sub.content) {
                            try {
                                sub.answers = typeof sub.content === 'string' ? JSON.parse(sub.content) : sub.content;
                            } catch(e) {
                                sub.answers = [];
                            }
                        }
                        assignment.submission = sub;
                    } else {
                        assignment.submission = { status: 'pending' };
                    }
                }
            }

            res.json(result.rows);
        } catch (error) {
            console.error('Ошибка получения заданий:', error);
            res.status(500).json({ error: 'Ошибка получения заданий' });
        }
    });

    // Получение информации о классе (для учеников)
    app.get('/api/classes/:classId', authenticateToken, async (req, res) => {
        const { classId } = req.params;
        try {
            let hasAccess = false;
            if (req.user.role === 'teacher') {
                const check = await pool.query(
                    'SELECT id FROM classes WHERE id = $1 AND teacher_id = $2',
                    [classId, req.user.id]
                );
                if (check.rows.length > 0) hasAccess = true;
            } else if (req.user.role === 'student') {
                const check = await pool.query(
                    'SELECT class_id FROM class_students WHERE class_id = $1 AND student_id = $2',
                    [classId, req.user.id]
                );
                if (check.rows.length > 0) hasAccess = true;
            }
            
            if (!hasAccess) {
                return res.status(403).json({ error: 'Нет доступа' });
            }
            
            const result = await pool.query(
                'SELECT * FROM classes WHERE id = $1',
                [classId]
            );
            
            if (result.rows.length === 0) {
                return res.status(404).json({ error: 'Класс не найден' });
            }
            
            res.json(result.rows[0]);
        } catch (error) {
            console.error(error);
            res.status(500).json({ error: 'Ошибка получения класса' });
        }
    });

    app.get('/api/assignments/:id', authenticateToken, async (req, res) => {
        const { id } = req.params;
        try {
            const result = await pool.query(`
                SELECT a.*, u.username as teacher_name
                FROM assignments a
                JOIN users u ON a.teacher_id = u.id
                WHERE a.id = $1
            `, [id]);
            
            if (result.rows.length === 0) {
                return res.status(404).json({ error: 'Задание не найдено' });
            }
            
            const assignment = result.rows[0];
            
            const countResult = await pool.query(
                'SELECT COUNT(*) as count FROM submissions WHERE assignment_id = $1',
                [id]
            );
            assignment.submissions_count = parseInt(countResult.rows[0]?.count || 0);
            
            if (req.user.role === 'student') {
                const submissionResult = await pool.query(`
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
                `, [id, req.user.id]);
                
                assignment.submission = submissionResult.rows[0] || null;
                
                if (assignment.submission) {
                    if (assignment.submission.content) {
                        try {
                            assignment.submission.answers = typeof assignment.submission.content === 'string' 
                                ? JSON.parse(assignment.submission.content) 
                                : assignment.submission.content;
                        } catch(e) {
                            assignment.submission.answers = [];
                        }
                    }
                }
            }
            
            res.json(assignment);
        } catch (error) {
            console.error('❌ Ошибка получения задания:', error);
            res.status(500).json({ error: 'Ошибка получения задания: ' + error.message });
        }
    });

    app.post('/api/submissions', authenticateToken, async (req, res) => {
        const { assignmentId, content } = req.body;
        try {
            const existing = await pool.query(
                'SELECT id FROM submissions WHERE assignment_id = $1 AND student_id = $2',
                [assignmentId, req.user.id]
            );

            let submissionId;
            if (existing.rows.length > 0) {
                const result = await pool.query(
                    `UPDATE submissions 
                    SET content = $1, status = 'submitted', submitted_at = CURRENT_TIMESTAMP
                    WHERE assignment_id = $2 AND student_id = $3
                    RETURNING id`,
                    [content, assignmentId, req.user.id]
                );
                submissionId = result.rows[0].id;
            } else {
                const result = await pool.query(
                    `INSERT INTO submissions (assignment_id, student_id, content, status, submitted_at) 
                    VALUES ($1, $2, $3, 'submitted', CURRENT_TIMESTAMP) RETURNING id`,
                    [assignmentId, req.user.id, content]
                );
                submissionId = result.rows[0].id;
            }

            res.json({ submissionId, message: 'Ответ отправлен' });
        } catch (error) {
            console.error(error);
            res.status(500).json({ error: 'Ошибка отправки ответа' });
        }
    });

    app.post('/api/submissions/:submissionId/files', authenticateToken, upload.array('files', 10), async (req, res) => {
        const { submissionId } = req.params;
        try {
            const files = req.files.map(file => ({
                fileName: file.originalname,
                filePath: file.path,
                fileType: file.mimetype,
                fileSize: file.size
            }));

            for (const file of files) {
                await pool.query(
                    `INSERT INTO submission_files (submission_id, file_name, file_path, file_type, file_size) 
                    VALUES ($1, $2, $3, $4, $5)`,
                    [submissionId, file.fileName, file.filePath, file.fileType, file.fileSize]
                );
            }

            res.json({ files, message: 'Файлы загружены' });
        } catch (error) {
            console.error(error);
            res.status(500).json({ error: 'Ошибка загрузки файлов' });
        }
    });

    app.get('/api/submissions/:submissionId/files', authenticateToken, async (req, res) => {
        const { submissionId } = req.params;
        try {
            const result = await pool.query(
                'SELECT * FROM submission_files WHERE submission_id = $1 ORDER BY uploaded_at',
                [submissionId]
            );
            res.json(result.rows);
        } catch (error) {
            console.error(error);
            res.status(500).json({ error: 'Ошибка получения файлов' });
        }
    });

    app.post('/api/submissions/batch', authenticateToken, upload.any(), async (req, res) => {
        const { assignmentId, answers } = req.body;
        
        console.log('📥 Получены данные:');
        console.log('  assignmentId:', assignmentId);
        console.log('  answers:', answers);
        console.log('  файлы:', req.files ? req.files.length : 0);
        
        if (!assignmentId || !answers) {
            return res.status(400).json({ error: 'Недостаточно данных' });
        }

        try {
            const parsedAnswers = JSON.parse(answers);
            if (!Array.isArray(parsedAnswers) || !parsedAnswers.length) {
                return res.status(400).json({ error: 'Некорректный формат ответов' });
            }

            const assignmentCheck = await pool.query(
                `SELECT a.id, a.class_id, a.auto_check, a.content, a.max_score
                FROM assignments a
                JOIN class_students cs ON a.class_id = cs.class_id
                WHERE a.id = $1 AND cs.student_id = $2`,
                [assignmentId, req.user.id]
            );
            
            if (assignmentCheck.rows.length === 0) {
                return res.status(403).json({ error: 'Нет доступа к этому заданию' });
            }

            const assignment = assignmentCheck.rows[0];
            const items = assignment.content?.items || [];
            
            if (req.files && req.files.length > 0) {
                console.log('📎 Сохраняем', req.files.length, 'файлов');
                
                for (const file of req.files) {
                    const fileIndex = parseInt(file.fieldname.replace('image_', ''));
                    if (!isNaN(fileIndex)) {
                        const fileName = file.filename;
                        const answer = parsedAnswers.find(a => a.index === fileIndex);
                        if (answer) {
                            answer.image = fileName;
                            console.log(`📎 Файл для подзадания ${fileIndex}: ${fileName}`);
                        }
                    }
                }
            }

            const answersJson = JSON.stringify(parsedAnswers);

            const existing = await pool.query(
                'SELECT id FROM submissions WHERE assignment_id = $1 AND student_id = $2',
                [assignmentId, req.user.id]
            );

            let submissionId;
            if (existing.rows.length > 0) {
                const updateResult = await pool.query(
                    `UPDATE submissions 
                    SET content = $1, status = 'submitted', submitted_at = CURRENT_TIMESTAMP
                    WHERE assignment_id = $2 AND student_id = $3
                    RETURNING id`,
                    [answersJson, assignmentId, req.user.id]
                );
                submissionId = updateResult.rows[0].id;
            } else {
                const insertResult = await pool.query(
                    `INSERT INTO submissions (assignment_id, student_id, content, status, submitted_at) 
                    VALUES ($1, $2, $3, 'submitted', CURRENT_TIMESTAMP) 
                    RETURNING id`,
                    [assignmentId, req.user.id, answersJson]
                );
                submissionId = insertResult.rows[0].id;
            }

            console.log('✅ submission ID:', submissionId);

            res.json({
                submissionId,
                message: 'Ответы отправлены'
            });
            
        } catch (error) {
            console.error('❌ Ошибка:', error);
            res.status(500).json({ error: 'Ошибка отправки ответов: ' + error.message });
        }
    });

    // ============================================================
    // АННОТАЦИИ
    // ============================================================

    // В POST /api/annotations добавьте subtask_index
    app.post('/api/annotations', authenticateToken, async (req, res) => {
        if (req.user.role !== 'teacher') {
            return res.status(403).json({ error: 'Только для учителей' });
        }
        
        try {
            const { submissionId, x, y, width, height, comment, color, subtaskIndex } = req.body;
            const teacherId = req.user.id;
            
            const checkResult = await pool.query(`
                SELECT a.teacher_id 
                FROM submissions s
                JOIN assignments a ON s.assignment_id = a.id
                WHERE s.id = $1
            `, [submissionId]);
            
            if (checkResult.rows.length === 0) {
                return res.status(404).json({ error: 'Работа не найдена' });
            }
            if (checkResult.rows[0].teacher_id !== teacherId) {
                return res.status(403).json({ error: 'Нет доступа к этой работе' });
            }
            
            // Проверяем наличие колонки subtask_index
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
                [submissionId, teacherId, x, y, width, height, comment, color || '#ff3b30', subtaskIndex || 0]
            );
            
            res.json({ id: result.rows[0].id });
        } catch (error) {
            console.error('❌ Ошибка сохранения аннотации:', error);
            res.status(500).json({ error: 'Ошибка сохранения: ' + error.message });
        }
    });

    app.get('/api/annotations/:submissionId', authenticateToken, async (req, res) => {
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
            
            if (req.user.role === 'teacher') {
                const checkResult = await pool.query(`
                    SELECT a.teacher_id 
                    FROM submissions s
                    JOIN assignments a ON s.assignment_id = a.id
                    WHERE s.id = $1
                `, [submissionId]);
                
                if (checkResult.rows.length > 0 && checkResult.rows[0].teacher_id === req.user.id) {
                    hasAccess = true;
                }
            } else if (req.user.role === 'student') {
                const checkResult = await pool.query(`
                    SELECT student_id FROM submissions WHERE id = $1
                `, [submissionId]);
                
                if (checkResult.rows.length > 0 && checkResult.rows[0].student_id === req.user.id) {
                    hasAccess = true;
                }
            }
            
            if (!hasAccess) {
                return res.status(403).json({ error: 'Нет доступа' });
            }
            
            const result = await pool.query(
                `SELECT a.*, u.full_name as teacher_name 
                FROM annotation_comments a
                JOIN users u ON a.teacher_id = u.id
                WHERE a.submission_id = $1
                ORDER BY a.created_at ASC`,
                [submissionId]
            );
            
            res.json(result.rows);
        } catch (error) {
            console.error('❌ Ошибка получения аннотаций:', error);
            res.status(500).json({ error: 'Ошибка получения: ' + error.message });
        }
    });

    app.delete('/api/annotations/:id', authenticateToken, async (req, res) => {
        if (req.user.role !== 'teacher') {
            return res.status(403).json({ error: 'Только для учителей' });
        }
        
        const { id } = req.params;
        
        try {
            const result = await pool.query(
                `DELETE FROM annotation_comments WHERE id = $1 AND teacher_id = $2 RETURNING id`,
                [id, req.user.id]
            );
            
            if (result.rows.length === 0) {
                return res.status(404).json({ error: 'Комментарий не найден или нет прав' });
            }
            
            res.json({ success: true });
        } catch (error) {
            console.error('❌ Ошибка удаления аннотации:', error);
            res.status(500).json({ error: 'Ошибка удаления: ' + error.message });
        }
    });

    app.post('/api/submissions/:submissionId/grade', authenticateToken, async (req, res) => {
        if (req.user.role !== 'teacher') {
            return res.status(403).json({ error: 'Только для учителей' });
        }
        
        const { submissionId } = req.params;
        const { score, comment } = req.body;
        
        if (score === undefined || score === null) {
            return res.status(400).json({ error: 'Оценка обязательна' });
        }
        
        try {
            const submissionCheck = await pool.query(`
                SELECT a.teacher_id, s.id, s.assignment_id
                FROM submissions s
                JOIN assignments a ON s.assignment_id = a.id
                WHERE s.id = $1
            `, [submissionId]);

            if (submissionCheck.rows.length === 0) {
                return res.status(404).json({ error: 'Ответ не найден' });
            }
            
            if (submissionCheck.rows[0].teacher_id !== req.user.id) {
                return res.status(403).json({ error: 'Нет доступа к этому ответу' });
            }

            await pool.query(`
                UPDATE submissions 
                SET score = $1, 
                    teacher_comment = $2, 
                    status = 'graded', 
                    graded_at = CURRENT_TIMESTAMP
                WHERE id = $3
            `, [score, comment || null, submissionId]);

            res.json({ message: 'Оценка сохранена' });
        } catch (error) {
            console.error('❌ Ошибка сохранения оценки:', error);
            res.status(500).json({ error: 'Ошибка сохранения оценки: ' + error.message });
        }
    });

    // ============================================================
    // ЛИЧНАЯ ДОСКА
    // ============================================================
    app.get('/api/board', authenticateToken, async (req, res) => {
        try {
            const result = await pool.query('SELECT board_data FROM boards WHERE user_id = $1', [req.user.id]);
            if (result.rows.length === 0) {
                await pool.query(
                    'INSERT INTO boards (user_id, board_data) VALUES ($1, $2)',
                    [req.user.id, JSON.stringify({ objects: [] })]
                );
                return res.json({ objects: [] });
            }
            res.json(result.rows[0].board_data);
        } catch (error) {
            console.error(error);
            res.status(500).json({ error: 'Ошибка получения доски' });
        }
    });

    app.post('/api/board', authenticateToken, async (req, res) => {
        const { boardData } = req.body;
        if (!boardData) return res.status(400).json({ error: 'Нет данных для сохранения' });
        try {
            await pool.query(
                `INSERT INTO boards (user_id, board_data, updated_at) 
                VALUES ($1, $2, CURRENT_TIMESTAMP)
                ON CONFLICT (user_id) DO UPDATE SET board_data = $2, updated_at = CURRENT_TIMESTAMP`,
                [req.user.id, JSON.stringify(boardData)]
            );
            res.json({ message: 'Доска сохранена' });
        } catch (error) {
            console.error(error);
            res.status(500).json({ error: 'Ошибка сохранения доски' });
        }
    });

    // ============================================================
    // ДОСКА КЛАССА
    // ============================================================
    app.get('/api/class-board/:classId', authenticateToken, async (req, res) => {
        const { classId } = req.params;
        try {
            let hasAccess = false;
            if (req.user.role === 'teacher') {
                const classCheck = await pool.query(
                    'SELECT id FROM classes WHERE id = $1 AND teacher_id = $2',
                    [classId, req.user.id]
                );
                if (classCheck.rows.length > 0) hasAccess = true;
            } else if (req.user.role === 'student') {
                const classCheck = await pool.query(
                    'SELECT class_id FROM class_students WHERE class_id = $1 AND student_id = $2',
                    [classId, req.user.id]
                );
                if (classCheck.rows.length > 0) hasAccess = true;
            }
            if (!hasAccess) return res.status(403).json({ error: 'Нет доступа' });

            const result = await pool.query(
                'SELECT * FROM class_boards WHERE class_id = $1',
                [classId]
            );
            if (result.rows.length > 0) return res.json(result.rows[0]);

            const newBoard = await pool.query(
                `INSERT INTO class_boards (class_id, board_data, updated_at) 
                VALUES ($1, $2, CURRENT_TIMESTAMP) RETURNING *`,
                [classId, JSON.stringify({ objects: [] })]
            );
            res.json(newBoard.rows[0]);
        } catch (error) {
            console.error(error);
            res.status(500).json({ error: 'Ошибка получения доски' });
        }
    });

    app.post('/api/class-board/:classId', authenticateToken, async (req, res) => {
        const { classId } = req.params;
        const { boardData } = req.body;
        if (!boardData || !boardData.objects) return res.status(400).json({ error: 'Нет данных' });
        try {
            let hasAccess = false;
            if (req.user.role === 'teacher') {
                const classCheck = await pool.query(
                    'SELECT id FROM classes WHERE id = $1 AND teacher_id = $2',
                    [classId, req.user.id]
                );
                if (classCheck.rows.length > 0) hasAccess = true;
            } else if (req.user.role === 'student') {
                const classCheck = await pool.query(
                    'SELECT class_id FROM class_students WHERE class_id = $1 AND student_id = $2',
                    [classId, req.user.id]
                );
                if (classCheck.rows.length > 0) hasAccess = true;
            }
            if (!hasAccess) return res.status(403).json({ error: 'Нет доступа' });

            const result = await pool.query(
                `INSERT INTO class_boards (class_id, board_data, updated_at) 
                VALUES ($1, $2, CURRENT_TIMESTAMP)
                ON CONFLICT (class_id) 
                DO UPDATE SET board_data = $2, updated_at = CURRENT_TIMESTAMP
                RETURNING *`,
                [classId, JSON.stringify(boardData)]
            );
            res.json(result.rows[0]);
        } catch (error) {
            console.error(error);
            res.status(500).json({ error: 'Ошибка сохранения' });
        }
    });

    // ============================================================
    // ОБЩАЯ ДОСКА (ученик+учитель)
    // ============================================================
    app.get('/api/shared-board/:classId/:studentId?', authenticateToken, async (req, res) => {
        const { classId, studentId } = req.params;
        try {
            let teacherId = null, studentIdValue = null;
            if (req.user.role === 'teacher' && studentId) {
                teacherId = req.user.id;
                studentIdValue = parseInt(studentId);
            } else if (req.user.role === 'student') {
                const teacherResult = await pool.query(
                    'SELECT teacher_id FROM classes WHERE id = $1',
                    [classId]
                );
                if (teacherResult.rows.length === 0) return res.status(404).json({ error: 'Класс не найден' });
                teacherId = teacherResult.rows[0].teacher_id;
                studentIdValue = req.user.id;
            } else {
                const result = await pool.query('SELECT board_data FROM boards WHERE user_id = $1', [req.user.id]);
                return res.json({ board_data: result.rows[0]?.board_data || { objects: [] }, isPersonal: true });
            }
            if (!teacherId || !studentIdValue) return res.json({ board_data: { objects: [] }, isNew: true });

            const result = await pool.query(
                'SELECT * FROM shared_boards WHERE teacher_id = $1 AND student_id = $2 AND class_id = $3',
                [teacherId, studentIdValue, parseInt(classId)]
            );
            if (result.rows.length > 0) return res.json(result.rows[0]);

            const newBoard = await pool.query(
                `INSERT INTO shared_boards (teacher_id, student_id, class_id, board_data, updated_at) 
                VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP) RETURNING *`,
                [teacherId, studentIdValue, parseInt(classId), JSON.stringify({ objects: [] })]
            );
            res.json(newBoard.rows[0]);
        } catch (error) {
            console.error(error);
            res.status(500).json({ error: 'Ошибка получения доски' });
        }
    });

    app.post('/api/shared-board/:classId/:studentId?', authenticateToken, async (req, res) => {
        const { classId, studentId } = req.params;
        const { boardData } = req.body;
        if (!boardData || !boardData.objects) return res.status(400).json({ error: 'Нет данных' });
        try {
            let teacherId = null, studentIdValue = null;
            if (req.user.role === 'teacher' && studentId) {
                teacherId = req.user.id;
                studentIdValue = parseInt(studentId);
            } else if (req.user.role === 'student') {
                const teacherResult = await pool.query(
                    'SELECT teacher_id FROM classes WHERE id = $1',
                    [classId]
                );
                if (teacherResult.rows.length === 0) return res.status(404).json({ error: 'Класс не найден' });
                teacherId = teacherResult.rows[0].teacher_id;
                studentIdValue = req.user.id;
            } else {
                return res.status(400).json({ error: 'Неверные параметры' });
            }
            if (!teacherId || !studentIdValue) return res.status(400).json({ error: 'Недостаточно данных' });

            const result = await pool.query(
                `INSERT INTO shared_boards (teacher_id, student_id, class_id, board_data, updated_at) 
                VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP)
                ON CONFLICT (teacher_id, student_id, class_id) 
                DO UPDATE SET board_data = $4, updated_at = CURRENT_TIMESTAMP
                RETURNING *`,
                [teacherId, studentIdValue, parseInt(classId), JSON.stringify(boardData)]
            );
            res.json(result.rows[0]);
        } catch (error) {
            console.error(error);
            res.status(500).json({ error: 'Ошибка сохранения' });
        }
    });

    // ============================================================
    // ПРИГЛАШЕНИЯ В КЛАСС (ЧЕРЕЗ ССЫЛКУ) - ИСПРАВЛЕННАЯ ВЕРСИЯ
    // ============================================================

    // Генерация пригласительной ссылки
    app.post('/api/classes/:classId/invite', authenticateToken, async (req, res) => {
        if (req.user.role !== 'teacher') {
            return res.status(403).json({ error: 'Только для учителей' });
        }
        
        const { classId } = req.params;
        const { maxUses = 1, expiresInHours = 24 } = req.body;
        
        try {
            // Проверяем, что класс принадлежит учителю
            const classCheck = await pool.query(
                'SELECT id FROM classes WHERE id = $1 AND teacher_id = $2',
                [classId, req.user.id]
            );
            
            if (classCheck.rows.length === 0) {
                return res.status(404).json({ error: 'Класс не найден' });
            }
            
            // Генерируем уникальный токен
            const token = 'invite_' + Date.now() + '_' + Math.random().toString(36).substring(2, 10);
            const expiresAt = new Date(Date.now() + expiresInHours * 60 * 60 * 1000);
            
            // Проверяем существование таблицы class_invites
            await pool.query(`
                CREATE TABLE IF NOT EXISTS class_invites (
                    id SERIAL PRIMARY KEY,
                    class_id INTEGER REFERENCES classes(id) ON DELETE CASCADE,
                    token VARCHAR(100) UNIQUE NOT NULL,
                    created_by INTEGER REFERENCES users(id) ON DELETE CASCADE,
                    max_uses INTEGER DEFAULT 1,
                    used_count INTEGER DEFAULT 0,
                    expires_at TIMESTAMP,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    is_active BOOLEAN DEFAULT TRUE
                )
            `);
            
            const result = await pool.query(
                `INSERT INTO class_invites (class_id, token, created_by, max_uses, expires_at)
                VALUES ($1, $2, $3, $4, $5)
                RETURNING *`,
                [classId, token, req.user.id, maxUses, expiresAt]
            );
            
            const invite = result.rows[0];
            const inviteUrl = `${req.protocol}://${req.get('host')}/join-class/${invite.token}`;
            
            res.json({
                token: invite.token,
                url: inviteUrl,
                expires_at: invite.expires_at,
                max_uses: invite.max_uses
            });
        } catch (error) {
            console.error('❌ Ошибка создания приглашения:', error);
            res.status(500).json({ error: 'Ошибка создания приглашения: ' + error.message });
        }
    });

    // Получение информации о приглашении - ВАЖНО: этот маршрут должен быть перед /api/classes/:classId/invites
    app.get('/api/invite/:token', async (req, res) => {
        const { token } = req.params;
        
        try {
            // Проверяем существование таблицы
            const tableCheck = await pool.query(`
                SELECT EXISTS (
                    SELECT FROM information_schema.tables 
                    WHERE table_name = 'class_invites'
                );
            `);
            
            if (!tableCheck.rows[0].exists) {
                return res.status(404).json({ error: 'Приглашение не найдено' });
            }
            
            const result = await pool.query(`
                SELECT i.*, c.name as class_name, c.id as class_id, u.username as teacher_name
                FROM class_invites i
                JOIN classes c ON i.class_id = c.id
                JOIN users u ON c.teacher_id = u.id
                WHERE i.token = $1 AND i.is_active = true
            `, [token]);
            
            if (result.rows.length === 0) {
                return res.status(404).json({ error: 'Приглашение не найдено или неактивно' });
            }
            
            const invite = result.rows[0];
            
            if (new Date(invite.expires_at) < new Date()) {
                return res.status(410).json({ error: 'Срок действия приглашения истёк' });
            }
            
            if (invite.used_count >= invite.max_uses) {
                return res.status(410).json({ error: 'Приглашение уже использовано' });
            }
            
            let isAlreadyMember = false;
            if (req.headers.authorization) {
                try {
                    const authToken = req.headers.authorization.split(' ')[1];
                    const decoded = jwt.verify(authToken, process.env.JWT_SECRET);
                    const memberCheck = await pool.query(
                        'SELECT class_id FROM class_students WHERE class_id = $1 AND student_id = $2',
                        [invite.class_id, decoded.id]
                    );
                    isAlreadyMember = memberCheck.rows.length > 0;
                } catch(e) {}
            }
            
            res.json({
                class_id: invite.class_id,
                class_name: invite.class_name,
                teacher_name: invite.teacher_name,
                expires_at: invite.expires_at,
                max_uses: invite.max_uses,
                used_count: invite.used_count,
                is_already_member: isAlreadyMember
            });
        } catch (error) {
            console.error('❌ Ошибка получения приглашения:', error);
            res.status(500).json({ error: 'Ошибка получения приглашения: ' + error.message });
        }
    });

    // Присоединение к классу по токену
    app.post('/api/invite/:token/join', authenticateToken, async (req, res) => {
        const { token } = req.params;
        
        try {
            const inviteResult = await pool.query(`
                SELECT i.*, c.id as class_id
                FROM class_invites i
                JOIN classes c ON i.class_id = c.id
                WHERE i.token = $1 AND i.is_active = true
            `, [token]);
            
            if (inviteResult.rows.length === 0) {
                return res.status(404).json({ error: 'Приглашение не найдено или неактивно' });
            }
            
            const invite = inviteResult.rows[0];
            
            if (new Date(invite.expires_at) < new Date()) {
                return res.status(410).json({ error: 'Срок действия приглашения истёк' });
            }
            
            if (invite.used_count >= invite.max_uses) {
                return res.status(410).json({ error: 'Приглашение уже использовано' });
            }
            
            const memberCheck = await pool.query(
                'SELECT class_id FROM class_students WHERE class_id = $1 AND student_id = $2',
                [invite.class_id, req.user.id]
            );
            
            if (memberCheck.rows.length > 0) {
                return res.status(400).json({ error: 'Вы уже состоите в этом классе' });
            }
            
            await pool.query(
                'INSERT INTO class_students (class_id, student_id) VALUES ($1, $2)',
                [invite.class_id, req.user.id]
            );
            
            await pool.query(
                'UPDATE class_invites SET used_count = used_count + 1 WHERE id = $1',
                [invite.id]
            );
            
            if (invite.used_count + 1 >= invite.max_uses) {
                await pool.query(
                    'UPDATE class_invites SET is_active = false WHERE id = $1',
                    [invite.id]
                );
            }
            
            res.json({ 
                message: 'Вы успешно присоединились к классу!',
                class_id: invite.class_id
            });
        } catch (error) {
            console.error('❌ Ошибка присоединения к классу:', error);
            res.status(500).json({ error: 'Ошибка присоединения к классу: ' + error.message });
        }
    });

    // Получение всех приглашений для класса
    app.get('/api/classes/:classId/invites', authenticateToken, async (req, res) => {
        if (req.user.role !== 'teacher') {
            return res.status(403).json({ error: 'Только для учителей' });
        }
        
        const { classId } = req.params;
        
        try {
            // Проверяем, что класс принадлежит учителю
            const classCheck = await pool.query(
                'SELECT id FROM classes WHERE id = $1 AND teacher_id = $2',
                [classId, req.user.id]
            );
            
            if (classCheck.rows.length === 0) {
                return res.status(404).json({ error: 'Класс не найден' });
            }
            
            // Проверяем существование таблицы
            const tableCheck = await pool.query(`
                SELECT EXISTS (
                    SELECT FROM information_schema.tables 
                    WHERE table_name = 'class_invites'
                );
            `);
            
            if (!tableCheck.rows[0].exists) {
                return res.json([]);
            }
            
            const result = await pool.query(`
                SELECT id, token, max_uses, used_count, expires_at, created_at, is_active
                FROM class_invites
                WHERE class_id = $1
                ORDER BY created_at DESC
            `, [classId]);
            
            const invites = result.rows.map(invite => ({
                ...invite,
                url: invite.is_active ? `${req.protocol}://${req.get('host')}/join-class/${invite.token}` : null
            }));
            
            res.json(invites);
        } catch (error) {
            console.error('❌ Ошибка получения приглашений:', error);
            res.status(500).json({ error: 'Ошибка получения приглашений: ' + error.message });
        }
    });

    // Деактивация приглашения
    app.delete('/api/invite/:token', authenticateToken, async (req, res) => {
        if (req.user.role !== 'teacher') {
            return res.status(403).json({ error: 'Только для учителей' });
        }
        
        const { token } = req.params;
        
        try {
            const result = await pool.query(`
                UPDATE class_invites 
                SET is_active = false 
                WHERE token = $1 
                AND created_by = $2
                RETURNING id
            `, [token, req.user.id]);
            
            if (result.rows.length === 0) {
                return res.status(404).json({ error: 'Приглашение не найдено' });
            }
            
            res.json({ message: 'Приглашение отключено' });
        } catch (error) {
            console.error('❌ Ошибка отключения приглашения:', error);
            res.status(500).json({ error: 'Ошибка отключения приглашения: ' + error.message });
        }
    });

    // ============================================================
    // ПОЛУЧЕНИЕ ВСЕХ СДАННЫХ РАБОТ ПО ЗАДАНИЮ (ДЛЯ УЧИТЕЛЯ)
    // ============================================================
    app.get('/api/assignments/:assignmentId/submissions', authenticateToken, async (req, res) => {
        if (req.user.role !== 'teacher') {
            return res.status(403).json({ error: 'Только для учителей' });
        }
        
        const { assignmentId } = req.params;
        
        try {
            const assignmentCheck = await pool.query(
                'SELECT teacher_id FROM assignments WHERE id = $1',
                [assignmentId]
            );
            
            if (assignmentCheck.rows.length === 0) {
                return res.status(404).json({ error: 'Задание не найдено' });
            }
            
            if (assignmentCheck.rows[0].teacher_id !== req.user.id) {
                return res.status(403).json({ error: 'Нет доступа к этому заданию' });
            }
            
            const result = await pool.query(`
                SELECT 
                    s.*,
                    u.username,
                    u.full_name,
                    u.id as student_id
                FROM submissions s
                JOIN users u ON s.student_id = u.id
                WHERE s.assignment_id = $1
                ORDER BY s.submitted_at DESC NULLS LAST, s.created_at DESC
            `, [assignmentId]);
            
            const submissions = [];
            for (const row of result.rows) {
                const filesResult = await pool.query(
                    'SELECT * FROM submission_files WHERE submission_id = $1',
                    [row.id]
                );
                submissions.push({
                    ...row,
                    files: filesResult.rows || []
                });
            }
            
            res.json(submissions);
        } catch (error) {
            console.error(error);
            res.status(500).json({ error: 'Ошибка получения работ' });
        }
    });

    // В файле server.js или routes/annotations.js добавьте:

    // Обновление аннотации (для сохранения audioPath)
    app.put('/api/annotations/:id', async (req, res) => {
        const { id } = req.params;
        const { audioPath } = req.body;
        const userId = req.user.id;
        
        try {
            const result = await pool.query(
                `UPDATE annotations 
                SET audio_path = $1 
                WHERE id = $2 AND teacher_id = $3`,
                [audioPath, id, userId]
            );
            if (result.rowCount === 0) {
                return res.status(404).json({ error: 'Аннотация не найдена' });
            }
            res.json({ success: true });
        } catch (error) {
            console.error('Ошибка обновления аннотации:', error);
            res.status(500).json({ error: 'Ошибка сервера' });
        }
    });

    app.get('/api/assignments/:assignmentId/students', authenticateToken, async (req, res) => {
        if (req.user.role !== 'teacher') {
            return res.status(403).json({ error: 'Только для учителей' });
        }
        
        const { assignmentId } = req.params;
        
        try {
            const assignmentResult = await pool.query(
                'SELECT class_id FROM assignments WHERE id = $1 AND teacher_id = $2',
                [assignmentId, req.user.id]
            );
            
            if (assignmentResult.rows.length === 0) {
                return res.status(404).json({ error: 'Задание не найдено' });
            }
            
            const classId = assignmentResult.rows[0].class_id;
            
            const studentsResult = await pool.query(`
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
            `, [assignmentId, classId]);
            
            res.json(studentsResult.rows);
        } catch (error) {
            console.error(error);
            res.status(500).json({ error: 'Ошибка получения студентов' });
        }
    });

    app.get('/api/submissions/:submissionId', authenticateToken, async (req, res) => {
        const { submissionId } = req.params;
        
        try {
            const result = await pool.query(`
                SELECT 
                    s.*,
                    u.username,
                    u.full_name
                FROM submissions s
                JOIN users u ON s.student_id = u.id
                WHERE s.id = $1
            `, [submissionId]);
            
            if (result.rows.length === 0) {
                return res.status(404).json({ error: 'Работа не найдена' });
            }
            
            const submission = result.rows[0];
            
            if (req.user.role === 'teacher') {
                const assignmentCheck = await pool.query(
                    'SELECT teacher_id FROM assignments WHERE id = $1',
                    [submission.assignment_id]
                );
                if (assignmentCheck.rows.length === 0 || assignmentCheck.rows[0].teacher_id !== req.user.id) {
                    return res.status(403).json({ error: 'Нет доступа к этой работе' });
                }
            } 
            else if (req.user.role === 'student') {
                if (submission.student_id !== req.user.id) {
                    return res.status(403).json({ error: 'Нет доступа к этой работе' });
                }
            }
            
            const filesResult = await pool.query(
                'SELECT * FROM submission_files WHERE submission_id = $1',
                [submissionId]
            );
            submission.files = filesResult.rows || [];
            
            const annotationsResult = await pool.query(
                'SELECT * FROM annotation_comments WHERE submission_id = $1 ORDER BY created_at',
                [submissionId]
            );
            submission.annotations = annotationsResult.rows || [];
            
            res.json(submission);
        } catch (error) {
            console.error('Ошибка получения работы:', error);
            res.status(500).json({ error: 'Ошибка получения работы' });
        }
    });

    app.delete('/api/annotations/:annotationId', authenticateToken, async (req, res) => {
        if (req.user.role !== 'teacher') {
            return res.status(403).json({ error: 'Только для учителей' });
        }
        
        const { annotationId } = req.params;
        
        try {
            const result = await pool.query(
                'DELETE FROM annotation_comments WHERE id = $1 AND teacher_id = $2 RETURNING id',
                [annotationId, req.user.id]
            );
            
            if (result.rows.length === 0) {
                return res.status(404).json({ error: 'Комментарий не найден или нет прав' });
            }
            
            res.json({ message: 'Комментарий удалён' });
        } catch (error) {
            console.error('Ошибка удаления аннотации:', error);
            res.status(500).json({ error: 'Ошибка удаления' });
        }
    });

    // ============================================================
    // ТЕКСТОВЫЕ КОММЕНТАРИИ
    // ============================================================
    app.post('/api/text-comments', authenticateToken, async (req, res) => {
        if (req.user.role !== 'teacher') {
            return res.status(403).json({ error: 'Только для учителей' });
        }
        
        const { submissionId, subtaskIndex, selectedText, comment } = req.body;
        
        if (!submissionId || !selectedText || !comment) {
            return res.status(400).json({ error: 'Недостаточно данных' });
        }
        
        try {
            const result = await pool.query(
                `INSERT INTO text_comments (submission_id, teacher_id, subtask_index, selected_text, comment)
                VALUES ($1, $2, $3, $4, $5)
                RETURNING id, created_at`,
                [submissionId, req.user.id, subtaskIndex || 0, selectedText, comment]
            );
            
            res.json({ 
                id: result.rows[0].id,
                created_at: result.rows[0].created_at
            });
        } catch (error) {
            console.error('❌ Ошибка сохранения текстового комментария:', error);
            res.status(500).json({ error: 'Ошибка сохранения: ' + error.message });
        }
    });

    // Получение текстовых комментариев для работы
    app.get('/api/text-comments/:submissionId', authenticateToken, async (req, res) => {
        const { submissionId } = req.params;
        
        try {
            // Проверяем доступ
            let hasAccess = false;
            
            if (req.user.role === 'teacher') {
                const check = await pool.query(`
                    SELECT a.teacher_id 
                    FROM submissions s
                    JOIN assignments a ON s.assignment_id = a.id
                    WHERE s.id = $1
                `, [submissionId]);
                
                if (check.rows.length > 0 && check.rows[0].teacher_id === req.user.id) {
                    hasAccess = true;
                }
            } else if (req.user.role === 'student') {
                const check = await pool.query(`
                    SELECT student_id FROM submissions WHERE id = $1
                `, [submissionId]);
                
                if (check.rows.length > 0 && check.rows[0].student_id === req.user.id) {
                    hasAccess = true;
                }
            }
            
            if (!hasAccess) {
                return res.status(403).json({ error: 'Нет доступа' });
            }
            
            const result = await pool.query(
                `SELECT id, subtask_index, selected_text, comment, created_at
                FROM text_comments
                WHERE submission_id = $1
                ORDER BY created_at ASC`,
                [submissionId]
            );
            
            res.json(result.rows);
        } catch (error) {
            console.error('❌ Ошибка получения текстовых комментариев:', error);
            res.status(500).json({ error: 'Ошибка получения: ' + error.message });
        }
    });

    // Удаление текстового комментария
    app.delete('/api/text-comments/:id', authenticateToken, async (req, res) => {
        if (req.user.role !== 'teacher') {
            return res.status(403).json({ error: 'Только для учителей' });
        }
        
        const { id } = req.params;
        
        try {
            const result = await pool.query(
                `DELETE FROM text_comments WHERE id = $1 AND teacher_id = $2 RETURNING id`,
                [id, req.user.id]
            );
            
            if (result.rows.length === 0) {
                return res.status(404).json({ error: 'Комментарий не найден или нет прав' });
            }
            
            res.json({ success: true });
        } catch (error) {
            console.error('❌ Ошибка удаления текстового комментария:', error);
            res.status(500).json({ error: 'Ошибка удаления: ' + error.message });
        }
    });


    // ============================================================
    // УДАЛЕНИЕ КЛАССА
    // ============================================================
    app.delete('/api/classes/:classId', authenticateToken, async (req, res) => {
        if (req.user.role !== 'teacher') {
            return res.status(403).json({ error: 'Только для учителей' });
        }
        
        const { classId } = req.params;
        
        try {
            // Проверяем, что класс принадлежит учителю
            const classCheck = await pool.query(
                'SELECT id FROM classes WHERE id = $1 AND teacher_id = $2',
                [classId, req.user.id]
            );
            
            if (classCheck.rows.length === 0) {
                return res.status(404).json({ error: 'Класс не найден или у вас нет прав' });
            }
            
            // Удаляем класс (каскадно удалятся все связанные данные)
            await pool.query(
                'DELETE FROM classes WHERE id = $1',
                [classId]
            );
            
            res.json({ message: 'Класс успешно удалён' });
        } catch (error) {
            console.error('❌ Ошибка удаления класса:', error);
            res.status(500).json({ error: 'Ошибка удаления класса: ' + error.message });
        }
    });

    // ============================================================
    // ЗАПУСК
    // ============================================================
    const os = require('os');

    function getLocalIP() {
        const interfaces = os.networkInterfaces();
        for (const name of Object.keys(interfaces)) {
            for (const net of interfaces[name]) {
                if (net.family === 'IPv4' && !net.internal) {
                    return net.address;
                }
            }
        }
        return 'localhost';
    }

    server.listen(port, '0.0.0.0', () => {
        const ip = getLocalIP();
        console.log(`\n🚀 Сервер запущен!`);
        console.log(`💻 Компьютер: http://localhost:${port}`);
        console.log(`📱 Телефон (Wi-Fi): http://${ip}:${port}`);
        console.log(`🔌 WebSocket работает на ws://localhost:${port}`);
        console.log(`📊 Комнаты в реальном времени включены!\n`);
    });
})();
