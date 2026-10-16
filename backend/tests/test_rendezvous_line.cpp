/*
 * MoonlightWeb — TNR suite. Copyright (C) 2026 Bruno Martin. GPLv3.
 *
 * The rendezvous line: an error on a line that is still open brings it down at
 * once, and the line is back within the first retry.
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
#include <QMetaObject>
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

} // namespace

void run_rendezvous_line_tests()
{
    SECTION("RendezvousClient — an error on an open line rebuilds it at once");

    QTemporaryDir tmp;
    AppSettings::setFileOverride(tmp.filePath(QStringLiteral("settings.json")));

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

    const QByteArray savedUrl = qgetenv("MW_RENDEZVOUS_URL");
    qputenv("MW_RENDEZVOUS_URL",
            QStringLiteral("http://127.0.0.1:%1").arg(server.serverPort()).toUtf8());

    {
        AppSettings settings;
        settings.setRendezvousId(RendezvousId::generate());
        settings.setRendezvousToken(QString(64, QLatin1Char('a')));
        settings.setRendezvousClaimed(true);

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

    if (savedUrl.isEmpty())
        qunsetenv("MW_RENDEZVOUS_URL");
    else
        qputenv("MW_RENDEZVOUS_URL", savedUrl);
    AppSettings::setFileOverride(QString());
}
