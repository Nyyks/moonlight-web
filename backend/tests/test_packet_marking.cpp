/*
 * MoonlightWeb — TNR suite. Copyright (C) 2026 Bruno Martin.
 * GPLv3 — see repository LICENSE.
 *
 * The DSCP the stream's packets leave with (streaming/PacketMarking.h): AF41
 * everywhere by default, nothing when the setting says so, and the bench's
 * MW_DSCP only when it is three values that fit in six bits.
 */
#include "../src/streaming/PacketMarking.h"

#include "test_framework.h"

void run_packet_marking_tests()
{
    using PacketMarking::resolve;
    using V = std::array<unsigned int, 3>;

    SECTION("PacketMarking — AF41 for sound, video and data by default; 0 when off");
    {
        CHECK(resolve(true, "") == V({34, 34, 34}));
        CHECK(resolve(false, "") == V({0, 0, 0}));
    }

    SECTION("PacketMarking — MW_DSCP overrides the setting, both ways");
    {
        CHECK(resolve(true, "46,34,34") == V({46, 34, 34}));
        CHECK(resolve(false, "46,34,34") == V({46, 34, 34}));
        CHECK(resolve(true, "0,0,0") == V({0, 0, 0}));
        CHECK(resolve(true, "63,0,10") == V({63, 0, 10}));
    }

    SECTION("PacketMarking — a malformed MW_DSCP is no override");
    {
        for (const char* bad : {"46", "46,34", "46,34,34,10", "64,34,34", "46,,34", "a,b,c",
                                "-1,34,34", "46,34,34,", " 46,34,34", "100,34,34"})
            CHECK(resolve(true, bad) == V({34, 34, 34}));
    }
}
