"""Shared counter bump for the *Sequence tables (patient codes, Test No, supplier codes,
barcodes, journal numbers).

One `UPDATE ... SET last_number = last_number + n ... RETURNING last_number` statement: atomic
on Postgres and on SQLite (where select_for_update() is a silent no-op — the desktop build runs
on SQLite), and a single round trip to the database. The previous get_or_create-then-update
shape cost a SELECT and two savepoints more on every number handed out, each a network round
trip on the hosted database. The row is created only the first time, when the UPDATE finds none.
"""
from django.db import IntegrityError, connection, transaction


def bump_sequence(model, lookup, count=1, defaults=None):
    """Add `count` to `last_number` on the `model` row matching `lookup` (field -> value) and
    return the new last_number, creating the row with `defaults` if it doesn't exist yet."""
    qn = connection.ops.quote_name
    where = ' AND '.join(f"{qn(model._meta.get_field(name).column)} = %s" for name in lookup)
    sql = (f"UPDATE {qn(model._meta.db_table)} SET last_number = last_number + %s "
           f"WHERE {where} RETURNING last_number")
    params = [count, *lookup.values()]

    def bump():
        with connection.cursor() as cursor:
            cursor.execute(sql, params)
            row = cursor.fetchone()
        return row[0] if row else None

    new_last = bump()
    if new_last is None:
        try:
            with transaction.atomic():
                model.objects.get_or_create(**lookup, defaults=defaults or {})
        except IntegrityError:
            pass  # created concurrently — the retry below sees it
        new_last = bump()
    return new_last
