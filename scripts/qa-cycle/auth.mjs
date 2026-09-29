// Вход через API: сервер ставит httpOnly-cookie в контекст браузера.
export async function login(ctx, email) {
  const r = await ctx.request.post('http://localhost:5173/api/auth/login', { headers: { 'X-Requested-With': 'portfel' }, data: { email, password: 'password123' } })
  if (!r.ok()) throw new Error('login failed ' + r.status())
  await ctx.addInitScript(() => localStorage.setItem('capital-api-token', 'cookie-session'))
}
