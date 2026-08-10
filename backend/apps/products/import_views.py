import datetime
import threading
import uuid

from rest_framework import status, permissions
from rest_framework.decorators import api_view, permission_classes, authentication_classes
from rest_framework.response import Response
from rest_framework.pagination import PageNumberPagination
from django.db import models, connection, transaction
from django.core.management import call_command
from django.http import HttpResponse
from .models import Product, ImportBatch, ImportErrorLog
from . import import_engine

from django.contrib.auth import get_user_model
from apps.company.models import Company, Branch, Warehouse, Notification
from apps.masters.models import ProductCategory, Brand, Unit, Tax, StorageRack


def ensure_import_tables_exist():
    try:
        tables = connection.introspection.table_names()
        needed = ['authentication_user', 'masters_unit', 'masters_brand', 'masters_productcategory', 'masters_tax', 'products_importbatch', 'products_product']
        if any(t not in tables for t in needed):
            try:
                call_command('migrate', interactive=False)
            except Exception:
                pass

        tables_now = connection.introspection.table_names()
        models_to_create = [
            ('authentication_user', get_user_model()),
            ('company_company', Company),
            ('company_branch', Branch),
            ('company_warehouse', Warehouse),
            ('company_notification', Notification),
            ('masters_productcategory', ProductCategory),
            ('masters_brand', Brand),
            ('masters_unit', Unit),
            ('masters_tax', Tax),
            ('masters_storagerack', StorageRack),
            ('products_importbatch', ImportBatch),
            ('products_importerrorlog', ImportErrorLog),
            ('products_product', Product)
        ]

        with connection.schema_editor() as schema_editor:
            for tbl_name, model_cls in models_to_create:
                if tbl_name not in connection.introspection.table_names():
                    try:
                        schema_editor.create_model(model_cls)
                    except Exception as me:
                        print(f"Notice creating {tbl_name}:", me)
    except Exception as e:
        print("Schema sync notice:", e)


class ImportRowsPagination(PageNumberPagination):
    page_size = 100
    page_size_query_param = 'page_size'
    max_page_size = 500


def _batch_summary(b):
    return {
        'id': str(b.id),
        'batch_number': b.batch_number,
        'file_name': b.file_name,
        'original_file_name': b.original_file_name or b.file_name,
        'uploaded_by': b.uploaded_by,
        'uploaded_date': b.uploaded_date.strftime('%Y-%m-%d %H:%M:%S') if b.uploaded_date else '',
        'status': b.status,
        'duplicate_strategy': b.duplicate_strategy,
        'total_rows': b.total_rows,
        'processed_rows': b.processed_rows,
        'imported_rows': b.imported_rows,
        'failed_rows': b.failed_rows,
        'duplicate_rows': b.duplicate_rows,
        'processing_time': b.processing_time,
        'version': b.version,
        'remarks': b.remarks,
        'logs': b.logs or [],
        'column_headers': b.column_headers or [],
    }


@api_view(['POST'])
@authentication_classes([])
@permission_classes([permissions.AllowAny])
def start_import(request):
    """
    Saves the uploaded file, creates an ImportBatch, and starts a background
    thread that streams + chunk-imports it. Returns immediately — the browser
    never waits for the import itself, only for the upload to be accepted.
    """
    ensure_import_tables_exist()
    file_obj = request.FILES.get('file')
    if not file_obj:
        return Response({'error': 'No file uploaded. Please select an Excel or CSV file.'}, status=status.HTTP_400_BAD_REQUEST)

    ext = import_engine.detect_ext(file_obj.name)
    if ext is None:
        return Response({'error': 'Unsupported file format. Please upload .xlsx, .xls, or .csv'}, status=status.HTTP_400_BAD_REQUEST)

    duplicate_strategy = request.data.get('duplicate_strategy', 'UPDATE')
    if duplicate_strategy not in ('SKIP', 'UPDATE', 'REPLACE', 'DUPLICATE'):
        duplicate_strategy = 'UPDATE'

    uploaded_by = request.data.get('uploaded_by', 'Administrator')
    batch_num = f"BATCH-{datetime.datetime.now().strftime('%Y%m%d')}-{uuid.uuid4().hex[:6].upper()}"

    with transaction.atomic():
        batch = ImportBatch.objects.create(
            batch_number=batch_num,
            file=file_obj,
            file_name=file_obj.name,
            original_file_name=file_obj.name,
            uploaded_by=uploaded_by,
            status='PENDING',
            duplicate_strategy=duplicate_strategy,
            remarks='Queued for background import.'
        )
        transaction.on_commit(
            lambda: threading.Thread(target=import_engine.run_import_job, args=(batch.id,), daemon=True).start()
        )

    return Response({
        'batch_id': str(batch.id),
        'batch_number': batch.batch_number,
        'status': batch.status
    }, status=status.HTTP_202_ACCEPTED)


@api_view(['GET'])
@authentication_classes([])
@permission_classes([permissions.AllowAny])
def get_import_status(request, pk):
    """Lightweight polling endpoint — just the progress counters, no row data."""
    try:
        batch = ImportBatch.objects.get(id=pk)
    except ImportBatch.DoesNotExist:
        return Response({'error': 'Import batch not found.'}, status=status.HTTP_404_NOT_FOUND)
    return Response(_batch_summary(batch))


@api_view(['GET'])
@authentication_classes([])
@permission_classes([permissions.AllowAny])
def get_import_rows(request, pk):
    """Paginated + searched product rows belonging to one import batch."""
    try:
        batch = ImportBatch.objects.get(id=pk)
    except ImportBatch.DoesNotExist:
        return Response({'error': 'Import batch not found.'}, status=status.HTTP_404_NOT_FOUND)

    qs = Product.objects.filter(import_batch=batch).order_by('name')
    search = request.query_params.get('search', '').strip()
    if search:
        qs = qs.filter(
            models.Q(name__icontains=search) | models.Q(sku__icontains=search) |
            models.Q(barcode__icontains=search) | models.Q(brand_name__icontains=search) |
            models.Q(category_name__icontains=search) | models.Q(supplier_name__icontains=search)
        )

    paginator = ImportRowsPagination()
    page = paginator.paginate_queryset(qs, request)
    rows = [{
        'id': str(p.id),
        'sku': p.sku,
        'barcode': p.barcode,
        'name': p.name,
        'category': p.category_name or 'Frames',
        'brand': p.brand_name or 'Generic',
        'supplier': p.supplier_name or '',
        'cost_price': float(p.cost_price),
        'selling_price': float(p.retail_price),
        'stock': p.stock,
        'is_active': p.is_active,
        **(p.extra_data or {}),
    } for p in page]

    response = paginator.get_paginated_response(rows)
    response.data['column_headers'] = batch.column_headers or []
    return response


@api_view(['GET'])
@authentication_classes([])
@permission_classes([permissions.AllowAny])
def get_import_errors(request, pk):
    """Paginated failed-row log for one import batch."""
    try:
        batch = ImportBatch.objects.get(id=pk)
    except ImportBatch.DoesNotExist:
        return Response({'error': 'Import batch not found.'}, status=status.HTTP_404_NOT_FOUND)

    qs = batch.error_logs.all().order_by('row_number')
    paginator = ImportRowsPagination()
    page = paginator.paginate_queryset(qs, request)
    rows = [{
        'id': str(err.id),
        'row_number': err.row_number,
        'product_code': err.product_code,
        'product_name': err.product_name,
        'error_type': err.error_type,
        'error_message': err.error_message,
        'raw_data': err.raw_data or {},
    } for err in page]
    return paginator.get_paginated_response(rows)


@api_view(['GET'])
@authentication_classes([])
@permission_classes([permissions.AllowAny])
def get_import_history(request):
    """
    Retrieve all active Import Batches tracked in PostgreSQL
    """
    ensure_import_tables_exist()
    try:
        # Purge any legacy marked-deleted batch records from database
        ImportBatch.objects.filter(is_deleted=True).delete()
        ImportBatch.objects.filter(status='DELETED').delete()

        batches = ImportBatch.objects.filter(is_deleted=False).exclude(status='DELETED').order_by('-uploaded_date')
        return Response([_batch_summary(b) for b in batches])
    except Exception as e:
        print("Notice getting import history:", e)
        return Response([])


@api_view(['GET', 'DELETE'])
@authentication_classes([])
@permission_classes([permissions.AllowAny])
def handle_import_batch_detail(request, pk):
    """
    GET: batch metadata only (use /rows/ and /errors/ for the actual record lists)
    DELETE: permanently deletes the ImportBatch metadata record:
            - option1: Delete ImportBatch record ONLY, keep PostgreSQL products
            - option2: Delete ImportBatch AND delete associated products from PostgreSQL
    """
    try:
        batch = ImportBatch.objects.get(id=pk)
    except ImportBatch.DoesNotExist:
        return Response({'error': 'Import batch not found.'}, status=status.HTTP_404_NOT_FOUND)

    if request.method == 'GET':
        return Response(_batch_summary(batch))

    elif request.method == 'DELETE':
        delete_mode = request.query_params.get('delete_mode', 'option2') # option1 vs option2
        batch_number = batch.batch_number

        try:
            with transaction.atomic():
                batch_products = Product.all_objects.filter(models.Q(import_batch=batch) | models.Q(extra_data__batch_number=batch_number))
                deleted_skus = list(batch_products.values_list('sku', flat=True))
                deleted_ids = [str(pid) for pid in batch_products.values_list('id', flat=True)]

                if delete_mode == 'option1':
                    # Option 1: Remove ImportBatch record from DB, retain product records in PostgreSQL
                    batch_products.update(import_batch=None)
                    ImportErrorLog.objects.filter(batch=batch).delete()
                    batch.delete()
                    return Response({
                        'message': f'Import batch {batch_number} permanently deleted from database. Products retained.',
                        'deleted_product_skus': [],
                        'deleted_product_ids': []
                    })
                else:
                    # Option 2: Remove ImportBatch AND hard delete imported products from PostgreSQL
                    ImportErrorLog.objects.filter(batch=batch).delete()

                    try:
                        batch_products.hard_delete()
                    except Exception as pe:
                        print("Products hard delete notice:", pe)
                        batch_products.delete()

                    # Delete the ImportBatch metadata record permanently from PostgreSQL
                    batch.delete()
                    return Response({
                        'message': f'Successfully deleted import batch {batch_number} and permanently removed products from database.',
                        'deleted_product_skus': deleted_skus,
                        'deleted_product_ids': deleted_ids
                    })
        except Exception as e:
            # Emergency cleanup fallback: force delete batch & error logs, unlink products
            try:
                batch_products = Product.all_objects.filter(models.Q(import_batch=batch) | models.Q(extra_data__batch_number=batch_number))
                deleted_skus = list(batch_products.values_list('sku', flat=True))
                deleted_ids = [str(pid) for pid in batch_products.values_list('id', flat=True)]

                if delete_mode == 'option2':
                    try:
                        batch_products.hard_delete()
                    except Exception:
                        batch_products.delete()
                else:
                    batch_products.update(import_batch=None)

                ImportErrorLog.objects.filter(batch=batch).delete()
                batch.delete()
                return Response({
                    'message': f'Import batch {batch_number} permanently removed from database.',
                    'deleted_product_skus': deleted_skus,
                    'deleted_product_ids': deleted_ids
                })
            except Exception as final_err:
                return Response({'error': f'Failed to delete import batch: {str(final_err)}'}, status=status.HTTP_400_BAD_REQUEST)


@api_view(['GET'])
@authentication_classes([])
@permission_classes([permissions.AllowAny])
def export_failed_records_csv(request, pk):
    """
    Exports failed records for a specific import batch as downloadable CSV file
    """
    try:
        batch = ImportBatch.objects.get(id=pk)
    except ImportBatch.DoesNotExist:
        return Response({'error': 'Import batch not found.'}, status=status.HTTP_404_NOT_FOUND)

    failed_logs = batch.error_logs.all()

    csv_rows = ["Row Number,Product Code,Product Name,Error Reason,Raw Data JSON\n"]
    for f in failed_logs:
        raw_json_str = str(f.raw_data).replace('"', '""') if f.raw_data else ""
        csv_rows.append(f'{f.row_number},"{f.product_code or ""}","{f.product_name or ""}","{f.error_message}","{raw_json_str}"\n')

    response = HttpResponse("".join(csv_rows), content_type='text/csv')
    response['Content-Disposition'] = f'attachment; filename="Failed_Records_{batch.batch_number}.csv"'
    return response


@api_view(['POST'])
@authentication_classes([])
@permission_classes([permissions.AllowAny])
def archive_import_batch(request, pk):
    try:
        batch = ImportBatch.objects.get(id=pk)
        Product.objects.filter(import_batch=batch).update(is_active=False)
        batch.status = 'ARCHIVED'
        batch.save()
        return Response({'message': f'Import batch {batch.batch_number} archived. All products deactivated.'})
    except ImportBatch.DoesNotExist:
        return Response({'error': 'Import batch not found.'}, status=status.HTTP_404_NOT_FOUND)


@api_view(['POST'])
@authentication_classes([])
@permission_classes([permissions.AllowAny])
def restore_import_batch(request, pk):
    try:
        batch = ImportBatch.objects.get(id=pk)
        Product.objects.filter(import_batch=batch).update(is_active=True)
        batch.status = 'SUCCESS'
        batch.save()
        return Response({'message': f'Import batch {batch.batch_number} restored. Products reactivated.'})
    except ImportBatch.DoesNotExist:
        return Response({'error': 'Import batch not found.'}, status=status.HTTP_404_NOT_FOUND)


@api_view(['GET'])
@authentication_classes([])
@permission_classes([permissions.AllowAny])
def download_sample_template(request):
    csv_data = (
        "Barcode,SKU/Code,Product Name,Category,Brand,Cost Price (INR),Selling Price (INR),Stock Quantity,Supplier,Rack Location\n"
        "880194821001,FRAME-RB-01,RayBan Wayfarer Classic Black,Frames,RayBan,2500,4990,25,RayBan India,Rack A-1\n"
        "880194821002,LENS-CRZ-02,Crizal Prevencia Anti-Blue 1.56,Prescription Lenses,Crizal,1200,2800,50,Essilor India,Rack B-3\n"
        "880194821003,SUN-OAK-03,Oakley Holbrook Polarized Matte Black,Sunglasses,Oakley,4500,8990,12,Oakley Distr,Rack A-4\n"
    )
    response = HttpResponse(csv_data, content_type='text/csv')
    response['Content-Disposition'] = 'attachment; filename="Optical_Stock_Import_Template.csv"'
    return response
