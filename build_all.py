import os
import sys
import shutil
import subprocess
from pathlib import Path

ROOT_DIR = Path(__file__).resolve().parent

def run_command(cmd, cwd=None, shell=True, retries=3):
    print(f"\n==================================================")
    print(f"Running: {cmd}")
    print(f"Directory: {cwd or ROOT_DIR}")
    print(f"==================================================")
    env = os.environ.copy()
    env["NODE_OPTIONS"] = "--max-old-space-size=4096"
    env["ELECTRON_BUILDER_BINARIES_MIRROR"] = "https://npmmirror.com/mirrors/electron-builder-binaries/"
    env["ELECTRON_MIRROR"] = "https://npmmirror.com/mirrors/electron/"

    for attempt in range(1, retries + 1):
        result = subprocess.run(cmd, cwd=cwd or ROOT_DIR, shell=shell, env=env)
        if result.returncode == 0:
            return
        print(f"\n[Attempt {attempt}/{retries}] Command returned exit code {result.returncode}.")
        if attempt < retries:
            print("Retrying command in 3 seconds...")
            import time
            time.sleep(3)

    print(f"ERROR: Command failed after {retries} attempts.")
    sys.exit(result.returncode)

def main():
    print("==================================================")
    print("   OPTICAL ERP MASTER PRODUCTION BUILD PIPELINE   ")
    print("==================================================")

    # 1. Build React Frontend
    frontend_dir = ROOT_DIR / "frontend"
    print("\n[Step 1/5] Building React Frontend Production Bundle...")
    run_command("npm run build", cwd=frontend_dir)

    # 2. Django Static Collection & Backend Freeze
    backend_dir = ROOT_DIR / "backend"
    print("\n[Step 2/5] Collecting Django Static Files...")
    
    # Prefer active Python environment running build_all.py or backend venv
    python_executable = sys.executable
    venv_python = backend_dir / "venv" / "Scripts" / "python.exe"
    if venv_python.exists():
        chk = subprocess.run([str(venv_python), "-c", "import PyInstaller"], capture_output=True)
        if chk.returncode == 0:
            python_executable = str(venv_python)

    # Auto-install PyInstaller & Waitress if missing
    chk = subprocess.run([python_executable, "-c", "import PyInstaller, waitress"], capture_output=True)
    if chk.returncode != 0:
        print(f"\nInstalling missing packaging dependencies (PyInstaller, Waitress) into Python environment...")
        subprocess.run([python_executable, "-m", "pip", "install", "pyinstaller", "waitress"], check=True)

    python_cmd = f'"{python_executable}"'
    
    run_command(f"{python_cmd} manage.py collectstatic --noinput", cwd=backend_dir)

    print("\n[Step 3/5] Freezing Django Backend into backend.exe using PyInstaller...")
    pyinstaller_cmd = f"{python_cmd} -m PyInstaller --noconfirm backend.spec"
    run_command(pyinstaller_cmd, cwd=backend_dir)

    # Copy backend.exe to backend_dist/ for installer packaging
    backend_dist_dir = ROOT_DIR / "backend_dist"
    backend_dist_dir.mkdir(exist_ok=True)
    built_backend_exe = backend_dir / "dist" / "backend.exe"
    if built_backend_exe.exists():
        shutil.copy(built_backend_exe, backend_dist_dir / "backend.exe")
        print(f"Copied backend.exe -> {backend_dist_dir / 'backend.exe'}")
    else:
        print("Warning: backend.exe built path not found at expected location.")

    # 3. Build Electron App
    print("\n[Step 4/5] Packaging Electron Desktop Application (ERP.exe)...")
    run_command("npx electron-builder --win dir", cwd=ROOT_DIR)

    # Copy backend.exe into win-unpacked directory
    win_unpacked_dir = ROOT_DIR / "dist" / "win-unpacked"
    if win_unpacked_dir.exists() and (backend_dist_dir / "backend.exe").exists():
        shutil.copy(backend_dist_dir / "backend.exe", win_unpacked_dir / "backend.exe")
        (win_unpacked_dir / "resources" / "backend").mkdir(parents=True, exist_ok=True)
        shutil.copy(backend_dist_dir / "backend.exe", win_unpacked_dir / "resources" / "backend" / "backend.exe")
        print(f"Bundled backend.exe into {win_unpacked_dir}")

    # 4. Compile Inno Setup Installer
    print("\n[Step 5/5] Compiling Inno Setup Windows Installer (OpticalERP_Setup.exe)...")
    iscc_paths = [
        r"C:\Program Files (x86)\Inno Setup 6\ISCC.exe",
        r"C:\Program Files\Inno Setup 6\ISCC.exe",
        r"C:\Program Files (x86)\Inno Setup 7\ISCC.exe",
        r"C:\Program Files\Inno Setup 7\ISCC.exe",
        "ISCC.exe"
    ]
    
    iscc_exe = None
    for path in iscc_paths:
        if shutil.which(path) or os.path.exists(path):
            iscc_exe = path
            break

    if iscc_exe:
        run_command(f'"{iscc_exe}" installer.iss', cwd=ROOT_DIR)
        print("\n==================================================")
        print("  BUILD SUCCESSFUL!")
        print("  Installer Generated at: dist/installer/OpticalERP_Setup.exe")
        print("==================================================")
    else:
        print("\nNotice: Inno Setup (ISCC.exe) was not found in standard paths.")
        print("Electron App generated at: dist/win-unpacked/ERP.exe")
        print("Backend Executable generated at: backend_dist/backend.exe")
        print("To generate OpticalERP_Setup.exe, install Inno Setup 6 and run:")
        print("ISCC.exe installer.iss")

if __name__ == "__main__":
    main()
