"""Spectacle-lens selling units: Both Eyes (1 Pair = 2 lenses) or Single Lens (1 Piece = 1 lens).

A lens sales line keeps two quantities apart:

* commercial — `InvoiceItem.quantity` in the line's `selling_unit` (what is priced and billed);
* physical — `InvoiceItem.physical_quantity`, the number of lenses (pairs × 2, pieces × 1).

Stock moves in the product's own stock unit (Product.extra_data['lens_stock_unit'], PAIR unless
set to PIECE — every lens sold before this existed deducted its line quantity, i.e. one stock
unit per pair). The unit is snapshotted onto the line (lens_details['stock_unit']) so an edit or a
return of an old line moves stock exactly the way the sale did. Stock is an integer, so lenses of
a pair-stocked product sold singly are added up per product per bill and rounded UP to whole pairs
(a pair broken to sell one lens leaves the shelf) — see stock_units_by_product.

The prescription rules here are mirrored in frontend/src/utils/lensUnits.js.
"""
import math
from decimal import Decimal, InvalidOperation

from rest_framework import serializers

PAIR, PIECE = 'PAIR', 'PIECE'
SELLING_UNITS = (PAIR, PIECE)
BOTH, RE, LE = 'BOTH', 'RE', 'LE'
PIECES_PER_UNIT = {PAIR: 2, PIECE: 1}

EYE_FIELDS = ('sph', 'cyl', 'axis', 'add', 'prism', 'base')
PLANO = {'PL', 'PLANO', 'PLANO.', 'INFINITY', '∞'}
BASES = {'IN': 'IN', 'BI': 'IN', 'OUT': 'OUT', 'BO': 'OUT', 'UP': 'UP', 'BU': 'UP', 'DOWN': 'DOWN', 'BD': 'DOWN'}
ONE_EYE_MESSAGE = ("Only one eye's prescription has been entered. "
                   "Please complete both eyes or select Single Lens.")
EYE_NAME = {RE: 'Right eye (RE)', LE: 'Left eye (LE)'}


def physical_quantity(selling_unit, quantity):
    return max(0, int(quantity or 0)) * PIECES_PER_UNIT.get(selling_unit, 1)


def _blank(value):
    return value is None or str(value).strip() == ''


def _number(value):
    s = str(value).strip().replace(' ', '')
    if s.upper() in PLANO:
        return Decimal('0')
    try:
        return Decimal(s)
    except InvalidOperation:
        return None


def _quarter(d):
    return (d * 4) == (d * 4).to_integral_value()


def eye_entered(eye):
    return any(not _blank((eye or {}).get(f)) for f in EYE_FIELDS if f != 'base')


def eye_value_errors(eye, label):
    """Format / range problems with one eye's values (blank fields are not errors here)."""
    eye = eye or {}
    errors = []

    def dioptre(field, name, lo, hi):
        raw = eye.get(field)
        if _blank(raw):
            return None
        d = _number(raw)
        if d is None:
            errors.append(f'{label} {name} "{raw}" is not a number (e.g. -2.50, +1.25).')
        elif not lo <= d <= hi:
            errors.append(f'{label} {name} {raw} is outside {lo:+} to {hi:+}.')
        elif not _quarter(d):
            errors.append(f'{label} {name} {raw} must be in 0.25 steps.')
        return d

    dioptre('sph', 'SPH', Decimal('-30'), Decimal('30'))
    cyl = dioptre('cyl', 'CYL', Decimal('-10'), Decimal('10'))
    add = dioptre('add', 'ADD', Decimal('0'), Decimal('4'))
    if add is not None and add < 0:
        errors.append(f'{label} ADD cannot be negative.')

    axis_raw = eye.get('axis')
    if not _blank(axis_raw):
        try:
            axis = int(str(axis_raw).strip())
            if not 0 <= axis <= 180:
                errors.append(f'{label} AXIS {axis_raw} must be between 0 and 180.')
        except ValueError:
            errors.append(f'{label} AXIS "{axis_raw}" must be a whole number (0-180).')
    elif cyl is not None and cyl != 0:
        errors.append(f'{label} AXIS is required when CYL is entered.')

    prism_raw = eye.get('prism')
    if not _blank(prism_raw):
        prism = _number(prism_raw)
        if prism is None or not Decimal('0') <= prism <= Decimal('20'):
            errors.append(f'{label} PRISM "{prism_raw}" must be a number from 0 to 20.')
        elif prism > 0 and str(eye.get('base') or '').strip().upper() not in BASES:
            errors.append(f'{label} BASE (IN / OUT / UP / DOWN) is required with a prism.')
    return errors


def line_errors(selling_unit, eye_choice, rx, require_complete):
    """Every problem with one lens line. `require_complete` is False for quotations, where an
    estimate may be given before the prescription is known (values entered must still be valid)."""
    rx = rx or {}
    re_rx, le_rx = rx.get('re') or {}, rx.get('le') or {}
    errors = []
    if selling_unit not in SELLING_UNITS:
        return [f'Unknown lens selling unit "{selling_unit}" (expected PAIR or PIECE).']
    if selling_unit == PIECE and eye_choice not in (RE, LE):
        errors.append('Single Lens: select the eye — Right (RE) or Left (LE).')
    if selling_unit == PAIR and eye_choice not in ('', BOTH):
        errors.append('A pair covers both eyes — the eye must be BOTH.')

    required = (RE, LE) if selling_unit == PAIR else ((eye_choice,) if eye_choice in (RE, LE) else ())
    for key in required:
        eye = re_rx if key == RE else le_rx
        errors += eye_value_errors(eye, EYE_NAME[key])
    if not require_complete:
        return errors

    if selling_unit == PAIR:
        entered = [eye_entered(re_rx), eye_entered(le_rx)]
        if entered.count(True) == 1:
            errors.append(ONE_EYE_MESSAGE)
            return errors
        if not any(entered):
            errors.append('Enter the prescription for both eyes (RE and LE), or select Single Lens.')
            return errors
    for key in required:
        eye = re_rx if key == RE else le_rx
        if _blank(eye.get('sph')):
            errors.append(f'{EYE_NAME[key]} SPH is required (enter 0.00 or PL for plano).')
    return errors


def clean_lens_line(raw, requires_complete):
    """Validated lens fields for one raw request line, or None when it isn't a lens-unit line.
    Raises a ValidationError naming the line on any problem."""
    unit = str(raw.get('selling_unit') or '').upper()
    if not unit:
        return None
    eye = str(raw.get('lens_eye') or '').upper()
    if unit == PAIR and not eye:
        eye = BOTH
    details = raw.get('lens_details') if isinstance(raw.get('lens_details'), dict) else {}
    rx = details.get('rx') if isinstance(details.get('rx'), dict) else {}
    problems = line_errors(unit, eye, rx, requires_complete)
    if problems:
        name = raw.get('description') or raw.get('name') or 'Lens'
        raise serializers.ValidationError({'items': [f'{name}: {p}' for p in problems]})
    pricing_unit = str(raw.get('pricing_unit') or unit).upper()
    if pricing_unit not in SELLING_UNITS:
        pricing_unit = unit
    try:
        quantity = int(raw.get('quantity') or raw.get('qty') or 1)
    except (TypeError, ValueError):
        raise serializers.ValidationError({'items': ['Quantity must be a whole number.']})
    if quantity < 1:
        raise serializers.ValidationError({'items': ['Lens quantity must be at least 1.']})
    return {
        'selling_unit': unit,
        'lens_eye': eye,
        'pricing_unit': pricing_unit,
        # Recomputed here, never trusted from the client.
        'physical_quantity': physical_quantity(unit, quantity),
        'lens_details': details,
    }


def stock_units_by_product(items):
    """{product_id: stock units} a bill's lines take out of stock. Lines without a selling unit
    (frames, accessories, every bill from before lens units) count their quantity as before."""
    totals, pair_pieces = {}, {}
    for item in items:
        if not item.product_id:
            continue
        qty = int(item.quantity or 0)
        selling_unit = getattr(item, 'selling_unit', '')
        if selling_unit in SELLING_UNITS:
            pieces = item.physical_quantity if item.physical_quantity is not None \
                else physical_quantity(selling_unit, qty)
            unit = str((item.lens_details or {}).get('stock_unit') or PAIR).upper()
            if unit == PIECE:
                totals[item.product_id] = totals.get(item.product_id, 0) + pieces
            else:
                pair_pieces[item.product_id] = pair_pieces.get(item.product_id, 0) + pieces
        else:
            totals[item.product_id] = totals.get(item.product_id, 0) + qty
    for pk, pieces in pair_pieces.items():
        totals[pk] = totals.get(pk, 0) + math.ceil(pieces / 2)
    return totals


def incomplete_lens_lines(invoice):
    """Messages for lens lines whose prescription isn't complete enough to order / bill."""
    out = []
    for item in invoice.items.all():
        if item.selling_unit in SELLING_UNITS:
            rx = (item.lens_details or {}).get('rx') or {}
            for p in line_errors(item.selling_unit, item.lens_eye or (BOTH if item.selling_unit == PAIR else ''), rx, True):
                out.append(f'{item.description or "Lens"}: {p}')
    return out
