/**
 * CodecAuto — « Auto », the first codec of the Settings menu and its default.
 *
 * Auto streams in HEVC, as « HEVC (recommended) » did before it, and in AV1
 * where HEVC cannot do the job: an HDR stream with the enhancer asked for,
 * from a host that encodes AV1 10-bit, in a browser that decodes it in
 * software (BrowserDetect.hdrLaunchCodec). The launch resolves it to one of
 * the two before asking the host: the host never sees « auto ». A codec
 * chosen in the menu is kept as chosen.
 *
 * A stored HEVC cannot say whether it was chosen or only left as the default,
 * so it becomes Auto once per browser (codecAfterAutoMigration). Auto is HEVC
 * but where HEVC fails: nothing is lost, and a HEVC picked afterwards stays.
 */

export const CODEC_AUTO = 'auto';

/** Set once this browser's stored codec has been through the move to Auto. */
const MIGRATED_KEY = 'mw_codec_auto';

/** localStorage, or null where reading it throws (sandboxed frame, privacy mode). */
function store() {
    try {
        return typeof localStorage !== 'undefined' ? localStorage : null;
    } catch (e) {
        return null;
    }
}

/**
 * The codec setting after the one move of a stored HEVC to Auto. A missing
 * codec is left missing, and leaves the move for the first one stored (the
 * server's default, on a first visit to the Settings page).
 * @param {string|undefined} codec the codec as stored
 * @param {Storage|null} [s] where the move is remembered
 * @returns {string|undefined}
 */
export function codecAfterAutoMigration(codec, s = store()) {
    if (typeof codec !== 'string' || !codec) return codec;
    try {
        if (!s || s.getItem(MIGRATED_KEY) === '1') return codec;
        s.setItem(MIGRATED_KEY, '1');
    } catch (e) {
        // Neither read nor kept: the codec as it is, asked again next time.
        return codec;
    }
    return codec === 'hevc' ? CODEC_AUTO : codec;
}

/**
 * The same move on the settings this browser stored (`mw-streaming-settings`),
 * written back when it changed them. Run once, at start-up, before anything
 * reads them.
 * @param {Storage|null} [s]
 */
export function migrateStoredCodecToAuto(s = store()) {
    if (!s) return;
    try {
        const raw = s.getItem('mw-streaming-settings');
        if (!raw) return;
        const settings = JSON.parse(raw);
        if (!settings || typeof settings !== 'object') return;
        const codec = codecAfterAutoMigration(settings.video_codec, s);
        if (codec !== settings.video_codec) {
            settings.video_codec = codec;
            s.setItem('mw-streaming-settings', JSON.stringify(settings));
            console.log('[MW] Codec: the HEVC stored here is Auto from now on');
        }
    } catch (e) {
        // Unreadable settings are the Settings page's to repair, not this.
    }
}
