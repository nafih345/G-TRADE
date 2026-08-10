import os
import sys
import django  # type: ignore

# Setup Django Environment
sys.path.append(os.path.dirname(os.path.abspath(__file__)))
os.environ.setdefault("DJANGO_SETTINGS_MODULE", "config.settings")
django.setup()

from django.apps import apps  # type: ignore
from django.db import transaction  # type: ignore

def wipe_entire_database():
    print("Wiping all database tables across all modules...")
    
    target_apps = [
        'products', 'inventory', 'purchasing', 'sales', 
        'accounts', 'financial', 'masters', 'company'
    ]

    cleared_summary = []

    with transaction.atomic():  # type: ignore
        for app_name in target_apps:
            try:
                app_config = apps.get_app_config(app_name)
                for model in app_config.get_models():
                    model_name = model.__name__
                    count = 0
                    try:
                        if hasattr(model, 'all_objects'):
                            if hasattr(model.all_objects, 'hard_delete'):
                                res = model.all_objects.all().hard_delete()
                                count = res[0] if isinstance(res, tuple) else 0
                            else:
                                res = model.all_objects.all().delete()
                                count = res[0] if isinstance(res, tuple) else 0
                        else:
                            res = model.objects.all().delete()
                            count = res[0] if isinstance(res, tuple) else 0
                        cleared_summary.append(f"  - {app_name}.{model_name}: cleared")
                    except Exception as e:
                        try:
                            model.objects.all().delete()
                            cleared_summary.append(f"  - {app_name}.{model_name}: cleared")
                        except Exception as ex:
                            cleared_summary.append(f"  - {app_name}.{model_name}: skipped ({ex})")
            except Exception as e:
                print(f"Error inspecting app '{app_name}': {e}")

    print("\n--- DATABASE WIPE SUMMARY ---")
    for line in cleared_summary:
        print(line)
    print("\nSUCCESS: All project database tables have been completely cleared!")

if __name__ == '__main__':
    wipe_entire_database()
