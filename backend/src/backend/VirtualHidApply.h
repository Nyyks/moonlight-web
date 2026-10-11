/*
 * MoonlightWeb — browser-based Sunshine/GameStream client.
 * Copyright (C) 2026 Bruno Martin <brunoocto@gmail.com>
 *
 * This program is free software: you can redistribute it and/or modify it
 * under the terms of the GNU General Public License as published by the Free
 * Software Foundation, either version 3 of the License, or (at your option)
 * any later version.
 *
 * This program is distributed in the hope that it will be useful, but WITHOUT
 * ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS
 * FOR A PARTICULAR PURPOSE. See the GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License along with
 * this program. If not, see <https://www.gnu.org/licenses/>.
 */

#pragma once

#include "backend/DriverPackage.h"

#include <QString>

#include <vector>

/**
 * @brief The `--vhid-apply` mode: the installer's elevated half of
 * "MoonlightWeb Virtual HID", the Windows driver the HID passthrough recreates
 * wheels and radios with (backend/native-host/drivers/vhid, WinUHid's UMDF2
 * driver over the inbox Virtual HID Framework).
 *
 *   install    re-hash the bundled package ({app}\drivers\vhid) against the
 *              constants below, trust the catalog's signer for the duration
 *              (our own certificate: Root and Trusted Publishers, out of both
 *              again before it returns), create the root-enumerated System
 *              node Root\MoonlightWebVHid if there is none, and install the
 *              package on it — on every run, so an update brings a newer
 *              driver. The node stays enabled: it only offers
 *              \\.\MoonlightWebVHid, and nothing appears to a game until a
 *              stream attaches a device.
 *   uninstall  forget this edition; when it had installed the driver and no
 *              other MoonlightWeb edition is left using it, remove the node
 *              and the package. A driver put there by hand (install.ps1, on
 *              a bench machine in test mode) belongs to no edition and stays.
 *
 * Nothing to do is not a failure: a build that pins no package, or an
 * installer that bundled none (Windows on ARM: the driver is x64 only), exits
 * 0 with "skipped". The engine's probe then reports the passthrough
 * unavailable, as on any machine without the driver.
 *
 * Prints one JSON line on stdout. Exit 0 done or skipped, 1 failed, 3010 done
 * but Windows wants a reboot.
 */
namespace VirtualHidApply {

/// The hardware id the INF binds to: ours alone (never WinUHid's own).
inline QString hardwareId()
{
    return QStringLiteral("Root\\MoonlightWebVHid");
}

/// The node's name in Device Manager.
inline QString deviceName()
{
    return QStringLiteral("MoonlightWeb Virtual HID");
}

/// The package under backend/installer/drivers/vhid, as build.ps1 -Sign Own
/// made it on 11/10/2026, pinned file by file: any other bytes, and the
/// install refuses. A new driver means a new package there and new pins here,
/// both printed by build.ps1. A test-signed package is never bundled.
inline const std::vector<DriverPackage::File>& driverFiles()
{
    static const std::vector<DriverPackage::File> files = {
        {"MoonlightWebVHid.inf",
         "661adf513a7e4addda9b1959a9168015261b8f420f53ac6d88391971a1317ee2"},
        {"MoonlightWebVHid.cat",
         "3f71b2998180cfa00db894d0d8afc95e0e40ac245c12d692660af5e4a263bf25"},
        {"MoonlightWebVHid.dll",
         "7cb4e8b6221648315685163898e26e95d2a6d8e048e96b2c26093bde201fde85"},
    };
    return files;
}

/// SHA-1 thumbprint of the certificate that signs the catalog, the only
/// publisher the install ever trusts: MoonlightWeb's own, self-signed
/// ("MoonlightWeb Virtual HID", code signing only, not a CA). Its private key
/// stays on the release maintainer's machine, outside the repository.
inline QString catalogSignerThumbprint()
{
    return QStringLiteral("1dd1af0ceb20f734dcfef39267de14ec3bffbc8d");
}

/// {app}\drivers\vhid: derived from the exe's own location, never from a
/// request.
QString bundledDriverDir();

/// @param action "install" | "uninstall"
/// @param dir    the package's directory; empty = bundledDriverDir()
/// @return process exit code: 0 ok or skipped, 1 failed, 3010 ok but reboot required
int run(const QString& action, const QString& dir);

} // namespace VirtualHidApply
