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

#include "backend/DriverPackage.h"

#include "common/Logger.h"

#include <QCryptographicHash>
#include <QDir>
#include <QFile>

namespace DriverPackage {

QString fileSha256(const QString& path)
{
    QFile f(path);
    if (!f.open(QIODevice::ReadOnly)) return QString();
    QCryptographicHash h(QCryptographicHash::Sha256);
    if (!h.addData(&f)) return QString();
    return QString::fromLatin1(h.result().toHex());
}

QString checkFiles(const QString& dir, const File* files, std::size_t count, QString* infPath,
                   QString* catPath)
{
    for (std::size_t i = 0; i < count; ++i) {
        const File& f = files[i];
        const QString path = dir + QLatin1Char('/') + QLatin1String(f.name);
        if (fileSha256(path) != QLatin1String(f.sha256))
            return QStringLiteral("%1 is missing or does not match its pinned hash")
                .arg(QLatin1String(f.name));
        if (path.endsWith(QLatin1String(".inf"), Qt::CaseInsensitive)) *infPath = path;
        if (path.endsWith(QLatin1String(".cat"), Qt::CaseInsensitive)) *catPath = path;
    }
    return QString();
}

#ifdef Q_OS_WIN

namespace {

QString lastErrorText(DWORD err = GetLastError())
{
    wchar_t* buf = nullptr;
    const DWORD n = FormatMessageW(FORMAT_MESSAGE_ALLOCATE_BUFFER | FORMAT_MESSAGE_FROM_SYSTEM |
                                       FORMAT_MESSAGE_IGNORE_INSERTS,
                                   nullptr, err, 0, reinterpret_cast<LPWSTR>(&buf), 0, nullptr);
    QString text = n ? QString::fromWCharArray(buf, int(n)).trimmed() : QString();
    if (buf) LocalFree(buf);
    return QStringLiteral("0x%1 %2").arg(err, 8, 16, QLatin1Char('0')).arg(text);
}

} // namespace

PublisherTrust::~PublisherTrust()
{
    const QString tag = QLatin1String(logTag);
    if (added) {
        // CertDeleteCertificateFromStore frees the context either way.
        if (!CertDeleteCertificateFromStore(added))
            Logger::warning(
                QStringLiteral("%1 could not untrust the publisher: %2").arg(tag, lastErrorText()));
        else
            Logger::info(QStringLiteral("%1 publisher untrusted again").arg(tag));
        added = nullptr;
    }
    if (store) CertCloseStore(store, 0);
}

bool trustCatalogSigner(const QString& catPath, const QString& thumbprintHex, const char* logTag,
                        PublisherTrust& trust, QString* error)
{
    trust.logTag = logTag;
    const QString tag = QLatin1String(logTag);
    const QByteArray wanted = QByteArray::fromHex(thumbprintHex.toLatin1());
    if (wanted.size() != 20) {
        *error = QStringLiteral("no publisher is pinned for this package");
        return false;
    }

    HCERTSTORE catStore = nullptr;
    HCRYPTMSG msg = nullptr;
    const std::wstring wpath = QDir::toNativeSeparators(catPath).toStdWString();
    if (!CryptQueryObject(CERT_QUERY_OBJECT_FILE, wpath.c_str(),
                          CERT_QUERY_CONTENT_FLAG_PKCS7_SIGNED | CERT_QUERY_CONTENT_FLAG_CERT,
                          CERT_QUERY_FORMAT_FLAG_ALL, 0, nullptr, nullptr, nullptr, &catStore, &msg,
                          nullptr)) {
        *error = QStringLiteral("cannot read the catalog's signature: %1").arg(lastErrorText());
        return false;
    }
    if (msg) CryptMsgClose(msg);

    PCCERT_CONTEXT match = nullptr;
    for (PCCERT_CONTEXT c = CertEnumCertificatesInStore(catStore, nullptr); c;
         c = CertEnumCertificatesInStore(catStore, c)) {
        BYTE hash[20];
        DWORD len = sizeof(hash);
        if (!CertGetCertificateContextProperty(c, CERT_SHA1_HASH_PROP_ID, hash, &len)) continue;
        if (QByteArray(reinterpret_cast<const char*>(hash), int(len)) == wanted) {
            match = CertDuplicateCertificateContext(c);
            CertFreeCertificateContext(c);
            break;
        }
    }
    CertCloseStore(catStore, 0);
    if (!match) {
        *error = QStringLiteral("the catalog is not signed by the pinned publisher");
        return false;
    }

    trust.store = CertOpenStore(CERT_STORE_PROV_SYSTEM_W, 0, 0,
                                CERT_SYSTEM_STORE_LOCAL_MACHINE | CERT_STORE_OPEN_EXISTING_FLAG,
                                L"TrustedPublisher");
    if (!trust.store)
        trust.store = CertOpenStore(CERT_STORE_PROV_SYSTEM_W, 0, 0, CERT_SYSTEM_STORE_LOCAL_MACHINE,
                                    L"TrustedPublisher");
    if (!trust.store) {
        CertFreeCertificateContext(match);
        *error =
            QStringLiteral("cannot open the Trusted Publishers store: %1").arg(lastErrorText());
        return false;
    }

    CRYPT_HASH_BLOB blob{DWORD(wanted.size()),
                         reinterpret_cast<BYTE*>(const_cast<char*>(wanted.constData()))};
    if (PCCERT_CONTEXT existing =
            CertFindCertificateInStore(trust.store, X509_ASN_ENCODING | PKCS_7_ASN_ENCODING, 0,
                                       CERT_FIND_SHA1_HASH, &blob, nullptr)) {
        // Already trusted on this machine (the driver's own installer does the
        // same thing, permanently): not ours to remove afterwards.
        CertFreeCertificateContext(existing);
        CertFreeCertificateContext(match);
        trust.preexisting = true;
        Logger::info(QStringLiteral("%1 publisher already trusted").arg(tag));
        return true;
    }
    const BOOL ok =
        CertAddCertificateContextToStore(trust.store, match, CERT_STORE_ADD_NEW, &trust.added);
    CertFreeCertificateContext(match);
    if (!ok) {
        *error = QStringLiteral("cannot trust the publisher: %1").arg(lastErrorText());
        return false;
    }
    Logger::info(QStringLiteral("%1 publisher trusted for this install").arg(tag));
    return true;
}

#endif

} // namespace DriverPackage
