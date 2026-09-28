// Отправка писем через SMTP (§28, §33 — восстановление пароля). Единственный на MVP
// повод отправлять письмо, поэтому модуль умеет только письмо сброса пароля, а не общий
// почтовый клиент — расширять до произвольных шаблонов имеет смысл только когда появится
// второй повод (например, email-уведомления, §25, [v2]).
//
// Деградация по образцу §40.2: если SMTP не настроен (нет SMTP_HOST) или отправка не
// удалась, сервис не падает и не блокирует сброс пароля — ссылка пишется в лог с меткой
// [password-reset], чтобы владелец стенда мог забрать её оттуда вручную (см. docs/STAND.md).
import nodemailer, { type Transporter } from 'nodemailer'
import { logError } from './logger.ts'

const APP_URL = (process.env.APP_URL || 'http://localhost:5173').replace(/\/$/, '')
const MAIL_FROM = process.env.MAIL_FROM || 'no-reply@portfel.local'

let transporter: Transporter | undefined
let transporterChecked = false

function getTransporter(): Transporter | undefined {
  if (transporterChecked) return transporter
  transporterChecked = true
  const host = (process.env.SMTP_HOST || '').trim()
  if (!host) return undefined
  transporter = nodemailer.createTransport({
    host,
    port: Number(process.env.SMTP_PORT || 587),
    secure: process.env.SMTP_SECURE === 'true',
    auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS || '' } : undefined,
  })
  return transporter
}

function resetEmailBody(resetUrl: string) {
  const text = `Здравствуйте!\n\n`
    + `Вы (или кто-то другой) запросили восстановление пароля к вашему аккаунту в приложении «Портфель».\n`
    + `Чтобы задать новый пароль, перейдите по ссылке (действует 1 час):\n${resetUrl}\n\n`
    + `Если вы не запрашивали восстановление пароля — просто проигнорируйте это письмо, пароль останется прежним.`
  const html = `<p>Здравствуйте!</p>`
    + `<p>Вы (или кто-то другой) запросили восстановление пароля к вашему аккаунту в приложении «Портфель».</p>`
    + `<p>Чтобы задать новый пароль, перейдите по ссылке (действует 1 час):</p>`
    + `<p><a href="${resetUrl}">${resetUrl}</a></p>`
    + `<p>Если вы не запрашивали восстановление пароля — просто проигнорируйте это письмо, пароль останется прежним.</p>`
  return { text, html }
}

export async function sendPasswordResetEmail(email: string, token: string): Promise<void> {
  const resetUrl = `${APP_URL}/reset-password?token=${encodeURIComponent(token)}`
  const client = getTransporter()
  if (!client) {
    console.warn(`[password-reset] SMTP не настроен (SMTP_HOST не задан) — ссылка для ${email}: ${resetUrl}`)
    return
  }
  const { text, html } = resetEmailBody(resetUrl)
  try {
    await client.sendMail({ from: MAIL_FROM, to: email, subject: 'Восстановление пароля — Портфель', text, html })
  } catch (error) {
    logError('mailer.password-reset', error)
    console.warn(`[password-reset] Не удалось отправить письмо через SMTP — ссылка для ${email}: ${resetUrl}`)
  }
}
