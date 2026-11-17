"""G-TRADE vendor licensing service (separate deployable; NOT part of the ERP app or its database).

Issues Ed25519-signed licences, records activations and check-ins, publishes a signed revocation
list. The signing key is provided by a KeyProvider: a local file key in development only, a KMS/HSM
key in production (decision D4). The private key never reaches a customer installation.
"""

__version__ = '1.0.0'
