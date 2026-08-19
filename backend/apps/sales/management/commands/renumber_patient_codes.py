from django.core.management.base import BaseCommand
from django.db import transaction

from apps.sales.models import Customer, PatientCodeSequence


class Command(BaseCommand):
    help = (
        "Renumbers every active Customer.patient_code sequentially starting at P-1001, "
        "in creation order, closing gaps left by deleted/abandoned records. Also resets "
        "PatientCodeSequence so future auto-generated codes continue right after the new "
        "highest number."
    )

    def add_arguments(self, parser):
        parser.add_argument(
            '--dry-run', action='store_true',
            help="Show what would change without writing anything."
        )

    def handle(self, *args, **options):
        dry_run = options['dry_run']
        customers = list(Customer.objects.all().order_by('created_at'))

        if not customers:
            self.stdout.write("No customers found — nothing to renumber.")
            return

        changes = []
        for i, customer in enumerate(customers):
            new_code = f"P-{1001 + i}"
            if customer.patient_code != new_code:
                changes.append((customer, customer.patient_code, new_code))

        if not changes:
            self.stdout.write("Patient codes are already sequential — nothing to do.")
            return

        self.stdout.write(f"{len(changes)} of {len(customers)} customers will be renumbered:")
        for customer, old_code, new_code in changes:
            self.stdout.write(f"  {old_code or '(blank)'} -> {new_code}   {customer.name}")

        if dry_run:
            self.stdout.write(self.style.WARNING("Dry run — no changes written."))
            return

        with transaction.atomic():
            # Pass 1a: also free up any soft-deleted customer's code — BaseUUIDModel.delete()
            # never removes the row, so a deleted customer's old code still occupies the
            # DB-level UNIQUE constraint and would otherwise collide with a renumbered one.
            Customer.all_objects.filter(is_deleted=True).exclude(patient_code__isnull=True).update(patient_code=None)

            # Pass 1b: clear every target row's code so the unique constraint never sees a
            # collision between an old and a new value while assigning the real ones below.
            for customer, _old_code, _new_code in changes:
                customer.patient_code = None
                customer.save(update_fields=['patient_code'])

            # Pass 2: assign final sequential codes in original creation order.
            for i, customer in enumerate(customers):
                new_code = f"P-{1001 + i}"
                if customer.patient_code != new_code:
                    customer.patient_code = new_code
                    customer.save(update_fields=['patient_code'])

            # Keep the auto-generator's counter in sync so the next new patient continues
            # right after the new highest number instead of colliding with it.
            seq, _ = PatientCodeSequence.objects.get_or_create(prefix='P', defaults={'last_number': 1000})
            seq.last_number = 1000 + len(customers)
            seq.save(update_fields=['last_number'])

        self.stdout.write(self.style.SUCCESS(
            f"Renumbered {len(changes)} patient code(s). Next auto-generated code will be P-{1001 + len(customers)}."
        ))
