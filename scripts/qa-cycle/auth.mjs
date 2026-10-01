// Вход через API: сервер ставит httpOnly-cookie в контекст браузера.
// QA_WEB — адрес фронта (на проде фронт и API на одном домене), QA_PASSWORD — пароль.
export const WEB = process.env.QA_WEB || 'http://localhost:5173'
export const PASSWORD = process.env.QA_PASSWORD || 'password123'

export async function login(ctx, email) {
  const r = await ctx.request.post(WEB + '/api/auth/login', { headers: { 'X-Requested-With': 'portfel' }, data: { email, password: PASSWORD } })
  if (!r.ok()) throw new Error('login failed ' + r.status())
  await ctx.addInitScript(() => localStorage.setItem('capital-api-token', 'cookie-session'))
}
