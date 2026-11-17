# VM Setup Report: G-TRADE Windows 11 Test VM

Last updated: 2026-11-12 (post-RAM-install check)
Overall status: **Blocked. The second RAM module was reported as installed but is NOT detected by the laptop's firmware. The VM has not been created.**

Nothing has been installed, downloaded, or changed in Windows or the BIOS.

## 1. RAM upgrade verification (2026-11-12, after the last boot at 18:17)

| Check | Expected | Result | Status |
|---|---|---|---|
| Total RAM | ~16 GB (~15.2 GB visible) | **7.21 GB visible** (8 GB installed) | ❌ FAIL |
| Slot 1 (left), Channel A | 8 GB DDR5-4800 | Samsung M425R1GB4BB0-CQKOL, 8 GB | ✅ OK |
| Slot 2 (right), Channel B | 8 GB DDR5-4800 | **Empty.** Size 0, part "Unknown" in SMBIOS | ❌ FAIL |
| Speed | 4800 MT/s | 4800 MT/s (slot 1 only), single-channel | ⚠️ single-channel |
| Voltage | 1.1 V | 1.1 V | ✅ OK |
| Hardware memory errors (WHEA) | none | **None** since 2026-11-11 | ✅ OK |
| Windows Memory Diagnostic results | — | Never run | — |

**Interpretation:** the slot is read straight from the firmware's own memory map, which is built at power-on before Windows starts. Slot 2 reading empty there means the system did not detect a module at boot. Windows has no setting that could hide it. Likely causes, most likely first:
1. **Module not fully seated.** DDR5 SO-DIMMs go in at about 30° and must be pushed in until almost none of the gold contacts show, then pressed flat until both side clips snap.
2. **Wrong module type.** It must be **DDR5 SO-DIMM (262-pin)**. A DDR4 SO-DIMM (260-pin) looks very similar but its notch is in a different place and it won't seat properly.
3. **Faulty module or slot.** Rare. Test by swapping (see section 8).

### Other observations from the event log (not caused by the RAM)
- **Three unexpected shutdowns today** (09:50, 14:14, 18:13). The 18:13 one was just before the boot at 18:17. The laptop may have been powered off by holding the power button rather than with *Shut down*. The other two happened earlier in the day, so this predates the RAM work. No hardware errors (WHEA) were logged, so it isn't a memory fault. Possible causes: an aggressive sleep/hibernate setting, battery drain, or forced power-offs.
- **BitLocker is active on C:**, unlocked by the TPM at each boot. Hardware changes can occasionally trigger a BitLocker recovery screen. **Before you open the laptop again, have your recovery key ready**: aka.ms/myrecoverykey, signed in with the Microsoft account used on this PC.
- A Windows Secure Boot certificate update reports an SBAT error (0x800700c1). This is a known Windows Update item and isn't related to the RAM. No action is needed for the VM.

## 2. Host PC specifications

| Item | Value |
|---|---|
| Model | HP Victus 15-fb1xxx (SKU 8L9N8EA#ABV, board 8C30, BIOS F.08) |
| OS | Windows 11 Home 64-bit, build 26200 |
| CPU | AMD Ryzen 5 7535HS, 6 cores / 12 threads, AMD-V enabled |
| RAM (verified now) | **8 GB** (1 × Samsung DDR5-4800 SO-DIMM). Target 16 GB |
| RAM slots | 2 total, max 32 GB; slot 2 currently **not detected** |
| Disk C: | 376 GB, 24 GB free (not used for the VM) |
| Disk D: | 95 GB, 89 GB free (VM + ISO go here) |
| Hypervisor | Hyper-V platform / VBS running (WSL, Memory Integrity). VMware will run on the Windows Hypervisor Platform. No change needed |

## 3. VMware installation status
- **Not installed.**
- Official source: the Broadcom Support Portal (support.broadcom.com) → My Downloads → VMware Workstation Pro. Needs a free Broadcom account (manual step).

## 4. Recommended final VMware configuration

Use the column that matches the RAM Windows actually reports when the VM is built.

| Setting | **16 GB host (target)** | 8 GB host (fallback only) |
|---|---|---|
| VM name | G-TRADE-WINDOWS-11-TEST | same |
| Guest OS type | Windows 11 x64 | same |
| Memory | **6 GB (6144 MB)**, leaving ~9 GB for the host | 4 GB, with all other host apps closed |
| Processors | **4 vCPU** (1 processor × 4 cores); host keeps 8 threads | 4 vCPU |
| Virtualize IOMMU / VT-x passthrough | Off (not available under Hyper-V; not needed) | Off |
| Firmware | **UEFI, Secure Boot on** | same |
| TPM | **Virtual TPM 2.0** (VMware encrypts the VM's configuration for this, using an auto-generated key stored in Windows Credential Manager. Choose "only the files needed to support a TPM", not full encryption, so the VM stays fast) | same |
| Disk | **80 GB NVMe, thin-provisioned** (grows as used), split into multiple files | same |
| Disk location | `D:\VMs\G-TRADE-WINDOWS-11-TEST\` (outside `D:\G OPTICALS`) | same |
| Network | **NAT** | same |
| Display | 3D acceleration on, 1 GB graphics memory | 3D off |
| USB | USB 3.1 controller; no devices auto-connected | same |
| Shared folders | **Off by default.** Enable one read-only share only when copying `G-TRADE-Setup-1.0.0.exe` in | same |
| Sound / printer | Remove printer; keep sound | same |
| Snapshots | `BEFORE_GTRADE_INSTALLATION` after Windows + Tools + updates | same |

Why 6 GB and not 8 GB on a 16 GB host: about 15.2 GB is visible to Windows (part is reserved for the integrated graphics), and VS Code, the browser and the dev servers routinely use 5–7 GB. An 8 GB VM would push the host back into paging. 6 GB is plenty for Windows 11 plus the G-TRADE installer and app.

## 5. Windows 11 ISO
- Not downloaded. Source: microsoft.com/software-download/windows11 → "Download Windows 11 Disk Image (ISO) for x64 devices" (~7 GB) → save to `D:\ISO\`. SHA-256 to be checked against Microsoft's published hash list.

## 6. Windows activation status
- Not started. The host's OEM licence doesn't transfer to a VM. The VM will run **unactivated** (fine for installer testing) unless a separate retail key is bought. No unauthorized activators or keys will be used.

## 7. Snapshot and network status
- Snapshot `BEFORE_GTRADE_INSTALLATION`: not created (no VM yet).
- Network: NAT planned. The VM won't be pointed at Neon, Render, Vercel, or any production database.

## 8. Remaining steps

### A. Fix RAM detection (you, physical)
1. Have the **BitLocker recovery key** ready (aka.ms/myrecoverykey).
2. **Start → Power → Shut down.** Don't use Restart or Sleep, and don't hold the power button. Unplug the charger.
3. Open the bottom cover according to HP's instructions for the Victus 15-fb1xxx. If the HP service guide for your model says to disconnect the internal battery first, do so.
4. Check the new stick's label: it must say **DDR5** and **SO-DIMM**, 4800 (or faster), 8 GB.
5. Reseat it in **slot 2 (right)**: insert at ~30°, push firmly until the contacts are almost hidden, then press down until both clips click.
6. Close up, plug in the charger, power on. **The first boot may show a black screen for 1–3 minutes** while the system trains the new memory. Don't power off during this.
7. Tell me, and I'll re-run the same read-only checks.
8. If slot 2 still reads empty: try the new stick **alone in slot 1**. If it's detected there, the slot is suspect; if not, the stick is faulty, so return it.

### B. Can be done now, in parallel
- Download VMware Workstation Pro from the Broadcom portal into `D:\Downloads\VMware\` and the Windows 11 ISO into `D:\ISO\`. Tell me the file names and I'll check the signature and checksums.

### C. After RAM verifies at ~16 GB (each step with your approval)
- Install VMware → create the VM with the configuration in section 4 → install Windows → VMware Tools → updates → Device Manager, network and admin checks → snapshot `BEFORE_GTRADE_INSTALLATION` → stage `G-TRADE-Setup-1.0.0.exe` in `C:\GTRADE-Test\` (not installed).
