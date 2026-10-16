/*
 * MoonlightWeb — native capture & encoding engine.
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

#include "native_test_framework.h"

#include "platform/windows/DisplayModeHold.h"

#include <cctype>
#include <string>

using namespace mw::native::platform::modehold;

// Which session a display's "Match my screen" mode belongs to
// (DisplayModeHold.h). The N95 bench of 16/10/2026 is the case: a client
// relaunched, its new session found the display in its mode already, and the
// old session's end put the display's own mode back under the new stream.

namespace {

const std::string kOwnerVddPath =
    "\\\\?\\DISPLAY#MTT1337#1&15ecd195&0&UID256#{e6f07b5f-ee97-4a90-b076-33f57bf4eaa7}";

} // namespace

void run_display_mode_hold_tests()
{
    SECTION("Display mode hold — one name per display, any case, no backslash past Local\\");
    {
        const std::string name = objectName(kOwnerVddPath);
        const std::string prefix = "Local\\MoonlightWeb-ModeHold-";
        CHECK_EQ(name.compare(0, prefix.size(), prefix), 0);
        CHECK_EQ(name.size(), prefix.size() + 16);
        CHECK_EQ(name.find('\\', prefix.size()), std::string::npos);
        std::string upper = kOwnerVddPath;
        for (char& c : upper)
            c = static_cast<char>(std::toupper(static_cast<unsigned char>(c)));
        CHECK_EQ(objectName(upper), name);
        CHECK(objectName("\\\\.\\DISPLAY1") != name);
        CHECK(objectName("\\\\.\\DISPLAY1") != objectName("\\\\.\\DISPLAY2"));
    }

    SECTION("Display mode hold — a relaunch: the new session takes the mode over");
    {
        uint64_t slot = 0;
        // The old session (pid 100) puts the display in the client's mode.
        CHECK(!heldByAnother(slot, 0));
        const uint64_t old = claimed(slot, 100);
        slot = old;
        CHECK(holds(slot, old));
        CHECK_EQ(pidOf(slot), 100u);
        // The new one (pid 200) finds that mode, held by another: it sets it
        // again and claims it.
        CHECK(heldByAnother(slot, 0));
        const uint64_t next = claimed(slot, 200);
        slot = next;
        CHECK(holds(slot, next));
        // The old session's end: no longer the holder, it leaves the mode,
        // and its letting go changes nothing.
        CHECK(!holds(slot, old));
        CHECK_EQ(released(slot, old), slot);
        // The new session's end: the holder, it puts the display's own mode
        // back and lets go.
        CHECK_EQ(released(slot, next), 0u);
    }

    SECTION("Display mode hold — two sessions of one process are told apart");
    {
        const uint64_t first = claimed(0, 300);
        const uint64_t second = claimed(first, 300);
        CHECK(first != second);
        CHECK(!holds(second, first));
        CHECK(heldByAnother(first, 0));
        CHECK(!heldByAnother(first, first));
        // The generation wraps without ever making the word "nobody".
        CHECK(claimed(word(300, 0xffffffffu), 300) != 0u);
    }

    SECTION("Display mode hold — nobody holds, or no claim made: nothing to keep");
    {
        CHECK(!holds(0, 0));
        CHECK(!heldByAnother(0, 0));
        CHECK_EQ(released(0, 0), 0u);
        CHECK_EQ(released(claimed(0, 7), 0), claimed(0, 7));
    }
}
