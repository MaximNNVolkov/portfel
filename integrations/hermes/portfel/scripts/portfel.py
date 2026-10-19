#!/usr/bin/env python3
"""Клиент API «Портфеля» для навыка Hermes. Только стандартная библиотека.

Переменные окружения:
  PORTFEL_URL      адрес приложения, например https://portfel.example.ru
  PORTFEL_API_KEY  ключ из «Интеграции → Hermes» (начинается с pfk_)

Команды печатают короткий текст для агента, а не сырой JSON (кроме --json).
"""
import argparse
import datetime as dt
import json
import os
import sys
import urllib.error
import urllib.request

TYPE_LABELS = {"deposit": "Вклады", "bond": "Облигации", "stock": "Акции", "fund": "Фонды", "cash": "Деньги", "other": "Прочее"}
PAYOUT_KINDS = {
    "COUPON": "купон", "DIVIDEND": "дивиденды", "INTEREST": "проценты",
    "DEPOSIT_PRINCIPAL": "возврат вклада", "REDEMPTION": "погашение", "OTHER": "выплата",
}
FREQUENCIES = {"monthly": "monthly", "quarterly": "quarterly", "end": "at maturity"}


def fail(message: str) -> None:
    print(f"Ошибка: {message}", file=sys.stderr)
    sys.exit(1)


def config() -> tuple[str, str]:
    url = os.environ.get("PORTFEL_URL", "").rstrip("/")
    key = os.environ.get("PORTFEL_API_KEY", "")
    if not url:
        fail("не задан PORTFEL_URL")
    if not key.startswith("pfk_"):
        fail("не задан PORTFEL_API_KEY (ключ из «Интеграции → Hermes», начинается с pfk_)")
    return url, key


def api(method: str, path: str, body: dict | None = None):
    url, key = config()
    data = json.dumps(body).encode() if body is not None else None
    request = urllib.request.Request(f"{url}/api{path}", data=data, method=method)
    request.add_header("Authorization", f"Bearer {key}")
    request.add_header("Accept", "application/json")
    if data is not None:
        request.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            raw = response.read()
            return json.loads(raw) if raw else None
    except urllib.error.HTTPError as error:
        try:
            message = json.loads(error.read()).get("error")
        except Exception:
            message = None
        if error.code == 401:
            fail("ключ не принят — возможно, его отозвали в «Интеграции → Hermes»")
        fail(message or f"сервер ответил {error.code}")
    except urllib.error.URLError as error:
        fail(f"нет связи с «Портфелем» ({error.reason})")


def money(amount, currency: str = "RUB") -> str:
    if amount is None:
        return "нет оценки"
    rounded = round(float(amount))
    text = f"{rounded:,}".replace(",", " ")
    return f"{text} {'₽' if currency == 'RUB' else currency}"


def percent(value) -> str:
    return "—" if value is None else f"{value:+.2f}%".replace(".", ",")


def number(value) -> str:
    return f"{value:g}".replace(".", ",")


def date_ru(value: str | None) -> str:
    if not value:
        return "—"
    year, month, day = value[:10].split("-")
    return f"{day}.{month}.{year}"


def cmd_summary(args) -> None:
    summary = api("GET", "/portfolio/summary")
    if args.json:
        return print(json.dumps(summary, ensure_ascii=False, indent=2))
    base = summary.get("baseCurrency", "RUB")
    if not summary.get("positions") and not summary.get("total"):
        return print("Портфель пуст.")
    incomplete = summary.get("valuation", {}).get("incomplete")
    lines = [
        f"Стоимость портфеля: {money(summary.get('total'), base)}{' (оценка неполная)' if incomplete else ''}",
        f"Финансовый результат: {money(summary.get('financialResult'), base)} ({percent(summary.get('returnPercent'))})",
        f"Вложено: {money(summary.get('invested'), base)}",
        f"Получено выплат: {money(summary.get('paid'), base)}",
        f"Ожидается дохода: {money(summary.get('expected'), base)}, возврат вложений: {money(summary.get('expectedPrincipal'), base)}",
    ]
    if summary.get("overdue"):
        lines.append(f"Не отмечено полученным: {money(summary.get('overdue'), base)}")
    lines.append("")
    lines.append("По категориям:")
    for group in summary.get("groups", []):
        share = f"{group.get('share') or 0:.1f}".replace(".", ",")
        lines.append(f"• {group['group']}: {money(group.get('value'), base)}, доля {share}%, результат {percent(group.get('pnlPercent'))}")
    print("\n".join(lines))


def cmd_products(args) -> None:
    positions = api("GET", "/positions")
    open_positions = [p for p in positions if not p.get("closedOn")]
    if args.type:
        label = TYPE_LABELS[args.type]
        open_positions = [p for p in open_positions if p.get("type") == label]
    if args.json:
        return print(json.dumps(open_positions, ensure_ascii=False, indent=2))
    if not open_positions:
        return print("Таких продуктов нет.")
    for p in open_positions:
        valuation = p.get("valuation") or {}
        value = "цена недоступна" if valuation.get("priceUnavailable") else money(valuation.get("value"), p.get("currency", "RUB"))
        parts = [f"{p['name']} — {p.get('institution', '')}", value]
        if p.get("rate"):
            parts.append(f"ставка {number(p['rate'])}%")
        if p.get("couponRate"):
            parts.append(f"купон {number(p['couponRate'])}%")
        end = p.get("termEndDate") or p.get("maturityDate")
        if end:
            parts.append(f"до {date_ru(end)}")
        print(f"• [{p.get('type')}] " + ", ".join(parts))


def cmd_payouts(args) -> None:
    payouts = api("GET", "/payouts")
    today = dt.date.today().isoformat()
    until = (dt.date.today() + dt.timedelta(days=args.days)).isoformat()
    upcoming = [p for p in payouts if p.get("status") == "expected" and today <= p["date"] <= until]
    overdue = [p for p in payouts if p.get("status") == "expected" and p["date"] < today]
    if args.json:
        return print(json.dumps({"upcoming": upcoming, "overdue": overdue}, ensure_ascii=False, indent=2))
    if not upcoming:
        print(f"В ближайшие {args.days} дн. выплат не ожидается.")
    else:
        total = sum(p.get("amountBase") or 0 for p in upcoming)
        print(f"Ожидается за {args.days} дн.: {money(total)}")
        for p in upcoming:
            kind = PAYOUT_KINDS.get(p.get("type"), "выплата")
            print(f"• {date_ru(p['date'])} — {p.get('title') or kind}: {money(p.get('amount'), p.get('currency', 'RUB'))} ({kind}, {p.get('institution', '')})")
    if overdue:
        print(f"\nНе отмечено полученным: {len(overdue)} выплат(ы) на {money(sum(p.get('amountBase') or 0 for p in overdue))}")


def cmd_recommendations(args) -> None:
    items = api("GET", "/recommendations")
    if args.json:
        return print(json.dumps(items, ensure_ascii=False, indent=2))
    if not items:
        return print("Замечаний по портфелю нет.")
    for item in items:
        print(f"• {item.get('text')}")


def cmd_add_deposit(args) -> None:
    for value, name in ((args.date, "--date"), (args.end, "--end")):
        if value:
            try:
                dt.date.fromisoformat(value)
            except ValueError:
                fail(f"{name}: дата в формате ГГГГ-ММ-ДД")
    body = {
        "type": "deposit",
        "name": args.name,
        "institution": args.bank,
        "amount": args.amount,
        "date": args.date,
        "currency": args.currency.upper(),
        "rate": args.rate,
        "capitalization": args.capitalization,
        "autoProlongation": args.auto_prolongation,
    }
    if args.end:
        body["termEndDate"] = args.end
    if args.frequency:
        body["interestPayoutFrequency"] = FREQUENCIES[args.frequency]
    if args.dry_run:
        return print(json.dumps(body, ensure_ascii=False, indent=2))
    created = api("POST", "/positions", body)
    valuation = created.get("valuation") or {}
    print(f"Добавлен вклад «{created['name']}» в {created.get('institution')}: {money(created.get('invested'), created.get('currency', 'RUB'))}, "
          f"ставка {number(created.get('rate') or 0)}%, с {date_ru(created.get('date'))}"
          + (f" до {date_ru(created.get('termEndDate'))}" if created.get("termEndDate") else "")
          + f". Текущая оценка: {money(valuation.get('value'), created.get('currency', 'RUB'))}.")


def main() -> None:
    parser = argparse.ArgumentParser(description="«Портфель»: финансы владельца")
    sub = parser.add_subparsers(dest="command", required=True)

    summary = sub.add_parser("summary", help="итог портфеля и категории")
    summary.add_argument("--json", action="store_true")
    summary.set_defaults(handler=cmd_summary)

    products = sub.add_parser("products", help="открытые продукты")
    products.add_argument("--type", choices=sorted(TYPE_LABELS))
    products.add_argument("--json", action="store_true")
    products.set_defaults(handler=cmd_products)

    payouts = sub.add_parser("payouts", help="ожидаемые выплаты")
    payouts.add_argument("--days", type=int, default=30)
    payouts.add_argument("--json", action="store_true")
    payouts.set_defaults(handler=cmd_payouts)

    recommendations = sub.add_parser("recommendations", help="аналитические замечания по портфелю")
    recommendations.add_argument("--json", action="store_true")
    recommendations.set_defaults(handler=cmd_recommendations)

    deposit = sub.add_parser("add-deposit", help="добавить вклад")
    deposit.add_argument("--name", required=True, help="название вклада")
    deposit.add_argument("--bank", required=True, help="банк")
    deposit.add_argument("--amount", type=float, required=True, help="сумма вклада")
    deposit.add_argument("--date", required=True, help="дата открытия, ГГГГ-ММ-ДД")
    deposit.add_argument("--rate", type=float, required=True, help="ставка, %% годовых")
    deposit.add_argument("--end", help="дата окончания, ГГГГ-ММ-ДД")
    deposit.add_argument("--frequency", choices=sorted(FREQUENCIES), help="выплата процентов: monthly, quarterly, end")
    deposit.add_argument("--capitalization", action="store_true", help="проценты капитализируются")
    deposit.add_argument("--auto-prolongation", action="store_true", help="вклад продлевается автоматически")
    deposit.add_argument("--currency", default="RUB")
    deposit.add_argument("--dry-run", action="store_true", help="показать, что будет отправлено, без сохранения")
    deposit.set_defaults(handler=cmd_add_deposit)

    args = parser.parse_args()
    args.handler(args)


if __name__ == "__main__":
    main()
