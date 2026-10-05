const nodemailer = require('nodemailer');

// Отправка почты: два независимых канала.
//
// 1) UniOne Web API (HTTPS, порт 443) — приоритетный.
//    На OnReza исходящие SMTP-порты (25/465/587/2525) заблокированы на всех
//    тарифах, поэтому классический SMTP там не работает — письма уходят по
//    таймауту. HTTPS API доступен везде.
//    Нужны переменные: UNIONE_API_KEY и MAIL_FROM (верифицированный
//    отправитель в кабинете UniOne).
//
// 2) Классический SMTP — фолбэк для локальной разработки и хостингов,
//    где SMTP-порты открыты. Переменные SMTP_HOST/PORT/SECURE/USER/PASS.
//
// Если не настроен ни один канал — письма пропускаются, сервер работает дальше.

const UNIONE_API_KEY = process.env.UNIONE_API_KEY;
const UNIONE_API_URL =
  process.env.UNIONE_API_URL ||
  'https://api.unione.io/en/transactional/api/v1/email/send.json';
const MAIL_FROM = process.env.MAIL_FROM || process.env.SMTP_USER;
const MAIL_FROM_NAME = process.env.MAIL_FROM_NAME || 'Образовательная платформа';

const smtpConfigured = !!(
  process.env.SMTP_HOST &&
  process.env.SMTP_USER &&
  process.env.SMTP_PASS
);

let transporter = null;
if (smtpConfigured) {
  transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: parseInt(process.env.SMTP_PORT) || 465,
    secure: process.env.SMTP_SECURE === 'true',
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
    // Не блокировать старт приложения ожиданием SMTP:
    // при недоступном SMTP отправка просто упадёт по таймауту,
    // а сервер поднимется мгновенно.
    connectionTimeout: 5000,
    socketTimeout: 5000,
    greetingTimeout: 5000,
  });
}

if (UNIONE_API_KEY) {
  console.log('✅ Почта: UniOne Web API (работает и на OnReza)');
} else if (smtpConfigured) {
  console.log('✅ Почта: SMTP (проверка будет при первой отправке)');
} else {
  // без почтовых настроек тихо работаем (сброс пароля по email недоступен)
}

function buildResetHtml(resetLink) {
  return `
            <div style="font-family: Arial, sans-serif; max-width: 500px; margin: 0 auto;">
                <h2 style="color: #333;">Сброс пароля</h2>
                <p>Вы запросили сброс пароля для вашего аккаунта.</p>
                <p>Перейдите по ссылке ниже, чтобы установить новый пароль:</p>
                <p style="text-align: center; margin: 24px 0;">
                    <a href="${resetLink}" 
                       style="display: inline-block; padding: 12px 28px; background: #667eea; color: #fff; text-decoration: none; border-radius: 8px; font-weight: 500;">
                        Сбросить пароль
                    </a>
                </p>
                <p style="color: #666; font-size: 13px;">Ссылка действительна в течение 1 часа.</p>
                <p style="color: #999; font-size: 12px;">Если вы не запрашивали сброс пароля, просто проигнорируйте это письмо.</p>
            </div>
        `;
}

async function sendViaUniOne(to, html) {
  const response = await fetch(UNIONE_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'X-API-KEY': UNIONE_API_KEY,
    },
    body: JSON.stringify({
      message: {
        recipients: [{ email: to }],
        body: { html },
        subject: 'Сброс пароля',
        from_email: MAIL_FROM,
        from_name: MAIL_FROM_NAME,
      },
    }),
    signal: AbortSignal.timeout(10000),
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.status !== 'success') {
    throw new Error(
      `UniOne API: HTTP ${response.status} ${JSON.stringify(data)}`,
    );
  }
  console.log('Письмо отправлено (UniOne):', data.job_id);
  return data;
}

async function sendPasswordResetEmail(to, resetToken) {
  const resetLink = `${process.env.APP_URL || 'http://localhost:3000'}/reset-password?token=${resetToken}`;
  const html = buildResetHtml(resetLink);

  if (UNIONE_API_KEY) {
    return sendViaUniOne(to, html);
  }

  if (!smtpConfigured || !transporter) {
    console.warn('⚠️ Почта не настроена — письмо сброса пароля пропущено для:', to);
    return { skipped: true };
  }

  const info = await transporter.sendMail({
    from: `"${MAIL_FROM_NAME}" <${MAIL_FROM}>`,
    to: to,
    subject: 'Сброс пароля',
    html,
  });
  console.log('Письмо отправлено (SMTP):', info.messageId);
  return info;
}

module.exports = { sendPasswordResetEmail };
