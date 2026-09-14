const nodemailer = require('nodemailer');

const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: parseInt(process.env.SMTP_PORT) || 465,
    secure: process.env.SMTP_SECURE === 'true',
    auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS
    }
});

transporter.verify((error) => {
    if (error) console.error('❌ SMTP error:', error.message);
    else console.log('✅ SMTP готов к отправке писем');
});

async function sendPasswordResetEmail(to, resetToken) {
    const resetLink = `${process.env.APP_URL || 'http://localhost:3000'}/reset-password?token=${resetToken}`;

    const mailOptions = {
        from: `"Образовательная платформа" <${process.env.SMTP_USER}>`,
        to: to,
        subject: 'Сброс пароля',
        html: `
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
        `
    };

    const info = await transporter.sendMail(mailOptions);
    console.log('📧 Письмо отправлено:', info.messageId);
    return info;
}

module.exports = { sendPasswordResetEmail };