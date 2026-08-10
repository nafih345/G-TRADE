from rest_framework import viewsets, permissions, status
from rest_framework.decorators import action
from rest_framework.response import Response
from django.db.models import ProtectedError
from .models import AccountGroup, ChartOfAccount, VoucherType, JournalEntry, LedgerEntry
from .serializers import AccountGroupSerializer, ChartOfAccountSerializer, VoucherTypeSerializer, JournalEntrySerializer, LedgerEntrySerializer
from .services import reverse_journal_entry

class AccountGroupViewSet(viewsets.ModelViewSet):
    queryset = AccountGroup.objects.all().order_by('name')
    serializer_class = AccountGroupSerializer
    authentication_classes = []
    permission_classes = [permissions.AllowAny]


class ChartOfAccountViewSet(viewsets.ModelViewSet):
    queryset = ChartOfAccount.objects.filter(is_deleted=False).order_by('code')
    serializer_class = ChartOfAccountSerializer
    authentication_classes = []
    permission_classes = [permissions.AllowAny]

    def destroy(self, request, *args, **kwargs):
        instance = self.get_object()
        if instance.ledger_entries.exists():
            return Response({
                'error': f"Cannot delete account '{instance.code} - {instance.name}'. This account has linked ledger/journal entries."
            }, status=status.HTTP_400_BAD_REQUEST)

        try:
            instance.is_deleted = True
            instance.save(update_fields=['is_deleted'])
            return Response({'message': f"Account '{instance.code}' deleted successfully."}, status=status.HTTP_200_OK)
        except ProtectedError:
            return Response({
                'error': f"Cannot delete account '{instance.code} - {instance.name}'. This account is protected by existing transactions."
            }, status=status.HTTP_400_BAD_REQUEST)


class VoucherTypeViewSet(viewsets.ModelViewSet):
    queryset = VoucherType.objects.all().order_by('code')
    serializer_class = VoucherTypeSerializer
    authentication_classes = []
    permission_classes = [permissions.AllowAny]


class JournalEntryViewSet(viewsets.ModelViewSet):
    queryset = JournalEntry.objects.all().order_by('-date', '-created_at')
    serializer_class = JournalEntrySerializer
    authentication_classes = []
    permission_classes = [permissions.AllowAny]

    @action(detail=True, methods=['post'])
    def reverse(self, request, pk=None):
        reason = request.data.get('reason', '')
        try:
            reversal = reverse_journal_entry(pk, user=request.user if request.user.is_authenticated else None, reason=reason)
            return Response({
                'message': f"Journal entry reversed successfully.",
                'reversal_entry_number': reversal.entry_number
            }, status=status.HTTP_200_OK)
        except Exception as e:
            return Response({'error': str(e)}, status=status.HTTP_400_BAD_REQUEST)


class LedgerEntryViewSet(viewsets.ReadOnlyModelViewSet):
    queryset = LedgerEntry.objects.all().order_by('-journal_entry__date')
    serializer_class = LedgerEntrySerializer
    authentication_classes = []
    permission_classes = [permissions.AllowAny]
