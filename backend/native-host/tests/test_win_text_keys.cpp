/*
 * MoonlightWeb — native capture & encoding engine, test suite.
 * Copyright (C) 2026 Bruno Martin <brunoocto@gmail.com>. GPLv3.
 */
#include "native_test_framework.h"

#if defined(_WIN32)
#include "input/windows/WinTextKeys.h"

#include <windows.h>
#endif

#include <cstdio>
#include <string>
#include <vector>

#if defined(_WIN32)
using namespace mw::native::input;
#endif

// Text as the keys of the host's layout (WinTextKeys.h).
//
// A phone sends characters, and the classic console ignores a character
// injected as itself: Odin typed nothing into an administrator PowerShell
// (22/10/2026). So each character goes as the keys a person at the host would
// press for it, on the host's own layout: é is the 2 key on a French AZERTY,
// ê is the dead ^ then e, @ is AltGr+à. The layouts below are the ones the
// plan names: the French AZERTY (legacy), the French AFNOR, US, German, and US
// International — each one is either already loaded in this session or loaded
// for the test only, never activated, and unloaded when the test is done. The
// layout the person at this PC types with is never touched.

#if defined(_WIN32)
namespace {

constexpr uint8_t kVkOem1 = 0xBA;
constexpr uint8_t kVkOemPlus = 0xBB;
constexpr uint8_t kVkOem3 = 0xC0;
constexpr uint8_t kVkOem4 = 0xDB;
constexpr uint8_t kVkOem5 = 0xDC;
constexpr uint8_t kVkOem6 = 0xDD;
constexpr uint8_t kVkOem7 = 0xDE;
constexpr uint8_t kAltGr = 6;

std::vector<HKL> loadedLayouts()
{
    const int n = ::GetKeyboardLayoutList(0, nullptr);
    std::vector<HKL> list(static_cast<size_t>(n > 0 ? n : 0));
    if (n > 0) ::GetKeyboardLayoutList(n, list.data());
    return list;
}

/// A layout for the length of a test: the session's own when it is loaded,
/// else loaded here — KLF_NOTELLSHELL, never KLF_ACTIVATE — and unloaded by
/// the destructor. Null when Windows has no such layout.
class TestLayout
{
public:
    explicit TestLayout(const wchar_t* klid)
    {
        const std::vector<HKL> before = loadedLayouts();
        m_Hkl = ::LoadKeyboardLayoutW(klid, KLF_NOTELLSHELL);
        if (!m_Hkl) return;
        m_Loaded = true;
        for (HKL h : before)
            if (h == m_Hkl) m_Loaded = false;
    }
    ~TestLayout()
    {
        if (m_Loaded) ::UnloadKeyboardLayout(m_Hkl);
    }
    TestLayout(const TestLayout&) = delete;
    TestLayout& operator=(const TestLayout&) = delete;

    HKL hkl() const { return m_Hkl; }
    bool loadedHere() const { return m_Loaded; }

private:
    HKL m_Hkl = nullptr;
    bool m_Loaded = false;
};

bool isKey(const WinRecipe& r, uint8_t vk, uint8_t mods)
{
    return r.kind == WinRecipe::Kind::Key && r.key.vk == vk && r.key.mods == mods;
}

bool isDead(const WinRecipe& r, uint8_t deadVk, uint8_t deadMods, uint8_t baseVk, uint8_t baseMods)
{
    return r.kind == WinRecipe::Kind::DeadKey && r.key.vk == deadVk && r.key.mods == deadMods &&
           r.base.vk == baseVk && r.base.mods == baseMods;
}

/// What a plan types, read back key by key through the layout: the modifiers
/// it presses, each key's character at that level, a dead key composed with
/// the next by the layout's own table. Unicode events type their unit. Where
/// a dead key meets a key it does not compose with, both characters come out,
/// as Windows does it.
std::u32string typeOut(const WinKeyLayout& layout, const std::vector<WinKeyEvent>& plan,
                       bool capsLock, WinHeldMods held)
{
    std::u32string out;
    bool shift = held.shift, ctrl = held.ctrl, alt = held.alt;
    wchar_t pending = 0;
    uint16_t highSurrogate = 0;
    for (const WinKeyEvent& e : plan) {
        if (e.kind == WinKeyEvent::Kind::Unicode) {
            if (e.up) continue;
            if (e.unit >= 0xD800 && e.unit < 0xDC00) {
                highSurrogate = e.unit;
            } else if (e.unit >= 0xDC00 && e.unit < 0xE000 && highSurrogate) {
                out += static_cast<char32_t>(0x10000 + ((highSurrogate - 0xD800) << 10) +
                                             (e.unit - 0xDC00));
                highSurrogate = 0;
            } else {
                out += static_cast<char32_t>(e.unit);
            }
            continue;
        }
        if (e.vk == VK_SHIFT) {
            shift = !e.up;
            continue;
        }
        if (e.vk == VK_CONTROL) {
            ctrl = !e.up;
            continue;
        }
        if (e.vk == VK_MENU) {
            alt = !e.up;
            continue;
        }
        if (e.up) continue;
        if (e.vk == VK_RETURN) {
            out += U'\n';
            continue;
        }
        if (e.vk == VK_TAB) {
            out += U'\t';
            continue;
        }
        WinStroke s;
        s.vk = e.vk;
        s.scan = e.scan;
        s.mods = static_cast<uint8_t>((shift ? 1 : 0) | (ctrl ? 2 : 0) | (alt ? 4 : 0));
        wchar_t c = 0;
        const int n = layout.typed(s, capsLock, c);
        if (n == -1) {
            if (pending) out += static_cast<char32_t>(pending);
            pending = c;
            continue;
        }
        if (n != 1) continue;
        if (pending) {
            const wchar_t composed = layout.composed(pending, c);
            if (composed) {
                out += static_cast<char32_t>(composed);
            } else {
                out += static_cast<char32_t>(pending);
                out += static_cast<char32_t>(c);
            }
            pending = 0;
            continue;
        }
        out += static_cast<char32_t>(c);
    }
    if (pending) out += static_cast<char32_t>(pending);
    return out;
}

/// No key left down and no modifier left pressed: every down has its up, and
/// the plan ends on what the viewer holds.
bool balanced(const std::vector<WinKeyEvent>& plan, WinHeldMods held)
{
    int down[256] = {};
    int mods[3] = {held.shift ? 1 : 0, held.ctrl ? 1 : 0, held.alt ? 1 : 0};
    for (const WinKeyEvent& e : plan) {
        if (e.kind != WinKeyEvent::Kind::Key) continue;
        const int delta = e.up ? -1 : 1;
        if (e.vk == VK_SHIFT)
            mods[0] += delta;
        else if (e.vk == VK_CONTROL)
            mods[1] += delta;
        else if (e.vk == VK_MENU)
            mods[2] += delta;
        else
            down[e.vk] += delta;
        if (down[e.vk] < 0 || down[e.vk] > 1) return false;
    }
    for (int d : down)
        if (d != 0) return false;
    return mods[0] == (held.shift ? 1 : 0) && mods[1] == (held.ctrl ? 1 : 0) &&
           mods[2] == (held.alt ? 1 : 0);
}

/// Every character the table says it can type, typed and read back: what the
/// table promises and what the plan does must be the same thing.
void roundTripTable(const WinKeyLayout& layout, const char* name)
{
    int checked = 0, wrong = 0;
    for (int caps = 0; caps < 2; ++caps) {
        for (char32_t ch = 0x20; ch < 0x3000; ++ch) {
            const WinRecipe r = layout.recipe(ch, caps != 0);
            if (r.kind == WinRecipe::Kind::Unicode) continue;
            std::vector<WinKeyEvent> plan;
            planText(layout, std::u32string(1, ch), caps != 0, WinHeldMods{}, plan);
            ++checked;
            if (typeOut(layout, plan, caps != 0, WinHeldMods{}) != std::u32string(1, ch) ||
                !balanced(plan, WinHeldMods{})) {
                if (++wrong <= 5)
                    std::fprintf(stderr, "  [%s] U+%04X caps %d does not type back\n", name,
                                 static_cast<unsigned>(ch), caps);
            }
        }
    }
    std::fprintf(stderr, "  %s: %d character(s) typed back through the plan\n", name, checked);
    CHECK(checked > 60);
    CHECK_EQ(wrong, 0);
}

void frenchLegacy(const WinKeyLayout& fr)
{
    // Letters are keys of their own, at their AZERTY positions: the a key is
    // where a QWERTY board has Q, and that position is what games read.
    WinRecipe a = fr.recipe(U'a', false);
    CHECK(isKey(a, 'A', 0));
    CHECK_EQ(a.key.scan, static_cast<uint8_t>(0x10));
    CHECK_EQ(fr.recipe(U'q', false).key.scan, static_cast<uint8_t>(0x1E));
    CHECK_EQ(fr.recipe(U'z', false).key.scan, static_cast<uint8_t>(0x11));
    CHECK_EQ(fr.recipe(U'w', false).key.scan, static_cast<uint8_t>(0x2C));
    CHECK(isKey(fr.recipe(U'A', false), 'A', 1));

    // The digit row: the digits are shifted, the accented letters are not.
    CHECK(isKey(fr.recipe(U'1', false), '1', 1));
    CHECK(isKey(fr.recipe(U'&', false), '1', 0));
    CHECK(isKey(fr.recipe(U'\u00E9', false), '2', 0)); // é
    CHECK(isKey(fr.recipe(U'\u00E8', false), '7', 0)); // è
    CHECK(isKey(fr.recipe(U'\u00E7', false), '9', 0)); // ç
    CHECK(isKey(fr.recipe(U'\u00E0', false), '0', 0)); // à

    // AltGr: Ctrl+Alt to Windows.
    CHECK(isKey(fr.recipe(U'@', false), '0', kAltGr));
    CHECK(isKey(fr.recipe(U'\u20AC', false), 'E', kAltGr)); // €
    CHECK(isKey(fr.recipe(U'#', false), '3', kAltGr));
    CHECK(isKey(fr.recipe(U'{', false), '4', kAltGr));
    CHECK(isKey(fr.recipe(U'}', false), kVkOemPlus, kAltGr));

    // Through a dead key: ^ then e, ¨ then e, and the AltGr tilde.
    CHECK(fr.composes());
    CHECK(isDead(fr.recipe(U'\u00EA', false), kVkOem6, 0, 'E', 0));  // ê
    CHECK(isDead(fr.recipe(U'\u00EB', false), kVkOem6, 1, 'E', 0));  // ë
    CHECK(isDead(fr.recipe(U'\u00FC', false), kVkOem6, 1, 'U', 0));  // \u00FC
    CHECK(isDead(fr.recipe(U'\u00F1', false), '2', kAltGr, 'N', 0)); // ñ
    // A lone tilde: the dead key, then the space bar (C.6). Sent as the 2 key
    // it typed é, then the tilde with the next key (12/10/2026).
    CHECK(isDead(fr.recipe(U'~', false), '2', kAltGr, VK_SPACE, 0));
    CHECK_EQ(fr.composed(U'^', U'e'), static_cast<wchar_t>(0x00EA));
    CHECK_EQ(fr.composed(U'~', U' '), static_cast<wchar_t>(U'~'));

    // É has no key on the legacy AZERTY, and no dead acute leads to it.
    CHECK(fr.recipe(U'\u00C9', false).kind == WinRecipe::Kind::Unicode);

    // Caps Lock: the letters' case turns over, and the é key types 2 —
    // é then needs Shift, which cancels Caps Lock on that key.
    CHECK(isKey(fr.recipe(U'a', true), 'A', 1));
    CHECK(isKey(fr.recipe(U'A', true), 'A', 0));
    CHECK(isKey(fr.recipe(U'\u00E9', true), '2', 1));
    CHECK(isKey(fr.recipe(U'2', true), '2', 0));

    // What no key types: an emoji, kept as Unicode.
    CHECK(fr.recipe(U'\U0001F600', false).kind == WinRecipe::Kind::Unicode);

    // Chords: the key carrying the letter, at no level. Ctrl+z is the key Z
    // of AZERTY (where QWERTY has W), not the US position of Z — which on
    // this layout is W, and closed the tab (22/10/2026).
    WinStroke key;
    CHECK(fr.chordKey(U'z', key));
    CHECK_EQ(key.vk, static_cast<uint8_t>('Z'));
    CHECK_EQ(key.scan, static_cast<uint8_t>(0x11));
    CHECK_EQ(key.mods, static_cast<uint8_t>(0));
    CHECK(fr.chordKey(U'Z', key) && key.vk == 'Z' && key.mods == 0);
    CHECK(fr.chordKey(U'a', key) && key.scan == 0x10);
    CHECK(fr.chordKey(U'q', key) && key.scan == 0x1E);
    CHECK(fr.chordKey(U'w', key) && key.scan == 0x2C);
    // A digit chord keeps its key and no Shift: Ctrl+1 is Ctrl+VK_1.
    CHECK(fr.chordKey(U'1', key) && key.vk == '1' && key.mods == 0);

    // Plans.
    {
        // ê: the dead key and e, nothing held, nothing left down.
        std::vector<WinKeyEvent> plan;
        const WinTextCounts c = planText(fr, U"\u00EA", false, WinHeldMods{}, plan);
        CHECK_EQ(c.deadKeys, 1);
        CHECK_EQ(c.keys, 0);
        CHECK_EQ(plan.size(), static_cast<size_t>(4));
        CHECK(plan.size() == 4 && plan[0].vk == kVkOem6 && !plan[0].up && plan[1].up &&
              plan[2].vk == 'E' && plan[3].up);
    }
    {
        // @: Ctrl and Alt around the à key, released after it.
        std::vector<WinKeyEvent> plan;
        planText(fr, U"@", false, WinHeldMods{}, plan);
        CHECK_EQ(plan.size(), static_cast<size_t>(6));
        CHECK(plan.size() == 6 && plan[0].vk == VK_CONTROL && plan[0].scan == 0x1D &&
              plan[1].vk == VK_MENU && plan[1].scan == 0x38 && plan[2].vk == '0' &&
              plan[2].scan == 0x0B && plan[4].vk == VK_MENU && plan[4].up &&
              plan[5].vk == VK_CONTROL && plan[5].up);
    }
    {
        // "aA": Shift only around the capital.
        std::vector<WinKeyEvent> plan;
        planText(fr, U"aA", false, WinHeldMods{}, plan);
        CHECK_EQ(plan.size(), static_cast<size_t>(6));
        CHECK(plan.size() == 6 && plan[0].vk == 'A' && plan[2].vk == VK_SHIFT && !plan[2].up &&
              plan[3].vk == 'A' && plan[5].vk == VK_SHIFT && plan[5].up);
    }
    {
        // The toolbar's Shift held, then "!" — on AZERTY its own key, at no
        // level: Shift is let go for it and put back, so ! does not become §.
        WinHeldMods shift;
        shift.shift = true;
        std::vector<WinKeyEvent> plan;
        planText(fr, U"!", false, shift, plan);
        CHECK(plan.size() == 4 && plan.front().vk == VK_SHIFT && plan.front().up &&
              plan.back().vk == VK_SHIFT && !plan.back().up);
        CHECK(typeOut(fr, plan, false, shift) == U"!");
        CHECK(balanced(plan, shift));
    }
    {
        // A Ctrl held alone is a chord the viewer asked for: kept, untouched.
        WinHeldMods ctrl;
        ctrl.ctrl = true;
        std::vector<WinKeyEvent> plan;
        planText(fr, U"a", false, ctrl, plan);
        CHECK(plan.size() == 2 && plan[0].vk == 'A' && plan[1].vk == 'A');
    }
    {
        // An AltGr held (Ctrl and Alt together) is a level like Shift: let go
        // for a character that does not need it.
        WinHeldMods altGr;
        altGr.ctrl = altGr.alt = true;
        std::vector<WinKeyEvent> plan;
        planText(fr, U"a", false, altGr, plan);
        CHECK(typeOut(fr, plan, false, altGr) == U"a");
        CHECK(balanced(plan, altGr));
    }
    {
        // A sentence with everything in it, typed back exactly; the emoji as
        // Unicode, two units; line breaks and Tab as their keys; a control
        // character dropped rather than typed as the Ctrl chord making it.
        const std::u32string text =
            U"Le ch\u00E2teau \u00EAtre, l'\u00EEle & no\u00EBl ~ 100 \u20AC @x {}\t\U0001F600\r\n"
            U"\u0003fin";
        std::vector<WinKeyEvent> plan;
        const WinTextCounts c = planText(fr, text, false, WinHeldMods{}, plan);
        CHECK_EQ(c.unicode, 1);
        CHECK_EQ(c.dropped, 1);
        CHECK(c.deadKeys >= 5);
        CHECK(typeOut(fr, plan, false, WinHeldMods{}) ==
              U"Le ch\u00E2teau \u00EAtre, l'\u00EEle & no\u00EBl ~ 100 \u20AC @x {}\t\U0001F600"
              U"\nfin");
        CHECK(balanced(plan, WinHeldMods{}));
        // And with Caps Lock on, the same text.
        plan.clear();
        planText(fr, text, true, WinHeldMods{}, plan);
        CHECK(typeOut(fr, plan, true, WinHeldMods{}) ==
              U"Le ch\u00E2teau \u00EAtre, l'\u00EEle & no\u00EBl ~ 100 \u20AC @x {}\t\U0001F600"
              U"\nfin");
    }
    roundTripTable(fr, "French (legacy)");
}

void frenchAfnor(const WinKeyLayout& afnor)
{
    // The AFNOR AZERTY (KBDFRNA.DLL) has É on the é key itself: Shift+AltGr,
    // or AltGr alone under Caps Lock — where its plain level types 2.
    CHECK(isKey(afnor.recipe(U'\u00E9', false), '2', 0));
    CHECK(isKey(afnor.recipe(U'\u00C9', false), '2', 7));
    CHECK(isKey(afnor.recipe(U'\u00C9', true), '2', kAltGr));
    CHECK(isKey(afnor.recipe(U'2', true), '2', 0));
    roundTripTable(afnor, "French (AFNOR)");
}

void frenchApple(const WinKeyLayout& apple)
{
    // The French layout for Apple keyboards, loaded on DualRTX (0xF0C0040C,
    // taken for the AFNOR by the probe of 22/10). VkKeyScanExW names the é key
    // for É, with no modifier — which types é: on this layout É takes Caps
    // Lock, and that is not something VkKeyScanEx can say. The reason the
    // table is read back key by key instead.
    const SHORT scan = ::VkKeyScanExW(L'\u00C9', reinterpret_cast<HKL>(apple.hkl()));
    if (scan != -1 && (scan & 0xFF) == '2' && ((scan >> 8) & 0xFF) == 0) {
        WinStroke stroke;
        stroke.vk = '2';
        stroke.scan = 0x03;
        wchar_t got = 0;
        CHECK_EQ(apple.typed(stroke, false, got), 1);
        CHECK_EQ(got, static_cast<wchar_t>(0x00E9));
        std::fprintf(stderr, "  Apple: VkKeyScanExW names VK_2 for E acute, which types e acute\n");
    }
    // Whatever the table chose for É without Caps Lock, never that é key.
    CHECK(!isKey(apple.recipe(U'\u00C9', false), '2', 0));
    // Caps Lock on: the é key types É.
    CHECK(isKey(apple.recipe(U'\u00C9', true), '2', 0));
    roundTripTable(apple, "French (Apple)");
}

void unitedStates(const WinKeyLayout& us)
{
    CHECK(isKey(us.recipe(U'a', false), 'A', 0));
    CHECK_EQ(us.recipe(U'a', false).key.scan, static_cast<uint8_t>(0x1E));
    CHECK(isKey(us.recipe(U'@', false), '2', 1));
    CHECK(isKey(us.recipe(U'~', false), kVkOem3, 1));
    CHECK(isKey(us.recipe(U'"', false), kVkOem7, 1));
    // No key, no dead key for é on US: Unicode, as before.
    CHECK(us.recipe(U'\u00E9', false).kind == WinRecipe::Kind::Unicode);
    WinStroke key;
    CHECK(us.chordKey(U'z', key) && key.vk == 'Z' && key.scan == 0x2C);
    roundTripTable(us, "US");
}

void german(const WinKeyLayout& de)
{
    // QWERTZ: Z and Y swap places.
    CHECK(isKey(de.recipe(U'z', false), 'Z', 0));
    CHECK_EQ(de.recipe(U'z', false).key.scan, static_cast<uint8_t>(0x15));
    CHECK_EQ(de.recipe(U'y', false).key.scan, static_cast<uint8_t>(0x2C));
    CHECK(isKey(de.recipe(U'\u00E4', false), kVkOem7, 0)); // ä
    CHECK(isKey(de.recipe(U'\u00F6', false), kVkOem3, 0)); // ö
    CHECK(isKey(de.recipe(U'\u00FC', false), kVkOem1, 0)); // ü
    CHECK(isKey(de.recipe(U'\u00DF', false), kVkOem4, 0)); // ß
    CHECK(isKey(de.recipe(U'@', false), 'Q', kAltGr));
    CHECK(isKey(de.recipe(U'\u20AC', false), 'E', kAltGr));
    CHECK(isKey(de.recipe(U'{', false), '7', kAltGr));
    // é and è are the dead acute and grave, ê the dead circumflex.
    CHECK(isDead(de.recipe(U'\u00E9', false), kVkOem6, 0, 'E', 0));
    CHECK(isDead(de.recipe(U'\u00E8', false), kVkOem6, 1, 'E', 0));
    CHECK(isDead(de.recipe(U'\u00EA', false), kVkOem5, 0, 'E', 0));
    roundTripTable(de, "German");
}

void unitedStatesInternational(const WinKeyLayout& usx)
{
    // AltGr letters are keys: é is AltGr+e, ñ AltGr+n.
    CHECK(isKey(usx.recipe(U'\u00E9', false), 'E', kAltGr));
    CHECK(isKey(usx.recipe(U'\u00F1', false), 'N', kAltGr));
    // The quote and the apostrophe are dead keys here: a plain one is the dead
    // key then the space bar — what typing a command needs most.
    CHECK(isDead(usx.recipe(U'"', false), kVkOem7, 1, VK_SPACE, 0));
    CHECK(isDead(usx.recipe(U'\'', false), kVkOem7, 0, VK_SPACE, 0));
    CHECK(isDead(usx.recipe(U'\u00EA', false), '6', 1, 'E', 0)); // ê
    std::vector<WinKeyEvent> plan;
    planText(usx, U"echo \"l'\u00E9t\u00E9\"", false, WinHeldMods{}, plan);
    CHECK(typeOut(usx, plan, false, WinHeldMods{}) == U"echo \"l'\u00E9t\u00E9\"");
    roundTripTable(usx, "US International");
}

void withLayout(const wchar_t* klid, const char* name, void (*test)(const WinKeyLayout&))
{
    TestLayout loaded(klid);
    if (!loaded.hkl()) {
        std::fprintf(stderr, "  skipped %s: Windows has no such layout here\n", name);
        return;
    }
    const WinKeyLayout layout(reinterpret_cast<uintptr_t>(loaded.hkl()));
    WinStroke space;
    if (!layout.chordKey(U' ', space)) {
        std::fprintf(stderr, "  skipped %s: the layout types nothing here (no desktop?)\n", name);
        return;
    }
    std::fprintf(stderr, "  %s: HKL 0x%08X%s, %zu character(s), compositions %s\n", name,
                 static_cast<unsigned>(reinterpret_cast<uintptr_t>(loaded.hkl()) & 0xFFFFFFFFu),
                 loaded.loadedHere() ? " (loaded for the test)" : "", layout.size(false),
                 layout.composes() ? "read" : layout.why().c_str());
    test(layout);
}

} // namespace
#endif

void run_win_text_keys_tests()
{
    SECTION("Windows text as keys — the host's own layout, read back");

#if !defined(_WIN32)
    std::fprintf(stderr, "  skipped: Windows only\n");
#else
    const std::vector<HKL> before = loadedLayouts();
    const HWND window = ::GetForegroundWindow();
    const HKL foreground = ::GetKeyboardLayout(::GetWindowThreadProcessId(window, nullptr));

    withLayout(L"0000040C", "French (legacy)", frenchLegacy);
    withLayout(L"0001040C", "French (AFNOR)", frenchAfnor);
    withLayout(L"A000040C", "French (Apple)", frenchApple);
    withLayout(L"00000409", "US", unitedStates);
    withLayout(L"00000407", "German", german);
    withLayout(L"00020409", "US International", unitedStatesInternational);

    {
        // Unicode only: an input method open, or no layout to read.
        std::vector<WinKeyEvent> plan;
        const WinTextCounts c = planUnicode(U"a\U0001F600\u0003", plan);
        CHECK_EQ(c.unicode, 2);
        CHECK_EQ(c.dropped, 1);
        CHECK_EQ(plan.size(), static_cast<size_t>(6));
        CHECK(plan.size() == 6 && plan[2].unit == 0xD83D && plan[4].unit == 0xDE00);
    }

    // Nothing was left behind: the session's layouts are the ones it had, and
    // the window in front still types with its own.
    const std::vector<HKL> after = loadedLayouts();
    CHECK(after == before);
    if (::GetForegroundWindow() == window)
        CHECK(::GetKeyboardLayout(::GetWindowThreadProcessId(window, nullptr)) == foreground);
#endif
}
