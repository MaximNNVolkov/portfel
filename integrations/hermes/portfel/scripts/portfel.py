#!/usr/bin/env python3
"""Клиент API «Портфеля» для навыка Hermes. Только стандартная библиотека.

Навык ведёт портфель полностью: смотрит, добавляет, правит и удаляет продукты, операции
и выплаты, запускает синхронизацию брокера, выбирает уведомления. Любая запись — только
после подтверждения владельца (см. SKILL.md); у записывающих команд есть --dry-run.

Адрес и ключ установщик ссылки «Подключить Hermes» кладёт в config.json рядом с навыком.
Переменные окружения, если заданы, важнее (ручная настройка):
  PORTFEL_URL      адрес приложения, например https://portfel.example.ru
  PORTFEL_API_KEY  ключ из «Интеграции → Hermes» (начинается с pfk_)

Команды печатают короткий текст для агента, а не сырой JSON (кроме --json).
"""
import argparse
import datetime as dt
import json
import os
import pathlib
import sys
import urllib.error
import urllib.request

TYPE_LABELS = {"deposit": "Вклады", "bond": "Облигации", "stock": "Акции", "fund": "Фонды", "cash": "Деньги", "other": "Прочее"}
PAYOUT_KINDS = {
    "COUPON": "купон", "DIVIDEND": "дивиденды", "INTEREST": "проценты",
    "DEPOSIT_PRINCIPAL": "возврат вклада", "REDEMPTION": "погашение", "OTHER": "выплата",
}
FREQUENCIES = {"monthly": "monthly", "quarterly": "quarterly", "end": "at maturity"}
# Тип продукта в API: облигации, акции и фонды по тикеру дополняются данными Мосбиржи.
API_TYPES = {"deposit": "deposit", "bond": "bond", "stock": "share", "fund": "fund", "cash": "cash", "other": "other"}
OPERATION_TYPES = {
    "BUY": "покупка", "SELL": "продажа", "COUPON": "купон", "DIVIDEND": "дивиденды", "INTEREST": "проценты",
    "FEE": "комиссия", "TAX": "налог", "REDEMPTION": "погашение", "OTHER": "прочее",
    "DEPOSIT": "пополнение", "WITHDRAW": "вывод средств",
}
NOTIFICATION_KINDS = {
    "payout_received": "пришли выплаты (купоны, дивиденды, проценты)",
    "position_closed": "вклад закрыт, облигация погашена",
    "maturity_soon": "за неделю до окончания вклада или погашения облигации",
    "broker_error": "ошибка синхронизации брокера",
    "payout_soon": "выплаты в ближайшие три дня",
    "payout_overdue": "выплата не отмечена полученной",
    "weekly_summary": "недельная сводка по понедельникам",
}


def fail(message: str) -> None:
    print(f"Ошибка: {message}", file=sys.stderr)
    sys.exit(1)


CONFIG_PATH = pathlib.Path(__file__).resolve().parent.parent / "config.json"


def config() -> tuple[str, str]:
    saved = {}
    if CONFIG_PATH.exists():
        try:
            saved = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
        except ValueError:
            fail(f"{CONFIG_PATH} повреждён — попросите владельца прислать новую ссылку подключения")
    url = (os.environ.get("PORTFEL_URL") or saved.get("url") or "").rstrip("/")
    key = os.environ.get("PORTFEL_API_KEY") or saved.get("apiKey") or ""
    if not url or not key.startswith("pfk_"):
        fail("«Портфель» не подключён — попросите владельца нажать «Подключить Hermes» в «Портфель → Интеграции → Hermes» и прислать ссылку")
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
            fail("ключ не принят — возможно, его отозвали; попросите владельца прислать новую ссылку из «Интеграции → Hermes»")
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
        print(f"• [{p.get('type')}] " + ", ".join(parts) + f" (id {p['id']})")


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
            print(f"• {date_ru(p['date'])} — {p.get('title') or kind}: {money(p.get('amount'), p.get('currency', 'RUB'))} ({kind}, {p.get('institution', '')}) (id {p['id']})")
    if overdue:
        print(f"\nНе отмечено полученным: {len(overdue)} выплат(ы) на {money(sum(p.get('amountBase') or 0 for p in overdue))}")
        for p in overdue:
            kind = PAYOUT_KINDS.get(p.get("type"), "выплата")
            print(f"• {date_ru(p['date'])} — {p.get('title') or kind}: {money(p.get('amount'), p.get('currency', 'RUB'))} (id {p['id']})")


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


def find_product(query: str, include_closed: bool = False) -> dict:
    """Продукт по id или части названия; при нескольких совпадениях — ошибка со списком."""
    positions = api("GET", "/positions")
    if not include_closed:
        positions = [p for p in positions if not p.get("closedOn")] or positions
    exact = [p for p in positions if p["id"] == query]
    if exact:
        return exact[0]
    needle = query.lower()
    found = [p for p in positions if needle in p["name"].lower()]
    if not found:
        fail(f"продукт «{query}» не найден — посмотрите `products`")
    if len(found) > 1:
        names = "; ".join(f"{p['name']} — {p.get('institution', '')} (id {p['id']})" for p in found)
        fail(f"под «{query}» подходит несколько продуктов, укажите id: {names}")
    return found[0]


def parse_value(raw: str):
    lowered = raw.lower()
    if lowered in ("true", "да", "yes"):
        return True
    if lowered in ("false", "нет", "no"):
        return False
    if lowered in ("null", "none", ""):
        return None
    try:
        return int(raw) if raw.lstrip("-").isdigit() else float(raw.replace(",", "."))
    except ValueError:
        return raw


def parse_fields(pairs: list[str] | None) -> dict:
    """--set поле=значение → словарь; даты ГГГГ-ММ-ДД остаются строками."""
    fields = {}
    for pair in pairs or []:
        if "=" not in pair:
            fail(f"--set ожидает поле=значение, получено «{pair}»")
        key, value = pair.split("=", 1)
        fields[key.strip()] = value.strip() if len(value.strip()) == 10 and value.strip()[4] == "-" else parse_value(value.strip())
    return fields


def check_date(value: str | None, name: str) -> None:
    if value:
        try:
            dt.date.fromisoformat(value)
        except ValueError:
            fail(f"{name}: дата в формате ГГГГ-ММ-ДД")


def describe_product(p: dict) -> str:
    valuation = p.get("valuation") or {}
    value = "цена недоступна" if valuation.get("priceUnavailable") else money(valuation.get("value"))
    return f"«{p['name']}» ({p.get('type')}, {p.get('institution', '')}): оценка {value}, вложено {money(p.get('invested'), p.get('currency', 'RUB'))}"


def cmd_product(args) -> None:
    p = find_product(args.query, include_closed=True)
    if args.json:
        return print(json.dumps(p, ensure_ascii=False, indent=2))
    fields = [
        ("Тип", p.get("type")), ("Где", p.get("institution")), ("Тикер", p.get("ticker")), ("ISIN", p.get("isin")),
        ("Количество", p.get("quantity")), ("Средняя цена", p.get("averagePrice")), ("Текущая цена", p.get("currentPrice")),
        ("Ставка, %", p.get("rate")), ("Купон, %", p.get("couponRate")), ("Открыт", date_ru(p.get("date") or None)),
        ("Окончание", date_ru(p.get("termEndDate"))) if p.get("termEndDate") else ("Погашение", date_ru(p.get("maturityDate")) if p.get("maturityDate") else None),
        ("Закрыт", date_ru(p.get("closedOn")) if p.get("closedOn") else None), ("Источник", p.get("source")),
    ]
    valuation = p.get("valuation") or {}
    print(describe_product(p))
    print(f"Результат: {money(valuation.get('pnl'))} ({percent(valuation.get('pnlPercent'))})")
    for label, value in fields:
        if value not in (None, "", "—"):
            print(f"{label}: {number(value) if isinstance(value, float) else value}")
    print(f"id: {p['id']}")


def cmd_add(args) -> None:
    check_date(args.date, "--date")
    body = {"type": API_TYPES[args.type], **parse_fields(args.set)}
    for key, value in (("name", args.name), ("institution", args.bank), ("amount", args.amount), ("date", args.date),
                       ("ticker", args.ticker), ("quantity", args.quantity), ("averagePrice", args.price),
                       ("currency", args.currency.upper() if args.currency else None)):
        if value is not None:
            body[key] = value
    if args.dry_run:
        return print(json.dumps(body, ensure_ascii=False, indent=2))
    created = api("POST", "/positions", body)
    print(f"Добавлен {describe_product(created)}." + (f" Позиция сразу закрыта {date_ru(created['closedOn'])} — срок уже прошёл." if created.get("closedOn") else ""))


def cmd_edit(args) -> None:
    p = find_product(args.query, include_closed=True)
    body = parse_fields(args.set)
    if not body:
        fail("нечего менять — укажите --set поле=значение")
    if args.dry_run:
        changes = ", ".join(f"{key}: {p.get(key)!r} → {value!r}" for key, value in body.items())
        return print(f"Будет изменён «{p['name']}» (id {p['id']}): {changes}")
    updated = api("PATCH", f"/positions/{p['id']}", body)
    print(f"Изменён {describe_product(updated)}.")


def cmd_delete(args) -> None:
    p = find_product(args.query, include_closed=True)
    if args.dry_run:
        return print(f"Будет удалён {describe_product(p)} (id {p['id']}) вместе с его операциями и выплатами.")
    api("DELETE", f"/positions/{p['id']}")
    print(f"Удалён «{p['name']}» ({p.get('institution', '')}) с его операциями и выплатами.")


def cmd_operations(args) -> None:
    items = api("GET", f"/transactions?limit={args.limit}")
    if args.json:
        return print(json.dumps(items, ensure_ascii=False, indent=2))
    if not items:
        return print("Операций нет.")
    for t in items[: args.limit]:
        kind = OPERATION_TYPES.get(t.get("type"), t.get("type"))
        quantity = f", {number(t['quantity'])} шт." if t.get("quantity") else ""
        print(f"• {date_ru(t['date'])} — {kind}: {t.get('title') or ''} {money(t.get('amount'), t.get('currency', 'RUB'))}{quantity} (id {t['id']})")


def cmd_add_operation(args) -> None:
    check_date(args.date, "--date")
    body = {"type": args.type, "amount": args.amount, "date": args.date}
    if args.product:
        body["positionId"] = find_product(args.product, include_closed=True)["id"]
    for key, value in (("quantity", args.quantity), ("price", args.price), ("commission", args.commission),
                       ("tax", args.tax), ("title", args.title), ("currency", args.currency)):
        if value is not None:
            body[key] = value
    if args.dry_run:
        return print(json.dumps(body, ensure_ascii=False, indent=2))
    created = api("POST", "/transactions", body)
    print(f"Записана операция: {OPERATION_TYPES.get(created['type'], created['type'])} {money(created['amount'], created.get('currency', 'RUB'))} "
          f"от {date_ru(created['date'])} (id {created['id']}).")


def cmd_delete_operation(args) -> None:
    if args.dry_run:
        matches = [t for t in api("GET", "/transactions") if t["id"] == args.id]
        if not matches:
            fail("операция не найдена")
        t = matches[0]
        return print(f"Будет удалена операция {OPERATION_TYPES.get(t['type'], t['type'])} {money(t['amount'], t.get('currency', 'RUB'))} от {date_ru(t['date'])}.")
    api("DELETE", f"/transactions/{args.id}")
    print("Операция удалена.")


def find_expected_payout(query: str, on: str | None) -> dict:
    """Ожидаемая выплата по id или части названия (прогноз пересчитывается при любой правке,
    поэтому id из старого вывода `payouts` может уже не существовать)."""
    payouts = [p for p in api("GET", "/payouts") if p.get("status") == "expected"]
    exact = [p for p in payouts if p["id"] == query]
    if exact:
        return exact[0]
    needle = query.lower()
    today = dt.date.today().isoformat()
    found = [p for p in payouts if needle in (p.get("title") or "").lower() and (p["date"] == on if on else p["date"] <= today)]
    if not found:
        fail(f"ожидаемая выплата «{query}»{' на ' + date_ru(on) if on else ' с наступившей датой'} не найдена — посмотрите `payouts`")
    if len(found) > 1:
        names = "; ".join(f"{date_ru(p['date'])} {p.get('title')} {money(p['amount'], p.get('currency', 'RUB'))}" for p in found)
        fail(f"подходит несколько выплат, уточните дату через --on: {names}")
    return found[0]


def cmd_mark_received(args) -> None:
    check_date(args.on, "--on")
    payout = find_expected_payout(args.query, args.on)
    body = {"status": "received"}
    if args.amount is not None:
        body["amount"] = args.amount
    if args.date:
        check_date(args.date, "--date")
        body["date"] = args.date
    if args.dry_run:
        return print(f"Будет отмечено полученным: {payout.get('title')} {money(args.amount or payout['amount'], payout.get('currency', 'RUB'))} "
                     f"от {date_ru(args.date or payout['date'])}.")
    updated = api("PATCH", f"/payouts/{payout['id']}", body)
    print(f"Отмечено полученным: {updated.get('title')} {money(updated['amount'], updated.get('currency', 'RUB'))} от {date_ru(updated['date'])}.")


def cmd_add_payout(args) -> None:
    check_date(args.date, "--date")
    body = {"title": args.title, "amount": args.amount, "date": args.date, "type": args.type, "status": args.status}
    if args.product:
        body["positionId"] = find_product(args.product, include_closed=True)["id"]
    if args.dry_run:
        return print(json.dumps(body, ensure_ascii=False, indent=2))
    created = api("POST", "/payouts", body)
    print(f"Добавлена выплата: {created.get('title')} {money(created['amount'], created.get('currency', 'RUB'))} от {date_ru(created['date'])} (id {created['id']}).")


def cmd_delete_payout(args) -> None:
    if args.dry_run:
        return print(f"Будет удалена выплата {args.id}.")
    api("DELETE", f"/payouts/{args.id}")
    print("Выплата удалена.")


def cmd_sync(args) -> None:
    result = api("POST", "/brokers/tinkoff/sync")
    print(result.get("message") or "Синхронизация завершена.")


def cmd_refresh_prices(args) -> None:
    result = api("POST", "/market-data/refresh")
    print(f"Цены обновлены: {result.get('updated', 0)} из {result.get('checked', 0)} бумаг.")


def cmd_notifications(args) -> None:
    body = {}
    if args.enable or args.disable:
        current = api("GET", "/integrations/hermes/notifications")
        events = [kind for kind in current["events"] if kind not in (args.disable or [])]
        events += [kind for kind in args.enable or [] if kind not in events]
        body["events"] = events
    if args.hour is not None:
        body["sendHour"] = args.hour
    settings = api("PATCH", "/integrations/hermes/notifications", body) if body else api("GET", "/integrations/hermes/notifications")
    if args.json:
        return print(json.dumps(settings, ensure_ascii=False, indent=2))
    state = "включены" if settings.get("enabled") else "выключены"
    print(f"Уведомления {state}, сводка раз в день в {settings['sendHour']:02d}:00 по Москве.")
    for kind, title in NOTIFICATION_KINDS.items():
        print(f"{'✓' if kind in settings['events'] else '·'} {kind} — {title}")


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

    product = sub.add_parser("product", help="карточка продукта по id или части названия")
    product.add_argument("query")
    product.add_argument("--json", action="store_true")
    product.set_defaults(handler=cmd_product)

    add = sub.add_parser("add", help="добавить продукт любого типа")
    add.add_argument("--type", required=True, choices=sorted(API_TYPES))
    add.add_argument("--name", help="название (для бумаги по тикеру можно не указывать)")
    add.add_argument("--bank", help="банк или брокер")
    add.add_argument("--amount", type=float, help="сумма (для бумаги по тикеру считается сама)")
    add.add_argument("--date", help="дата покупки/открытия, ГГГГ-ММ-ДД")
    add.add_argument("--ticker", help="тикер или ISIN бумаги на Мосбирже")
    add.add_argument("--quantity", type=float, help="количество бумаг")
    add.add_argument("--price", type=float, help="цена покупки одной бумаги")
    add.add_argument("--currency")
    add.add_argument("--set", action="append", metavar="поле=значение", help="любое другое поле (rate, couponRate, maturityDate, nominal…)")
    add.add_argument("--dry-run", action="store_true")
    add.set_defaults(handler=cmd_add)

    edit = sub.add_parser("edit", help="изменить продукт")
    edit.add_argument("query", help="id или часть названия")
    edit.add_argument("--set", action="append", metavar="поле=значение", required=True)
    edit.add_argument("--dry-run", action="store_true")
    edit.set_defaults(handler=cmd_edit)

    delete = sub.add_parser("delete", help="удалить продукт с его операциями и выплатами")
    delete.add_argument("query", help="id или часть названия")
    delete.add_argument("--dry-run", action="store_true")
    delete.set_defaults(handler=cmd_delete)

    operations = sub.add_parser("operations", help="последние операции")
    operations.add_argument("--limit", type=int, default=20)
    operations.add_argument("--json", action="store_true")
    operations.set_defaults(handler=cmd_operations)

    operation = sub.add_parser("add-operation", help="записать операцию")
    operation.add_argument("--type", required=True, type=str.upper, choices=["BUY", "SELL", "COUPON", "DIVIDEND", "INTEREST", "FEE", "TAX", "REDEMPTION", "OTHER"])
    operation.add_argument("--amount", type=float, required=True, help="сумма операции")
    operation.add_argument("--date", required=True, help="ГГГГ-ММ-ДД, не в будущем")
    operation.add_argument("--product", help="id или часть названия (обязательно для покупки и продажи)")
    operation.add_argument("--quantity", type=float)
    operation.add_argument("--price", type=float)
    operation.add_argument("--commission", type=float)
    operation.add_argument("--tax", type=float)
    operation.add_argument("--title")
    operation.add_argument("--currency")
    operation.add_argument("--dry-run", action="store_true")
    operation.set_defaults(handler=cmd_add_operation)

    delete_operation = sub.add_parser("delete-operation", help="удалить операцию")
    delete_operation.add_argument("id")
    delete_operation.add_argument("--dry-run", action="store_true")
    delete_operation.set_defaults(handler=cmd_delete_operation)

    received = sub.add_parser("mark-received", help="отметить выплату полученной")
    received.add_argument("query", help="id или часть названия выплаты")
    received.add_argument("--on", help="дата ожидаемой выплаты, если по названию подходит несколько")
    received.add_argument("--amount", type=float, help="если пришло не столько, сколько ожидалось")
    received.add_argument("--date", help="если пришло в другой день, ГГГГ-ММ-ДД")
    received.add_argument("--dry-run", action="store_true")
    received.set_defaults(handler=cmd_mark_received)

    payout = sub.add_parser("add-payout", help="добавить выплату")
    payout.add_argument("--title", required=True)
    payout.add_argument("--amount", type=float, required=True)
    payout.add_argument("--date", required=True)
    payout.add_argument("--type", type=str.upper, default="OTHER", choices=sorted(PAYOUT_KINDS))
    payout.add_argument("--status", default="expected", choices=["expected", "received"])
    payout.add_argument("--product", help="id или часть названия")
    payout.add_argument("--dry-run", action="store_true")
    payout.set_defaults(handler=cmd_add_payout)

    delete_payout = sub.add_parser("delete-payout", help="удалить выплату")
    delete_payout.add_argument("id")
    delete_payout.add_argument("--dry-run", action="store_true")
    delete_payout.set_defaults(handler=cmd_delete_payout)

    sync = sub.add_parser("sync", help="синхронизировать Т-Инвестиции")
    sync.set_defaults(handler=cmd_sync)

    prices = sub.add_parser("refresh-prices", help="обновить цены бумаг с Мосбиржи")
    prices.set_defaults(handler=cmd_refresh_prices)

    notifications = sub.add_parser("notifications", help="что и во сколько присылать")
    notifications.add_argument("--enable", nargs="+", choices=sorted(NOTIFICATION_KINDS))
    notifications.add_argument("--disable", nargs="+", choices=sorted(NOTIFICATION_KINDS))
    notifications.add_argument("--hour", type=int, help="час сводки по Москве, 6–21")
    notifications.add_argument("--json", action="store_true")
    notifications.set_defaults(handler=cmd_notifications)

    args = parser.parse_args()
    args.handler(args)


if __name__ == "__main__":
    main()
