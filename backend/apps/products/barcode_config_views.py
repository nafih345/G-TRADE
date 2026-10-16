"""GET/PUT /api/products/barcode-config/ — the product barcode series definition
(BarcodeSeriesConfig): prefix pattern, total digits, check digit and next number.

PUT with {"dry_run": true} validates and returns the preview without saving, so
the editor can show sample codes while the user types."""
from django.db import transaction
from rest_framework import serializers
from rest_framework.response import Response
from rest_framework.views import APIView

from .barcode_utils import BarcodeConfigError, preview_series
from .label_views import DesignerWritePermission, _actor
from .models import BarcodeSeriesConfig


class BarcodeSeriesConfigSerializer(serializers.Serializer):
    prefix_pattern = serializers.CharField(max_length=40, allow_blank=True, required=False)
    total_length = serializers.IntegerField(required=False)
    check_digit = serializers.ChoiceField(choices=['MOD10', 'NONE'], required=False)
    next_number = serializers.IntegerField(min_value=1, required=False)

    def validate(self, attrs):
        cfg = self.instance
        merged = {
            'prefix_pattern': attrs.get('prefix_pattern', cfg.prefix_pattern).strip().upper(),
            'total_length': attrs.get('total_length', cfg.total_length),
            'check_digit': attrs.get('check_digit', cfg.check_digit),
            'next_number': attrs.get('next_number', cfg.last_number + 1),
        }
        try:
            merged['preview'] = preview_series(**merged)
        except BarcodeConfigError as e:
            raise serializers.ValidationError({'detail': str(e.detail)})
        if not merged['preview']['samples']:
            raise serializers.ValidationError({'detail': (
                f"Next number {merged['next_number']} doesn't fit in the "
                f"{merged['preview']['sequence_digits']}-digit running number.")})
        return merged


def config_payload(cfg, preview=None):
    next_number = cfg.last_number + 1
    if preview is None:
        try:
            preview = preview_series(cfg.prefix_pattern, cfg.total_length, cfg.check_digit, next_number)
        except BarcodeConfigError as e:
            preview = {'error': str(e.detail), 'samples': []}
    return {
        'prefix_pattern': cfg.prefix_pattern,
        'total_length': cfg.total_length,
        'check_digit': cfg.check_digit,
        'next_number': next_number,
        'last_number': cfg.last_number,
        'preview': preview,
        'updated_at': cfg.updated_at,
        'updated_by_name': cfg.updated_by_name,
    }


class BarcodeSeriesConfigView(APIView):
    permission_classes = [DesignerWritePermission]

    def get(self, request):
        return Response(config_payload(BarcodeSeriesConfig.load()))

    def put(self, request):
        cfg = BarcodeSeriesConfig.load()
        ser = BarcodeSeriesConfigSerializer(cfg, data=request.data, partial=True)
        ser.is_valid(raise_exception=True)
        data = ser.validated_data
        if request.data.get('dry_run'):
            preview_cfg = BarcodeSeriesConfig(
                prefix_pattern=data['prefix_pattern'], total_length=data['total_length'],
                check_digit=data['check_digit'], last_number=data['next_number'] - 1,
                updated_at=cfg.updated_at, updated_by_name=cfg.updated_by_name)
            return Response(config_payload(preview_cfg, data['preview']))
        with transaction.atomic():
            cfg = BarcodeSeriesConfig.objects.select_for_update().get(pk=cfg.pk)
            cfg.prefix_pattern = data['prefix_pattern']
            cfg.total_length = data['total_length']
            cfg.check_digit = data['check_digit']
            # Only move the counter when the user actually changed it, so a save
            # never rewinds numbers minted by someone else meanwhile.
            if 'next_number' in request.data:
                cfg.last_number = data['next_number'] - 1
            cfg.updated_by_name = _actor(request)
            cfg.save()
        return Response(config_payload(cfg))

    patch = put
