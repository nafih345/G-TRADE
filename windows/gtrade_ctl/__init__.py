"""gtrade-ctl: the engine behind the G-TRADE ERP Windows installer, services and updater.

Every installation step (data folders, PostgreSQL cluster, secrets, certificates, nginx,
Windows services, firewall, backups, updates, licence activation) lives here as an ordinary,
testable Python function. The NSIS installer, the desktop app and the admin only *call*
`gtrade-ctl <command>`; no business logic, SQL or service XML is generated anywhere else.

This package must only use the standard library at import time. Optional dependencies
(`cryptography`, Django) are imported inside the functions that need them, so that the
`--help`, `status` and `diagnostics` commands work even on a half-installed machine.
"""

__all__ = ['__version__', 'PRODUCT_NAME', 'PUBLISHER_PLACEHOLDER']

__version__ = '1.0.0'
PRODUCT_NAME = 'G-TRADE ERP'
# The legal publisher name is an owner decision (ARCHITECTURE_DECISION_REGISTER.md D8). It must
# match the code-signing certificate subject, so it is never guessed in code.
PUBLISHER_PLACEHOLDER = 'G-TRADE (publisher name pending - decision D8)'
