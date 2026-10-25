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

#include "server/NetClassify.h"

#include <QList>
#include <QRegularExpression>
#include <QString>

#include <algorithm>
#include <optional>

/// The addresses a guest link can carry, as the sharing board offers them.
///
/// Automatic is the rendezvous link when this machine has a line out, its LAN
/// address otherwise. The owner can also pin a link to the LAN, to Tailscale or
/// to any other network this PC sits on: a guest of the house, a friend on the
/// owner's tailnet, with internet access left off.
///
/// What is never offered is a network that exists only inside this PC: the
/// switches Hyper-V, WSL, VirtualBox, VMware, Docker and libvirt create between
/// the machine and its own guests. No other device can reach them, so a link
/// carrying one fails for every guest.
///
/// The choice logic is pure, over a list of adapters read elsewhere
/// (readAdapters()), so it is tested without the machine's own cards.
namespace LinkAddresses {

/// One IPv4 address of one up adapter.
struct Adapter
{
    QString name;        ///< Friendly name ("Ethernet", "Tailscale", "eth0").
    QString description; ///< Windows' adapter description; empty elsewhere.
    QString ip;
    bool hasGateway = false;     ///< The adapter carries a default gateway.
    bool isDefaultRoute = false; ///< The source address the OS picks for the internet.
    quint32 metric = 0;          ///< Windows interface metric, lower first.
};

enum class Kind
{
    Lan,       ///< The house network: the address a guest of the LAN reaches.
    Tailscale, ///< A mesh VPN address (100.64.0.0/10).
    Other,     ///< Any other network a guest could reach (VPN, second card).
};

struct Choice
{
    QString id; ///< "lan", "tailscale" or "iface:<adapter name>".
    Kind kind = Kind::Other;
    QString address;
    QString adapter;
};

inline const char* kindName(Kind k)
{
    switch (k) {
    case Kind::Lan: return "lan";
    case Kind::Tailscale: return "tailscale";
    case Kind::Other: return "other";
    }
    return "other";
}

/// A network that lives inside this PC. Only an adapter without a gateway can
/// be one: Hyper-V's external switch ("vEthernet (LAN)" on DualRTX) has the
/// same description as its Default Switch, and the gateway is what tells the
/// real LAN apart. A mesh VPN has no gateway either, and matches no name here.
inline bool isHostInternal(const Adapter& a)
{
    if (a.hasGateway) return false;
    static const QRegularExpression kInternal(
        QStringLiteral("Hyper-V Virtual Ethernet|Default Switch|\\bWSL\\b|VirtualBox Host-Only|"
                       "VMware Virtual Ethernet|VMnet|^docker|^br-|^veth|^virbr|^vboxnet|^vmnet|"
                       "^lxcbr|^lxdbr|^podman|^cni|^bridge\\d"),
        QRegularExpression::CaseInsensitiveOption);
    return kInternal.match(a.name).hasMatch() || kInternal.match(a.description).hasMatch();
}

/// Usable as a link at all: an IPv4 another machine could aim at.
inline bool isUsable(const Adapter& a)
{
    const QHostAddress addr(a.ip);
    if (addr.isNull() || addr.protocol() != QAbstractSocket::IPv4Protocol) return false;
    return !addr.isLoopback() && !addr.isLinkLocal() && addr.toIPv4Address() != 0;
}

/// The choices besides Automatic, LAN first, then Tailscale, then the rest.
///
/// The LAN is ranked like UPNPClient::getLocalIPs(): the default-route address
/// first, then an adapter that has a gateway, then the interface metric — but
/// a mesh VPN is never the LAN, even on a machine with no route out.
inline QList<Choice> choices(QList<Adapter> adapters)
{
    adapters.erase(
        std::remove_if(adapters.begin(), adapters.end(),
                       [](const Adapter& a) { return !isUsable(a) || isHostInternal(a); }),
        adapters.end());
    std::stable_sort(adapters.begin(), adapters.end(), [](const Adapter& a, const Adapter& b) {
        if (a.isDefaultRoute != b.isDefaultRoute) return a.isDefaultRoute;
        if (a.hasGateway != b.hasGateway) return a.hasGateway;
        return a.metric < b.metric;
    });

    QList<Choice> out;
    QList<Choice> others;
    bool haveLan = false;
    bool haveTailscale = false;
    for (const Adapter& a : adapters) {
        const bool tunnel = NetClassify::classify(a.ip) == NetClassify::Kind::Tunnel;
        if (tunnel && !haveTailscale) {
            haveTailscale = true;
            out.append({QStringLiteral("tailscale"), Kind::Tailscale, a.ip, a.name});
        } else if (!tunnel && !haveLan) {
            haveLan = true;
            out.prepend({QStringLiteral("lan"), Kind::Lan, a.ip, a.name});
        } else {
            const QString id = QStringLiteral("iface:") + a.name;
            const bool seen = std::any_of(others.begin(), others.end(),
                                          [&id](const Choice& c) { return c.id == id; });
            if (!seen) others.append({id, Kind::Other, a.ip, a.name});
        }
    }
    out.append(others);
    return out;
}

/// The choice @p id names among @p list, if it is still there.
inline std::optional<Choice> find(const QList<Choice>& list, const QString& id)
{
    for (const Choice& c : list)
        if (c.id == id) return c;
    return std::nullopt;
}

/// A choice id the board may store: Automatic or one of the forms above.
inline bool isValidId(const QString& id)
{
    if (id == QLatin1String("auto") || id == QLatin1String("lan") ||
        id == QLatin1String("tailscale"))
        return true;
    return id.startsWith(QLatin1String("iface:")) && id.size() > 6 && id.size() <= 6 + 128;
}

/// This machine's up adapters with an IPv4, as the OS lists them.
QList<Adapter> readAdapters();

} // namespace LinkAddresses
