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

#include "network/LinkAddresses.h"

#include "test_framework.h"

using LinkAddresses::Adapter;

namespace {

Adapter adapter(const char* name, const char* description, const char* ip, bool gateway,
                bool defaultRoute = false, quint32 metric = 25)
{
    Adapter a;
    a.name = QString::fromLatin1(name);
    a.description = QString::fromLatin1(description);
    a.ip = QString::fromLatin1(ip);
    a.hasGateway = gateway;
    a.isDefaultRoute = defaultRoute;
    a.metric = metric;
    return a;
}

// DualRTX on 24/10, in the order Windows listed its cards: Tailscale ahead of
// the house network, which is what put 100.x in a guest link.
QList<Adapter> dualRtx()
{
    return {
        adapter("Tailscale", "Tailscale Tunnel", "100.116.41.43", false, false, 5),
        adapter("vEthernet (LAN)", "Hyper-V Virtual Ethernet Adapter", "192.168.1.66", true, true),
        adapter("Ethernet 2", "VirtualBox Host-Only Ethernet Adapter", "192.168.56.1", false),
        adapter("vEthernet (WSL (Hyper-V firewall))", "Hyper-V Virtual Ethernet Adapter #2",
                "172.23.96.1", false),
        adapter("vEthernet (Default Switch)", "Hyper-V Virtual Ethernet Adapter #3", "172.29.128.1",
                false),
    };
}

void testLanThenTailscaleAndNoInternalSwitch()
{
    SECTION("link addresses: the house LAN first, Tailscale next, no switch internal to the PC");
    const QList<LinkAddresses::Choice> list = LinkAddresses::choices(dualRtx());
    CHECK_EQ(list.size(), 2);
    CHECK_EQ(list.value(0).id, QStringLiteral("lan"));
    CHECK_EQ(list.value(0).address, QStringLiteral("192.168.1.66"));
    CHECK(list.value(0).kind == LinkAddresses::Kind::Lan);
    CHECK_EQ(list.value(1).id, QStringLiteral("tailscale"));
    CHECK_EQ(list.value(1).address, QStringLiteral("100.116.41.43"));
    CHECK(list.value(1).kind == LinkAddresses::Kind::Tailscale);
}

void testHyperVExternalSwitchIsTheLan()
{
    SECTION("link addresses: Hyper-V's external switch has a gateway, so it is the LAN");
    // Same description as the Default Switch: only the gateway tells them apart.
    CHECK(!LinkAddresses::isHostInternal(
        adapter("vEthernet (LAN)", "Hyper-V Virtual Ethernet Adapter", "192.168.1.66", true)));
    CHECK(LinkAddresses::isHostInternal(adapter("vEthernet (Default Switch)",
                                                "Hyper-V Virtual Ethernet Adapter #3",
                                                "172.29.128.1", false)));
    CHECK(!LinkAddresses::isHostInternal(
        adapter("Tailscale", "Tailscale Tunnel", "100.116.41.43", false)));
}

void testLinuxAndMacBridgesAreInternal()
{
    SECTION("link addresses: docker, libvirt and macOS bridges stay off the menu");
    CHECK(LinkAddresses::isHostInternal(adapter("docker0", "", "172.17.0.1", false)));
    CHECK(LinkAddresses::isHostInternal(adapter("br-1a2b3c", "", "172.18.0.1", false)));
    CHECK(LinkAddresses::isHostInternal(adapter("virbr0", "", "192.168.122.1", false)));
    CHECK(LinkAddresses::isHostInternal(adapter("bridge100", "", "192.168.64.1", false)));
    CHECK(!LinkAddresses::isHostInternal(adapter("tailscale0", "", "100.64.0.7", false)));
    CHECK(!LinkAddresses::isHostInternal(adapter("wg0", "", "10.8.0.2", false)));
}

void testOtherNetworksAreOffered()
{
    SECTION("link addresses: a second card or another VPN is offered by its name");
    QList<Adapter> cards = dualRtx();
    cards.append(
        adapter("ZeroTier One [8056c2e21c]", "ZeroTier Virtual Port", "10.147.17.5", false));
    const QList<LinkAddresses::Choice> list = LinkAddresses::choices(cards);
    CHECK_EQ(list.size(), 3);
    CHECK_EQ(list.value(2).id, QStringLiteral("iface:ZeroTier One [8056c2e21c]"));
    CHECK(list.value(2).kind == LinkAddresses::Kind::Other);
    CHECK_EQ(list.value(2).address, QStringLiteral("10.147.17.5"));
}

void testTailscaleIsNeverTheLan()
{
    SECTION("link addresses: with no route out, the mesh VPN is still not the LAN");
    // A PC whose cable is out: no gateway anywhere, Tailscale with the best metric.
    const QList<LinkAddresses::Choice> list = LinkAddresses::choices({
        adapter("Tailscale", "Tailscale Tunnel", "100.116.41.43", false, false, 5),
        adapter("Wi-Fi", "Intel Wi-Fi 7", "192.168.1.70", false, false, 35),
    });
    CHECK_EQ(list.size(), 2);
    CHECK_EQ(list.value(0).id, QStringLiteral("lan"));
    CHECK_EQ(list.value(0).address, QStringLiteral("192.168.1.70"));
    CHECK_EQ(list.value(1).id, QStringLiteral("tailscale"));
}

void testUnusableAddressesAreDropped()
{
    SECTION("link addresses: loopback and link-local never make a link");
    const QList<LinkAddresses::Choice> list = LinkAddresses::choices({
        adapter("Loopback", "", "127.0.0.1", false),
        adapter("Ethernet", "Realtek", "169.254.10.2", false),
    });
    CHECK(list.isEmpty());
}

void testIdsAndLookup()
{
    SECTION("link addresses: the ids the board may store, and a pick that is gone");
    CHECK(LinkAddresses::isValidId(QStringLiteral("auto")));
    CHECK(LinkAddresses::isValidId(QStringLiteral("lan")));
    CHECK(LinkAddresses::isValidId(QStringLiteral("tailscale")));
    CHECK(LinkAddresses::isValidId(QStringLiteral("iface:wg0")));
    CHECK(!LinkAddresses::isValidId(QStringLiteral("iface:")));
    CHECK(!LinkAddresses::isValidId(QStringLiteral("192.168.1.66")));
    CHECK(!LinkAddresses::isValidId(QString()));
    CHECK(!LinkAddresses::isValidId(QStringLiteral("iface:") + QString(129, QLatin1Char('x'))));

    const QList<LinkAddresses::Choice> list = LinkAddresses::choices(dualRtx());
    CHECK(LinkAddresses::find(list, QStringLiteral("tailscale")).has_value());
    // Tailscale disconnected: the pick names nothing any more.
    QList<Adapter> cards = dualRtx();
    cards.removeFirst();
    CHECK(!LinkAddresses::find(LinkAddresses::choices(cards), QStringLiteral("tailscale")));
}

} // namespace

void run_link_addresses_tests()
{
    testLanThenTailscaleAndNoInternalSwitch();
    testHyperVExternalSwitchIsTheLan();
    testLinuxAndMacBridgesAreInternal();
    testOtherNetworksAreOffered();
    testTailscaleIsNeverTheLan();
    testUnusableAddressesAreDropped();
    testIdsAndLookup();
}
