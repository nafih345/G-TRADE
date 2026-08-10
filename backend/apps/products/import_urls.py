from django.urls import path
from .import_views import (
    start_import,
    get_import_status,
    get_import_rows,
    get_import_errors,
    get_import_history,
    handle_import_batch_detail,
    archive_import_batch,
    restore_import_batch,
    download_sample_template,
    export_failed_records_csv
)

urlpatterns = [
    path('upload/', start_import, name='import-upload'),
    path('history/', get_import_history, name='import-history'),
    path('download-template/', download_sample_template, name='import-template'),
    path('<uuid:pk>/', handle_import_batch_detail, name='import-detail'),
    path('<uuid:pk>/status/', get_import_status, name='import-status'),
    path('<uuid:pk>/rows/', get_import_rows, name='import-rows'),
    path('<uuid:pk>/errors/', get_import_errors, name='import-errors'),
    path('<uuid:pk>/export-failed/', export_failed_records_csv, name='import-export-failed'),
    path('<uuid:pk>/archive/', archive_import_batch, name='import-archive'),
    path('<uuid:pk>/restore/', restore_import_batch, name='import-restore'),
]
