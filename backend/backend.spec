# -*- mode: python ; coding: utf-8 -*-

import os
import sys
from pathlib import Path
from PyInstaller.utils.hooks import collect_submodules, collect_data_files

block_cipher = None

# Collect submodules for Django apps and packages
hidden_imports = [
    'config.settings',
    'config.urls',
    'config.wsgi',
    'config.asgi',
    'django.contrib.admin',
    'django.contrib.auth',
    'django.contrib.contenttypes',
    'django.contrib.sessions',
    'django.contrib.messages',
    'django.contrib.staticfiles',
    'rest_framework',
    'rest_framework_simplejwt',
    'corsheaders',
    'psycopg2',
    'pandas',
    'openpyxl',
    'PIL',
    'waitress',
    'apps.common',
    'apps.authentication',
    'apps.company',
    'apps.masters',
    'apps.products',
    'apps.inventory',
    'apps.purchasing',
    'apps.sales',
    'apps.accounts',
    'apps.financial',
]

hidden_imports += collect_submodules('django.contrib')
hidden_imports += collect_submodules('rest_framework')

datas = collect_data_files('django')
datas += collect_data_files('rest_framework')

a = Analysis(
    ['launcher.py'],
    pathex=['.'],
    binaries=[],
    datas=datas,
    hiddenimports=hidden_imports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[],
    win_no_prefer_redirects=False,
    win_private_assemblies=False,
    cipher=block_cipher,
    noarchive=False,
)

pyz = PYZ(a.pure, a.zipped_data, cipher=block_cipher)

exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.zipfiles,
    a.datas,
    [],
    name='backend',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    upx_exclude=[],
    runtime_tmpdir=None,
    console=True,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)
