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
 *              constants below, trust the catalog's signer for the duration,
 *              create the root-enumerated System node Root\MoonlightWebVHid if
 *              there is none, and install the package on it — on every run,
 *              so an update brings a newer driver. The node stays enabled: it
 *              only offers \\.\MoonlightWebVHid, and nothing appears to a
 *              game until a stream attaches a device.
 *   uninstall  forget this edition; when it had installed the driver and no
 *              other MoonlightWeb edition is left using it, remove the node
 *              and the package. A driver put there by hand (install.ps1, on
 *              a bench machine in test mode) belongs to no edition and stays.
 *
 * Nothing to do is not a failure: a build that pins no package (until the
 * product signature exists), or an installer that bundled none, exits 0 with
 * "skipped". The engine's probe then reports the passthrough unavailable, as
 * on any machine without the driver.
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

/// The package as build.ps1 -Sign Product makes it, pinned file by file.
/// EMPTY until the product signature exists: a test-signed package installs
/// nowhere but on a machine in test mode, and is never bundled. Filling this
/// in is the whole of "the installer sets the driver up": the three files of
/// the signed package (MoonlightWebVHid.inf, .cat, .dll) with their SHA-256,
/// and catalogSignerThumbprint() below.
inline const std::vector<DriverPackage::File>& driverFiles()
{
    static const std::vector<DriverPackage::File> files;
    return files;
}

/// SHA-1 thumbprint of the certificate that signs the product catalog, the
/// only publisher the install ever trusts. Empty until it exists.
inline QString catalogSignerThumbprint()
{
    return QString();
}

/// {app}\drivers\vhid: derived from the exe's own location, never from a
/// request.
QString bundledDriverDir();

/// @param action "install" | "uninstall"
/// @param dir    the package's directory; empty = bundledDriverDir()
/// @return process exit code: 0 ok or skipped, 1 failed, 3010 ok but reboot required
int run(const QString& action, const QString& dir);

} // namespace VirtualHidApply
