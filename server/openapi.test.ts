// Документация API (§33) не должна расходиться с кодом: каждый маршрут server/index.ts
// описан в docs/openapi.yaml, и в документации нет маршрутов, которых нет в коде.
// Запуск: `npx tsx server/openapi.test.ts`. YAML-парсер в проект не тянем — структура
// раздела paths фиксированная (путь с отступом 2, метод с отступом 4), её хватает регулярок.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const source = readFileSync(new URL('./index.ts', import.meta.url), 'utf8')
const spec = readFileSync(new URL('../docs/openapi.yaml', import.meta.url), 'utf8')

const routes = new Set(
  [...source.matchAll(/^app\.(get|post|put|patch|delete)\('([^']+)'/gm)]
    .map(([, method, path]) => `${method.toUpperCase()} ${path.replace(/:(\w+)/g, '{$1}')}`),
)

const documented = new Set<string>()
const paths = spec.slice(spec.indexOf('\npaths:'), spec.indexOf('\ncomponents:'))
let current = ''
for (const line of paths.split('\n')) {
  const path = /^ {2}(\/\S+):$/.exec(line)
  if (path) { current = path[1]; continue }
  const method = /^ {4}(get|post|put|patch|delete):$/.exec(line)
  if (method && current) documented.add(`${method[1].toUpperCase()} ${current}`)
}

let failed = 0
function test(name: string, run: () => void) {
  try { run(); console.log(`  ok   ${name}`) } catch (error) {
    failed += 1
    console.log(`  FAIL ${name}\n       ${error instanceof Error ? error.message : error}`)
  }
}

console.log('\nДокументация API (§33)')
test('маршруты найдены в коде и в документации', () => {
  assert.ok(routes.size > 20, `в коде ${routes.size} маршрутов`)
  assert.ok(documented.size > 20, `в документации ${documented.size} маршрутов`)
})
test('каждый маршрут кода описан в docs/openapi.yaml', () => {
  assert.deepEqual([...routes].filter((route) => !documented.has(route)), [])
})
test('в документации нет маршрутов, которых нет в коде', () => {
  assert.deepEqual([...documented].filter((route) => !routes.has(route)), [])
})

console.log(failed ? `\n${failed} тест(ов) провалено\n` : '\nВсе тесты прошли\n')
process.exit(failed ? 1 : 0)
