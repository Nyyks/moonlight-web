/*
 * MoonlightWeb — TNR suite. Copyright (C) 2026 Bruno Martin. GPLv3.
 *
 * The rendezvous line, against a local stand-in for the introduction server:
 * an error on a line that is still open brings it down at once; a name is
 * raced and the line opens on the address that answered, the name kept for the
 * server; an attempt that never comes up is cut at the open timeout, counts
 * toward the re-claim, and the next one leads with the other address family.
 *
 * Behind production's Caddy, a restart of the introduction server reaches the
 * host as a TLS close_notify on a TCP connection that stays open. Qt reports it
 * through errorOccurred and then never emits disconnected, so the line looked
 * up until the next ping and its missing pong — up to 65 s, 31 s and 63 s on
 * the staging bench of 16/10/2026. That half-close cannot be staged on a local
 * socket (a plain FIN is a disconnect to Qt), so the test hands the client the
 * same error on a line that is genuinely still open, which is exactly the state
 * the bench left it in.
 */
#include "test_framework.h"

#include "../src/common/RendezvousId.h"
#include "../src/network/RendezvousClient.h"
#include "../src/server/AppSettings.h"

#include <QAbstractSocket>
#include <QCoreApplication>
#include <QElapsedTimer>
#include <QHostAddress>
#include <QHostInfo>
#include <QMetaObject>
#include <QTcpServer>
#include <QTcpSocket>
#include <QTemporaryDir>
#include <QWebSocket>
#include <QWebSocketServer>

namespace {

template <class F> bool waitFor(F done, int ms)
{
    QElapsedTimer t;
    t.start();
    while (!done()) {
        if (t.elapsed() > ms) return false;
        QCoreApplication::processEvents(QEventLoop::AllEvents, 5);
    }
    return true;
}

/// A claimed identity in a settings file of its own.
void claimedIdentity(AppSettings& settings)
{
    settings.setRendezvousId(RendezvousId::generate());
    settings.setRendezvousToken(QString(64, QLatin1Char('a')));
    settings.setRendezvousClaimed(true);
}

/// A server that takes every connection and never says a word: what a stalled
/// path looks like once TCP has gone through.
struct MuteServer
{
    QTcpServer server;
    int accepted = 0;

    bool listen(const QHostAddress& address, quint16 port = 0)
    {
        QObject::connect(&server, &QTcpServer::newConnection, [this]() {
            while (QTcpSocket* s = server.nextPendingConnection()) {
                ++accepted;
                s->setParent(&server);
            }
        });
        return server.listen(address, port);
    }
};

} // namespace

void run_rendezvous_line_tests()
{
    const QByteArray savedUrl = qgetenv("MW_RENDEZVOUS_URL");
    QTemporaryDir tmp;
    AppSettings::setFileOverride(tmp.filePath(QStringLiteral("settings.json")));

    SECTION("RendezvousClient — an error on an open line rebuilds it at once");
    {
        // A stand-in for the introduction server: it takes the line and holds it.
        QWebSocketServer server(QStringLiteral("rdv-test"), QWebSocketServer::NonSecureMode);
        CHECK(server.listen(QHostAddress::LocalHost, 0));
        int lines = 0;
        int dropped = 0;
        QObject::connect(&server, &QWebSocketServer::newConnection, [&]() {
            while (QWebSocket* ws = server.nextPendingConnection()) {
                ++lines;
                ws->setParent(&server);
                QObject::connect(ws, &QWebSocket::disconnected, [&]() { ++dropped; });
            }
        });

        // A URL that names an address: no lookup, no race, the line opens on it.
        qputenv("MW_RENDEZVOUS_URL",
                QStringLiteral("http://127.0.0.1:%1").arg(server.serverPort()).toUtf8());

        AppSettings settings;
        claimedIdentity(settings);

        RendezvousClient client(&settings);
        client.start();
        CHECK(waitFor([&]() { return client.isOnline() && lines == 1; }, 3000));

        // What Qt does on the half-close: the error, and nothing after it. The
        // socket underneath is still connected.
        const bool invoked = QMetaObject::invokeMethod(
            &client, "onSocketError", Qt::DirectConnection,
            Q_ARG(QAbstractSocket::SocketError, QAbstractSocket::RemoteHostClosedError));
        CHECK(invoked);

        // Down at once, not at the next ping (45 s) plus the pong wait (20 s).
        CHECK(waitFor([&]() { return !client.isOnline() && dropped == 1; }, 1000));

        // Back within the first retry, 1 to 2 s with its jitter: the bench
        // target is under 3 s from the moment the server is there again.
        CHECK(waitFor([&]() { return client.isOnline() && lines == 2; }, 3000));

        client.stop();
        waitFor([&]() { return dropped == 2; }, 1000);
    }

    SECTION("RendezvousClient — a name is raced, and the line opens on the address that answered");
    {
        // "localhost" is the one name every machine resolves without a network,
        // to ::1 and 127.0.0.1 on most. The stand-in listens on both, and keeps
        // the Host it was asked for.
        QWebSocketServer server(QStringLiteral("rdv-test"), QWebSocketServer::NonSecureMode);
        CHECK(server.listen(QHostAddress::Any, 0));
        int lines = 0;
        QByteArray hostHeader;
        QHostAddress peer;
        QObject::connect(&server, &QWebSocketServer::newConnection, [&]() {
            while (QWebSocket* ws = server.nextPendingConnection()) {
                ++lines;
                hostHeader = ws->request().rawHeader("Host");
                peer = ws->peerAddress();
                ws->setParent(&server);
            }
        });

        const QString authority = QStringLiteral("localhost:%1").arg(server.serverPort());
        qputenv("MW_RENDEZVOUS_URL", (QStringLiteral("http://") + authority).toUtf8());

        AppSettings settings;
        claimedIdentity(settings);

        RendezvousClient client(&settings);
        QElapsedTimer opening;
        opening.start();
        client.start();
        CHECK(waitFor([&]() { return client.isOnline() && lines == 1; }, 5000));
        // Lookup, race and open on loopback: well under the stagger.
        CHECK(opening.elapsed() < 2000);
        // The line was opened on an address, and the server still saw the name.
        CHECK(peer.isLoopback());
        CHECK_EQ(QString::fromLatin1(hostHeader), authority);

        client.stop();
        waitFor([&]() { return !client.isOnline(); }, 1000);
    }

    SECTION("RendezvousClient — an attempt that never comes up is cut at the open timeout, "
            "and counts toward the re-claim");
    {
        MuteServer mute;
        CHECK(mute.listen(QHostAddress::LocalHost));
        qputenv("MW_RENDEZVOUS_URL",
                QStringLiteral("http://127.0.0.1:%1").arg(mute.server.serverPort()).toUtf8());

        AppSettings settings;
        claimedIdentity(settings);

        RendezvousClient client(&settings);
        int cameUp = 0;
        QObject::connect(&client, &RendezvousClient::onlineChanged, [&](bool online) {
            if (online) ++cameUp;
        });
        client.setOpenTimeoutMs(300);
        client.start();
        CHECK(waitFor([&]() { return mute.accepted == 1; }, 2000));

        // Nothing bounded this before: the upgrade would have waited forever.
        // Now the attempt is cut and a second one follows within the first
        // retry, 1 to 2 s.
        CHECK(waitFor([&]() { return mute.accepted == 2; }, 4000));
        CHECK(settings.rendezvousClaimed());

        // Two attempts that never came up: the claim is no longer trusted...
        CHECK(waitFor([&]() { return !settings.rendezvousClaimed(); }, 3000));
        // ...and the re-claim itself goes out, the third connection, bounded
        // too: the mute server would otherwise hold it forever.
        CHECK(waitFor([&]() { return mute.accepted == 3; }, 10000));
        CHECK_EQ(cameUp, 0);

        client.stop();
    }

    SECTION("RendezvousClient — after a timeout, the next attempt leads with the other family");
    {
        // Needs "localhost" in both families, and the same port free on both.
        // Where it is not, the rule is still covered by test_address_race's
        // interleave() with a lead; this section is then skipped, and says so.
        bool has4 = false;
        bool has6 = false;
        const QHostInfo lo = QHostInfo::fromName(QStringLiteral("localhost"));
        for (const QHostAddress& a : lo.addresses()) {
            has4 = has4 || a.protocol() == QAbstractSocket::IPv4Protocol;
            has6 = has6 || a.protocol() == QAbstractSocket::IPv6Protocol;
        }
        MuteServer mute4;
        MuteServer mute6;
        const bool staged = has4 && has6 && mute4.listen(QHostAddress::LocalHost) &&
                            mute6.listen(QHostAddress::LocalHostIPv6, mute4.server.serverPort());
        if (!staged) {
            std::fprintf(stderr, "  (skipped: localhost is not dual-stack here)\n");
        } else {
            qputenv("MW_RENDEZVOUS_URL",
                    QStringLiteral("http://localhost:%1").arg(mute4.server.serverPort()).toUtf8());

            AppSettings settings;
            claimedIdentity(settings);

            RendezvousClient client(&settings);
            client.setOpenTimeoutMs(300);
            client.start();

            // Attempt 1: the resolver's first family wins the race at once (it
            // is loopback), the line opens on it and stalls. That side sees two
            // connections, the probe and the line; the other side none, the
            // stagger never having elapsed.
            CHECK(waitFor([&]() { return mute4.accepted + mute6.accepted == 2; }, 2000));
            const bool firstWas6 = mute6.accepted == 2;
            CHECK(firstWas6 ? mute4.accepted == 0 : mute6.accepted == 0);

            // Attempt 2, after the timeout and the retry: the other family
            // leads, and wins just as fast. Two connections on its side...
            MuteServer& other = firstWas6 ? mute4 : mute6;
            MuteServer& first = firstWas6 ? mute6 : mute4;
            CHECK(waitFor([&]() { return other.accepted == 2; }, 4000));
            // ...and none more on the first.
            CHECK_EQ(first.accepted, 2);

            client.stop();
        }
    }

    if (savedUrl.isEmpty())
        qunsetenv("MW_RENDEZVOUS_URL");
    else
        qputenv("MW_RENDEZVOUS_URL", savedUrl);
    AppSettings::setFileOverride(QString());
}
